import type { Readable } from "stream";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { getDb } from "./db";
import { orderItems, orders, products, reviewPhotos, reviewReports, reviewVotes, reviews, shops, users } from "../drizzle/schema";
import { deleteStoredFile, mediaUrl, storeUpload } from "./mediaStorage";
import { getShopForUser } from "./vendorCatalog";
import {
  ANONYMOUS_AUTHOR, MAX_PENDING_REVIEW_PHOTOS, PENDING_REVIEW_PHOTO_TTL_MS, REVIEW_PAGE_SIZE, REVIEW_PHOTO_LIMITS,
  authorDisplayNameOf, isCustomLine, purchasedVariantOf, reviewSubmissionSchema,
  type ReviewFilter, type ReviewSort, type ReviewSubmission,
} from "@shared/reviewRules";
import { splitCity } from "@shared/tunisia";

/**
 * Avis clients avec photos (A-10c). Règles de confiance appliquées ICI (jamais dans le navigateur) :
 * - un avis seulement pour une ligne de commande livrée, par le client de cette commande, une fois par ligne ;
 * - variante achetée, nom affiché et gouvernorat copiés côté serveur au moment de l'envoi ;
 * - jusqu'à 3 photos, envoyées avec la même validation que les photos produits ;
 * - moyennes et répartition calculées par le serveur sur les avis PUBLIÉS uniquement ;
 * - le vendeur répond une seule fois, à ses propres avis, sans pouvoir modifier ni supprimer l'avis.
 * Les procédures existantes (reviews.submit, reviews.list, admin.updateReviewStatus…) ne changent pas.
 */

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  return db;
}

const fail = (code: "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT", message: string) => new TRPCError({ code, message });
const num = (value: unknown) => Number(value ?? 0);

/** Ligne « livrée » : marquée livrée par le vendeur OU commande entière livrée, et jamais annulée */
const deliveredLine = sql`(${orderItems.fulfillmentStatus} = 'delivered' OR ${orders.status} = 'delivered') AND ${orderItems.fulfillmentStatus} <> 'cancelled' AND ${orders.status} <> 'cancelled'`;
/** Déjà évaluée : avis sur cette ligne, ou ancien avis (sans ligne) sur ce produit de cette commande */
const alreadyReviewed = sql`EXISTS (SELECT 1 FROM reviews r WHERE r.orderItemId = ${orderItems.id}
  OR (r.orderItemId IS NULL AND r.userId = ${orders.userId} AND r.orderId = ${orderItems.orderId} AND r.productSlug = ${orderItems.productSlug}))`;

// ===========================================================
// Client : lignes à évaluer et envoi d'un avis
// ===========================================================

/** Lignes livrées du client pas encore évaluées, avec l'aperçu du nom public (« Sarra D. · Sousse ») */
export async function listReviewableLines(userId: number) {
  const db = await requireDb();
  const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  const rows = await db.select({
    orderItemId: orderItems.id, orderId: orderItems.orderId, orderDate: orders.createdAt,
    productSlug: orderItems.productSlug, productName: orderItems.productName, shopName: orderItems.shopName,
    image: products.imageUrl, shippingName: orders.shippingName, shippingCity: orders.shippingCity,
    pricingMode: orderItems.pricingMode, widthCm: orderItems.widthCm, heightCm: orderItems.heightCm, selectedColor: orderItems.selectedColor,
    neonText: orderItems.neonText, neonColorName: orderItems.neonColorName, neonSize: orderItems.neonSize,
  }).from(orderItems).innerJoin(orders, eq(orderItems.orderId, orders.id)).leftJoin(products, eq(orderItems.productId, products.id))
    .where(and(eq(orders.userId, userId), deliveredLine, sql`NOT ${alreadyReviewed}`))
    .orderBy(desc(orders.createdAt), asc(orderItems.id)).limit(50);
  return rows.map((r) => ({
    orderItemId: r.orderItemId, orderId: r.orderId, orderDate: r.orderDate, productSlug: r.productSlug, productName: r.productName,
    shopName: r.shopName, image: r.image || null, purchasedVariant: purchasedVariantOf(r),
    // Ce qui sera publié si l'avis n'est pas anonyme
    publicName: authorDisplayNameOf(user?.name || r.shippingName), publicGovernorate: splitCity(r.shippingCity).governorate || null,
  }));
}

export async function submitLineReview(userId: number, raw: ReviewSubmission) {
  const input = reviewSubmissionSchema.parse(raw);
  const db = await requireDb();
  const [line] = await db.select({
    id: orderItems.id, orderId: orderItems.orderId, productId: orderItems.productId, productSlug: orderItems.productSlug,
    productName: orderItems.productName, shopSlug: orderItems.shopSlug, shippingName: orders.shippingName, shippingCity: orders.shippingCity,
    delivered: sql<number>`${deliveredLine}`, reviewed: sql<number>`${alreadyReviewed}`,
    pricingMode: orderItems.pricingMode, widthCm: orderItems.widthCm, heightCm: orderItems.heightCm, selectedColor: orderItems.selectedColor,
    neonText: orderItems.neonText, neonColorName: orderItems.neonColorName, neonSize: orderItems.neonSize,
  }).from(orderItems).innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(and(eq(orderItems.id, input.orderItemId), eq(orders.userId, userId))).limit(1);
  // Ligne d'un autre client : même réponse qu'une ligne inexistante
  if (!line) throw fail("NOT_FOUND", "Cette ligne de commande est introuvable");
  if (!num(line.delivered)) throw fail("FORBIDDEN", "Vous pourrez donner votre avis une fois cet article livré");
  if (num(line.reviewed)) throw fail("CONFLICT", "Vous avez déjà donné votre avis sur cet article");

  const photoIds = Array.from(new Set(input.photoIds));
  const cutoff = new Date(Date.now() - PENDING_REVIEW_PHOTO_TTL_MS);
  const photos = photoIds.length
    ? await db.select({ id: reviewPhotos.id }).from(reviewPhotos).where(and(inArray(reviewPhotos.id, photoIds), eq(reviewPhotos.ownerUserId, userId), isNull(reviewPhotos.reviewId), sql`${reviewPhotos.createdAt} >= ${cutoff}`))
    : [];
  if (photos.length !== photoIds.length) throw fail("BAD_REQUEST", "Une photo est introuvable ou a expiré : envoyez-la à nouveau");

  const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  const anonymous = input.anonymous;
  try {
    return await db.transaction(async (tx) => {
      const result = await tx.insert(reviews).values({
        userId, orderId: line.orderId, orderItemId: line.id, productId: line.productId ?? null, productSlug: line.productSlug,
        productName: line.productName, shopSlug: line.shopSlug, rating: input.rating,
        qualityRating: input.qualityRating, conformityRating: input.conformityRating, deliveryRating: input.deliveryRating,
        purchasedVariant: purchasedVariantOf(line), isCustom: isCustomLine(line) ? 1 : 0,
        // Anonyme : ni nom ni gouvernorat ne sont enregistrés
        authorDisplayName: anonymous ? null : authorDisplayNameOf(user?.name || line.shippingName),
        authorGovernorate: anonymous ? null : splitCity(line.shippingCity).governorate || null,
        body: input.body, status: "pending",
      });
      const reviewId = Number((result as unknown as Array<{ insertId?: number }>)[0]?.insertId ?? 0);
      for (let position = 0; position < photoIds.length; position++) {
        await tx.update(reviewPhotos).set({ reviewId, position }).where(and(eq(reviewPhotos.id, photoIds[position]), isNull(reviewPhotos.reviewId)));
      }
      return { id: reviewId, status: "pending" as const };
    });
  } catch (error) {
    // Deux envois simultanés : l'index unique (une ligne = un avis) tranche
    if (String((error as { code?: string; cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code) === "ER_DUP_ENTRY") {
      throw fail("CONFLICT", "Vous avez déjà donné votre avis sur cet article");
    }
    throw error;
  }
}

// ===========================================================
// Photos d'avis : envoi, accès, nettoyage
// ===========================================================

/** Supprime les photos jamais rattachées à un avis, envoyées il y a plus de 24 h (fichier + ligne) */
export async function cleanupPendingReviewPhotos(userId?: number) {
  const db = await getDb();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - PENDING_REVIEW_PHOTO_TTL_MS);
  const conditions = [isNull(reviewPhotos.reviewId), lt(reviewPhotos.createdAt, cutoff)];
  if (userId) conditions.push(eq(reviewPhotos.ownerUserId, userId));
  const expired = await db.select({ id: reviewPhotos.id, storageKey: reviewPhotos.storageKey }).from(reviewPhotos).where(and(...conditions));
  if (!expired.length) return 0;
  await db.delete(reviewPhotos).where(inArray(reviewPhotos.id, expired.map((p) => p.id)));
  expired.forEach((p) => deleteStoredFile(p.storageKey));
  return expired.length;
}

/** Envoi d'UNE photo par un client connecté (même validation que les photos produits) */
export async function storeReviewPhoto(userId: number, stream: Readable, declaredLength?: number) {
  const db = await requireDb();
  await cleanupPendingReviewPhotos(userId);
  const [pending] = await db.select({ n: sql<number>`COUNT(*)` }).from(reviewPhotos).where(and(eq(reviewPhotos.ownerUserId, userId), isNull(reviewPhotos.reviewId)));
  if (num(pending?.n) >= MAX_PENDING_REVIEW_PHOTOS) {
    throw Object.assign(new Error("Trop de photos en attente : envoyez votre avis ou réessayez demain."), { status: 429 });
  }
  const stored = await storeUpload(stream, "image", declaredLength, REVIEW_PHOTO_LIMITS);
  try {
    const result = await db.insert(reviewPhotos).values({ ownerUserId: userId, storageKey: stored.storageKey, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes });
    const id = Number((result as unknown as Array<{ insertId?: number }>)[0]?.insertId ?? 0);
    return { id, url: mediaUrl(stored.storageKey) };
  } catch (error) {
    deleteStoredFile(stored.storageKey);
    throw error;
  }
}

/** Accès à un fichier /media/<clé> de photo d'avis : public seulement si l'avis est publié et la photo visible */
export async function getReviewPhotoAccess(storageKey: string) {
  const db = await requireDb();
  const [row] = await db.select({ ownerUserId: reviewPhotos.ownerUserId, mimeType: reviewPhotos.mimeType, hiddenAt: reviewPhotos.hiddenAt, status: reviews.status })
    .from(reviewPhotos).leftJoin(reviews, eq(reviewPhotos.reviewId, reviews.id)).where(eq(reviewPhotos.storageKey, storageKey)).limit(1);
  if (!row) return null;
  return { ownerUserId: row.ownerUserId, mimeType: row.mimeType, isPublic: row.status === "published" && !row.hiddenAt };
}

// ===========================================================
// Public : résumé, avis, photos
// ===========================================================

export type ReviewScope = { scope: "product" | "shop"; slug: string };

function scopeCondition({ scope, slug }: ReviewScope): SQL {
  return scope === "product" ? eq(reviews.productSlug, slug) : eq(reviews.shopSlug, slug);
}
const visiblePhoto = sql`rp.hiddenAt IS NULL`;
// Sous-requêtes corrélées : « reviews.id » est écrit en clair, car Drizzle n'ajoute pas le nom de la table
// dans une requête sur une seule table (« id » seul désignerait alors la colonne de la sous-requête).

/** Moyenne, répartition 5→1, moyennes des 3 critères : avis PUBLIÉS uniquement (masqués / en attente exclus) */
async function summaryOf(where: SQL) {
  const db = await requireDb();
  const published = and(where, eq(reviews.status, "published"));
  const [[totals], distribution] = await Promise.all([
    db.select({
      count: sql<number>`COUNT(*)`, average: sql<string | null>`AVG(${reviews.rating})`,
      quality: sql<string | null>`AVG(${reviews.qualityRating})`, conformity: sql<string | null>`AVG(${reviews.conformityRating})`, delivery: sql<string | null>`AVG(${reviews.deliveryRating})`,
      criteriaCount: sql<number>`COUNT(${reviews.qualityRating})`,
      withPhotos: sql<number>`SUM(EXISTS (SELECT 1 FROM review_photos rp WHERE rp.reviewId = reviews.id AND ${visiblePhoto}))`,
    }).from(reviews).where(published),
    db.select({ rating: reviews.rating, n: sql<number>`COUNT(*)` }).from(reviews).where(published).groupBy(reviews.rating),
  ]);
  const round = (v: string | null) => (v === null ? null : Math.round(Number(v) * 10) / 10);
  const count = num(totals?.count);
  return {
    count,
    average: count ? round(totals.average) : null,
    distribution: [5, 4, 3, 2, 1].map((stars) => ({ stars, count: num(distribution.find((d) => d.rating === stars)?.n) })),
    criteria: { qualityRating: round(totals?.quality ?? null), conformityRating: round(totals?.conformity ?? null), deliveryRating: round(totals?.delivery ?? null) },
    criteriaCount: num(totals?.criteriaCount),
    withPhotos: num(totals?.withPhotos),
  };
}

/** Onglets de la fiche : « Ce produit (N) » et « Tout l'atelier (N) » */
export async function productReviewsOverview(productSlug: string) {
  const db = await requireDb();
  const [product] = await db.select({ shopSlug: shops.slug, shopName: shops.name }).from(products).innerJoin(shops, eq(products.shopId, shops.id))
    .where(and(eq(products.slug, productSlug), eq(products.status, "published"), eq(shops.status, "active"))).limit(1);
  if (!product) throw fail("NOT_FOUND", "Produit introuvable");
  const [productSummary, shopSummary] = await Promise.all([summaryOf(eq(reviews.productSlug, productSlug)), summaryOf(eq(reviews.shopSlug, product.shopSlug))]);
  return { shopSlug: product.shopSlug, shopName: product.shopName, product: productSummary, shop: shopSummary };
}

export async function listPublicReviews(input: ReviewScope & { filter?: ReviewFilter | null; sort?: ReviewSort; page?: number }, viewerId?: number | null) {
  const db = await requireDb();
  const conditions: SQL[] = [scopeCondition(input), eq(reviews.status, "published")];
  if (input.filter === "photos") conditions.push(sql`EXISTS (SELECT 1 FROM review_photos rp WHERE rp.reviewId = reviews.id AND ${visiblePhoto})`);
  if (input.filter === "five") conditions.push(eq(reviews.rating, 5));
  if (input.filter === "custom") conditions.push(eq(reviews.isCustom, 1));
  const where = and(...conditions);
  const helpful = sql<number>`(SELECT COUNT(*) FROM review_votes v WHERE v.reviewId = reviews.id)`;
  const order = {
    recent: [desc(reviews.createdAt), desc(reviews.id)],
    helpful: [desc(helpful), desc(reviews.createdAt), desc(reviews.id)],
    rating_high: [desc(reviews.rating), desc(reviews.createdAt), desc(reviews.id)],
    rating_low: [asc(reviews.rating), desc(reviews.createdAt), desc(reviews.id)],
  }[input.sort ?? "recent"];
  const page = Math.max(1, input.page ?? 1);
  const [rows, [total]] = await Promise.all([
    db.select({
      id: reviews.id, rating: reviews.rating, qualityRating: reviews.qualityRating, conformityRating: reviews.conformityRating, deliveryRating: reviews.deliveryRating,
      body: reviews.body, createdAt: reviews.createdAt, purchasedVariant: reviews.purchasedVariant, isCustom: reviews.isCustom,
      authorDisplayName: reviews.authorDisplayName, authorGovernorate: reviews.authorGovernorate,
      productSlug: reviews.productSlug, productName: reviews.productName, vendorReply: reviews.vendorReply, vendorReplyAt: reviews.vendorReplyAt,
      helpfulCount: helpful,
      votedByMe: viewerId ? sql<number>`EXISTS (SELECT 1 FROM review_votes v WHERE v.reviewId = reviews.id AND v.userId = ${viewerId})` : sql<number>`0`,
      reportedByMe: viewerId ? sql<number>`EXISTS (SELECT 1 FROM review_reports x WHERE x.reviewId = reviews.id AND x.userId = ${viewerId})` : sql<number>`0`,
      mine: viewerId ? sql<number>`${reviews.userId} = ${viewerId}` : sql<number>`0`,
    }).from(reviews).where(where).orderBy(...order).limit(REVIEW_PAGE_SIZE).offset((page - 1) * REVIEW_PAGE_SIZE),
    db.select({ n: sql<number>`COUNT(*)` }).from(reviews).where(where),
  ]);
  const photos = rows.length
    ? await db.select({ id: reviewPhotos.id, reviewId: reviewPhotos.reviewId, storageKey: reviewPhotos.storageKey }).from(reviewPhotos)
      .where(and(inArray(reviewPhotos.reviewId, rows.map((r) => r.id)), isNull(reviewPhotos.hiddenAt))).orderBy(asc(reviewPhotos.position))
    : [];
  const totalCount = num(total?.n);
  return {
    items: rows.map((r) => ({
      ...r,
      isCustom: Boolean(r.isCustom),
      // Tous les avis viennent d'une commande livrée (vérifié à l'envoi) : achat vérifié dans tous les cas, anonymes compris
      verifiedPurchase: true,
      author: r.authorDisplayName ?? ANONYMOUS_AUTHOR,
      anonymous: r.authorDisplayName === null,
      helpfulCount: num(r.helpfulCount), votedByMe: Boolean(num(r.votedByMe)), reportedByMe: Boolean(num(r.reportedByMe)), mine: Boolean(num(r.mine)),
      photos: photos.filter((p) => p.reviewId === r.id).map((p) => ({ id: p.id, url: mediaUrl(p.storageKey) })),
    })),
    total: totalCount, page, hasMore: page * REVIEW_PAGE_SIZE < totalCount,
  };
}

/** « Photos des clients » : photos visibles des avis publiés (les plus récentes d'abord) */
export async function listCustomerPhotos(input: ReviewScope) {
  const db = await requireDb();
  const rows = await db.select({ id: reviewPhotos.id, storageKey: reviewPhotos.storageKey, reviewId: reviews.id, rating: reviews.rating, author: reviews.authorDisplayName, productName: reviews.productName })
    .from(reviewPhotos).innerJoin(reviews, eq(reviewPhotos.reviewId, reviews.id))
    .where(and(scopeCondition(input), eq(reviews.status, "published"), isNull(reviewPhotos.hiddenAt)))
    .orderBy(desc(reviews.createdAt), asc(reviewPhotos.position)).limit(40);
  return rows.map((r) => ({ id: r.id, url: mediaUrl(r.storageKey), reviewId: r.reviewId, rating: r.rating, author: r.author ?? ANONYMOUS_AUTHOR, productName: r.productName }));
}

// ===========================================================
// « Utile » et « Signaler »
// ===========================================================

async function requirePublishedReview(reviewId: number) {
  const db = await requireDb();
  const [review] = await db.select({ id: reviews.id, userId: reviews.userId, status: reviews.status, shopSlug: reviews.shopSlug, vendorReply: reviews.vendorReply })
    .from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!review || review.status !== "published") throw fail("NOT_FOUND", "Avis introuvable");
  return review;
}

/** Un vote par compte : second clic = vote retiré. Pas de vote sur son propre avis. */
export async function toggleHelpful(userId: number, reviewId: number) {
  const db = await requireDb();
  const review = await requirePublishedReview(reviewId);
  if (review.userId === userId) throw fail("FORBIDDEN", "Vous ne pouvez pas voter pour votre propre avis");
  const [existing] = await db.select({ id: reviewVotes.id }).from(reviewVotes).where(and(eq(reviewVotes.reviewId, reviewId), eq(reviewVotes.userId, userId))).limit(1);
  if (existing) await db.delete(reviewVotes).where(eq(reviewVotes.id, existing.id));
  else await db.insert(reviewVotes).values({ reviewId, userId }).onDuplicateKeyUpdate({ set: { reviewId } });
  const [count] = await db.select({ n: sql<number>`COUNT(*)` }).from(reviewVotes).where(eq(reviewVotes.reviewId, reviewId));
  return { voted: !existing, helpfulCount: num(count?.n) };
}

export async function reportReview(userId: number, reviewId: number, reason: string) {
  const db = await requireDb();
  const review = await requirePublishedReview(reviewId);
  if (review.userId === userId) throw fail("FORBIDDEN", "Vous ne pouvez pas signaler votre propre avis");
  const [existing] = await db.select({ id: reviewReports.id }).from(reviewReports).where(and(eq(reviewReports.reviewId, reviewId), eq(reviewReports.userId, userId))).limit(1);
  if (existing) throw fail("CONFLICT", "Vous avez déjà signalé cet avis");
  await db.insert(reviewReports).values({ reviewId, userId, reason: reason.trim() });
  return { reported: true };
}

// ===========================================================
// Vendeur : ses avis et sa réponse (une seule, publique)
// ===========================================================

async function requireVendorShop(userId: number) {
  const shop = await getShopForUser(userId);
  if (!shop) throw fail("FORBIDDEN", "Boutique introuvable pour ce compte vendeur");
  return shop;
}

export async function listVendorReviews(userId: number) {
  const db = await requireDb();
  const shop = await requireVendorShop(userId);
  const rows = await db.select({
    id: reviews.id, rating: reviews.rating, qualityRating: reviews.qualityRating, conformityRating: reviews.conformityRating, deliveryRating: reviews.deliveryRating,
    body: reviews.body, status: reviews.status, createdAt: reviews.createdAt, productName: reviews.productName, productSlug: reviews.productSlug,
    purchasedVariant: reviews.purchasedVariant, authorDisplayName: reviews.authorDisplayName, authorGovernorate: reviews.authorGovernorate,
    vendorReply: reviews.vendorReply, vendorReplyAt: reviews.vendorReplyAt,
  }).from(reviews).where(eq(reviews.shopSlug, shop.slug)).orderBy(desc(reviews.createdAt)).limit(200);
  const photos = rows.length
    ? await db.select({ id: reviewPhotos.id, reviewId: reviewPhotos.reviewId, storageKey: reviewPhotos.storageKey }).from(reviewPhotos)
      .where(and(inArray(reviewPhotos.reviewId, rows.map((r) => r.id)), isNull(reviewPhotos.hiddenAt))).orderBy(asc(reviewPhotos.position))
    : [];
  return rows.map((r) => ({
    ...r, author: r.authorDisplayName ?? ANONYMOUS_AUTHOR,
    // Réponse possible : avis publié, sans réponse
    canReply: r.status === "published" && r.vendorReply === null,
    photos: photos.filter((p) => p.reviewId === r.id).map((p) => ({ id: p.id, url: mediaUrl(p.storageKey) })),
  }));
}

export async function replyToReview(userId: number, reviewId: number, body: string) {
  const db = await requireDb();
  const shop = await requireVendorShop(userId);
  const [review] = await db.select({ shopSlug: reviews.shopSlug, status: reviews.status, vendorReply: reviews.vendorReply }).from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  // Avis d'une autre boutique : même réponse qu'un avis inexistant
  if (!review || review.shopSlug !== shop.slug) throw fail("NOT_FOUND", "Avis introuvable");
  if (review.status !== "published") throw fail("FORBIDDEN", "Vous pourrez répondre une fois l'avis publié");
  if (review.vendorReply !== null) throw fail("CONFLICT", "Vous avez déjà répondu à cet avis");
  // Condition « pas encore de réponse » dans la requête : deux envois simultanés ne peuvent pas écrire deux fois
  const result = await db.update(reviews).set({ vendorReply: body.trim(), vendorReplyAt: new Date(), vendorReplyUserId: userId })
    .where(and(eq(reviews.id, reviewId), isNull(reviews.vendorReply)));
  if (Number((result as unknown as Array<{ affectedRows?: number }>)[0]?.affectedRows ?? 0) === 0) throw fail("CONFLICT", "Vous avez déjà répondu à cet avis");
  return { replied: true };
}

// ===========================================================
// Admin : détail, photos masquées, signalements
// ===========================================================

export async function adminReviewDetail(reviewId: number) {
  const db = await requireDb();
  const [review] = await db.select({
    id: reviews.id, rating: reviews.rating, qualityRating: reviews.qualityRating, conformityRating: reviews.conformityRating, deliveryRating: reviews.deliveryRating,
    body: reviews.body, status: reviews.status, createdAt: reviews.createdAt, orderId: reviews.orderId, orderItemId: reviews.orderItemId,
    productName: reviews.productName, productSlug: reviews.productSlug, shopSlug: reviews.shopSlug, purchasedVariant: reviews.purchasedVariant,
    authorDisplayName: reviews.authorDisplayName, authorGovernorate: reviews.authorGovernorate, vendorReply: reviews.vendorReply, vendorReplyAt: reviews.vendorReplyAt,
    authorEmail: users.email, authorName: users.name,
  }).from(reviews).leftJoin(users, eq(reviews.userId, users.id)).where(eq(reviews.id, reviewId)).limit(1);
  if (!review) throw fail("NOT_FOUND", "Avis introuvable");
  const [photos, reports] = await Promise.all([
    db.select({ id: reviewPhotos.id, storageKey: reviewPhotos.storageKey, hiddenAt: reviewPhotos.hiddenAt }).from(reviewPhotos).where(eq(reviewPhotos.reviewId, reviewId)).orderBy(asc(reviewPhotos.position)),
    db.select({ id: reviewReports.id, reason: reviewReports.reason, status: reviewReports.status, createdAt: reviewReports.createdAt, reporterEmail: users.email })
      .from(reviewReports).leftJoin(users, eq(reviewReports.userId, users.id)).where(eq(reviewReports.reviewId, reviewId)).orderBy(desc(reviewReports.createdAt)),
  ]);
  return { ...review, photos: photos.map((p) => ({ id: p.id, url: mediaUrl(p.storageKey), hidden: p.hiddenAt !== null })), reports };
}

export async function adminSetReviewPhotoHidden(adminId: number, photoId: number, hidden: boolean) {
  const db = await requireDb();
  const [photo] = await db.select({ id: reviewPhotos.id, reviewId: reviewPhotos.reviewId }).from(reviewPhotos).where(eq(reviewPhotos.id, photoId)).limit(1);
  if (!photo?.reviewId) throw fail("NOT_FOUND", "Photo introuvable");
  await db.update(reviewPhotos).set(hidden ? { hiddenAt: new Date(), hiddenByUserId: adminId } : { hiddenAt: null, hiddenByUserId: null }).where(eq(reviewPhotos.id, photoId));
  return { hidden };
}

export async function adminListReviewReports(status: "open" | "resolved" | "all") {
  const db = await requireDb();
  const rows = await db.select({
    id: reviewReports.id, reason: reviewReports.reason, status: reviewReports.status, createdAt: reviewReports.createdAt, resolvedAt: reviewReports.resolvedAt,
    reviewId: reviews.id, reviewStatus: reviews.status, rating: reviews.rating, body: reviews.body, productName: reviews.productName, shopSlug: reviews.shopSlug,
    reporterEmail: users.email,
  }).from(reviewReports).innerJoin(reviews, eq(reviewReports.reviewId, reviews.id)).leftJoin(users, eq(reviewReports.userId, users.id))
    .where(status === "all" ? undefined : eq(reviewReports.status, status)).orderBy(desc(reviewReports.createdAt)).limit(200);
  const [open] = await db.select({ n: sql<number>`COUNT(*)` }).from(reviewReports).where(eq(reviewReports.status, "open"));
  return { items: rows, openCount: num(open?.n) };
}

export async function adminResolveReviewReport(adminId: number, reportId: number) {
  const db = await requireDb();
  const result = await db.update(reviewReports).set({ status: "resolved", resolvedAt: new Date(), resolvedByUserId: adminId }).where(and(eq(reviewReports.id, reportId), eq(reviewReports.status, "open")));
  if (Number((result as unknown as Array<{ affectedRows?: number }>)[0]?.affectedRows ?? 0) === 0) throw fail("NOT_FOUND", "Signalement introuvable ou déjà traité");
  return { resolved: true };
}
