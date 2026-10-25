import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { media, neonOffers, neonQuoteRequests, reviews, shops, users } from "../drizzle/schema";
import { getDb } from "./db";
import { getSettings } from "./settings";
import { getShopForUser, requireActiveShop } from "./vendorCatalog";
import { mediaUrl } from "./mediaStorage";
import { computeNeonPrice, neonFromPrice, neonOfferIssues, neonOfferSchema, neonOrderDay, orderNeonWorkshopsForDay, type NeonLineRequest, type NeonOffer, type NeonPriceResult } from "@shared/neon";

/**
 * Néon personnalisé côté serveur : offres des ateliers (relues en base à chaque calcul),
 * bannière de la catégorie du configurateur et demandes de devis avec logo.
 */

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  return db;
}

type OfferRow = typeof neonOffers.$inferSelect;

const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

/** Ligne en base → objet à valider (les colonnes JSON illisibles deviennent des listes vides). */
function rowToInput(row: OfferRow) {
  return {
    enabled: row.enabled === 1,
    sizes: parseJson(row.sizesJson, []),
    includedLetters: row.includedLetters,
    extraLetterPriceTnd: Number(row.extraLetterPriceTnd),
    colors: parseJson(row.colorsJson, []),
    supports: parseJson(row.supportsJson, []),
    outdoorEnabled: row.outdoorEnabled === 1,
    outdoorSurchargeType: row.outdoorSurchargeType,
    outdoorSurchargeValue: Number(row.outdoorSurchargeValue),
    arabicEnabled: row.arabicEnabled === 1,
    productionDaysMin: row.productionDaysMin,
    productionDaysMax: row.productionDaysMax,
  };
}

/** Ligne en base → offre validée (null si la configuration enregistrée est incomplète ou illisible). */
function toOffer(row: OfferRow): NeonOffer | null {
  const parsed = neonOfferSchema.safeParse(rowToInput(row));
  return parsed.success ? parsed.data : null;
}

export type NeonVisibility = { visible: boolean; missing: string[] };

/**
 * Visibilité sur /neon d'un atelier, avec les MÊMES règles que listPublicNeonOffers :
 * boutique active, offre enregistrée, activée et complète. `missing` dit au vendeur ce qui manque.
 */
function neonVisibility(shopStatus: string, row: OfferRow | undefined): NeonVisibility {
  const missing: string[] = [];
  if (shopStatus !== "active") missing.push("Votre boutique doit être validée et active.");
  if (!row) missing.push("Enregistrez votre offre néon.");
  else {
    if (row.enabled !== 1) missing.push("Activez l'offre (« Offre activée »).");
    missing.push(...neonOfferIssues(rowToInput(row)));
  }
  return { visible: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Atelier (vendeur)
// ---------------------------------------------------------------------------

/** Offre du vendeur connecté (null si jamais configurée). */
export async function getVendorNeonOffer(userId: number) {
  const shop = await getShopForUser(userId);
  if (!shop) throw new TRPCError({ code: "FORBIDDEN", message: "Boutique introuvable pour ce compte vendeur" });
  const db = await requireDb();
  const row = (await db.select().from(neonOffers).where(eq(neonOffers.shopId, shop.id)).limit(1))[0];
  return { shopName: shop.name, shopSlug: shop.slug, shopStatus: shop.status, offer: row ? toOffer(row) : null, visibility: neonVisibility(shop.status, row) };
}

/** Enregistre l'offre de la boutique du vendeur connecté (la boutique vient de la session). */
export async function saveVendorNeonOffer(userId: number, input: NeonOffer) {
  const shop = await requireActiveShop(userId);
  const offer = neonOfferSchema.parse(input);
  const values = {
    enabled: offer.enabled ? 1 : 0,
    sizesJson: JSON.stringify(offer.sizes),
    includedLetters: offer.includedLetters,
    extraLetterPriceTnd: offer.extraLetterPriceTnd.toFixed(3),
    colorsJson: JSON.stringify(offer.colors),
    supportsJson: JSON.stringify(offer.supports),
    outdoorEnabled: offer.outdoorEnabled ? 1 : 0,
    outdoorSurchargeType: offer.outdoorSurchargeType,
    outdoorSurchargeValue: offer.outdoorSurchargeValue.toFixed(3),
    arabicEnabled: offer.arabicEnabled ? 1 : 0,
    productionDaysMin: offer.productionDaysMin,
    productionDaysMax: offer.productionDaysMax,
  };
  const db = await requireDb();
  await db.insert(neonOffers).values({ shopId: shop.id, ...values }).onDuplicateKeyUpdate({ set: values });
  return offer;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Ateliers qui proposent le néon : boutique active + offre activée et complète.
 * Ordre aléatoire stable par jour (équitable entre vendeurs) ; note = avis publiés de la boutique, s'il y en a.
 */
export async function listPublicNeonOffers(day = neonOrderDay()) {
  const db = await requireDb();
  const rows = await db.select({ offer: neonOffers, shopId: shops.id, shopSlug: shops.slug, shopName: shops.name, shopLogoUrl: shops.logoUrl, shopCoverUrl: shops.coverUrl, city: shops.city })
    .from(neonOffers).innerJoin(shops, eq(neonOffers.shopId, shops.id))
    .where(and(eq(shops.status, "active"), eq(neonOffers.enabled, 1)));
  const visible = rows
    .map((r) => ({ shopSlug: r.shopSlug, shopName: r.shopName, shopLogoUrl: r.shopLogoUrl, shopCoverUrl: r.shopCoverUrl, city: r.city, offer: toOffer(r.offer) }))
    .filter((r): r is typeof r & { offer: NeonOffer } => Boolean(r.offer?.enabled));
  const ratings = new Map<string, { rating: number; reviewCount: number }>();
  if (visible.length) {
    const stats = await db.select({ shopSlug: reviews.shopSlug, reviewCount: sql<number>`COUNT(*)`, rating: sql<number | null>`AVG(${reviews.rating})` })
      .from(reviews).where(and(inArray(reviews.shopSlug, visible.map((v) => v.shopSlug)), eq(reviews.status, "published"))).groupBy(reviews.shopSlug);
    for (const s of stats) if (s.rating != null && Number(s.reviewCount) > 0) ratings.set(s.shopSlug, { rating: Math.round(Number(s.rating) * 10) / 10, reviewCount: Number(s.reviewCount) });
  }
  return orderNeonWorkshopsForDay(visible.map((v) => ({
    ...v,
    fromPriceTnd: neonFromPrice(v.offer),
    rating: ratings.get(v.shopSlug)?.rating ?? null,
    reviewCount: ratings.get(v.shopSlug)?.reviewCount ?? 0,
  })), day);
}

/** Un atelier visible (mêmes règles que la liste), ou null : slug inconnu, boutique inactive, offre désactivée ou incomplète. */
export async function getPublicNeonWorkshop(shopSlug: string) {
  return (await listPublicNeonOffers()).find((o) => o.shopSlug === shopSlug) ?? null;
}

/** Prix d'une ligne néon chez un atelier, avec les tarifs ACTUELS relus en base (jamais ceux du navigateur). */
export async function priceNeonLine(shopSlug: string, request: NeonLineRequest): Promise<{ shop: { id: number; slug: string; name: string } | null; priced: NeonPriceResult }> {
  const db = await requireDb();
  const row = (await db.select({ offer: neonOffers, shopId: shops.id, shopSlug: shops.slug, shopName: shops.name })
    .from(neonOffers).innerJoin(shops, eq(neonOffers.shopId, shops.id))
    .where(and(eq(shops.slug, shopSlug), eq(shops.status, "active"))).limit(1))[0];
  const offer = row ? toOffer(row.offer) : null;
  if (!row || !offer) return { shop: null, priced: { ok: false, error: "Cet atelier ne propose pas le néon personnalisé.", field: "offer" } };
  return { shop: { id: row.shopId, slug: row.shopSlug, name: row.shopName }, priced: computeNeonPrice(offer, request) };
}

/**
 * Bannière « Créer mon néon » d'une page catégorie : uniquement sur la catégorie choisie par l'admin
 * (réglage neonCategorySlug, jamais déduite du nom), dès qu'au moins une boutique active propose le néon,
 * sauf si l'admin l'a masquée manuellement (neonBannerHidden).
 */
export async function showNeonBanner(categorySlug: string): Promise<boolean> {
  const settings = await getSettings();
  if (settings.neonBannerHidden || !settings.neonCategorySlug || settings.neonCategorySlug !== categorySlug) return false;
  return (await listPublicNeonOffers()).length > 0;
}

// ---------------------------------------------------------------------------
// Demandes de devis (logo)
// ---------------------------------------------------------------------------

export type NeonQuoteInput = { shopSlug: string; mediaId: number; message?: string; phone?: string; sizeCode?: string; outdoor?: boolean };

/** Boutique qui accepte les devis néon (active + offre activée), pour l'envoi du logo et la demande. */
export async function requireNeonShop(shopSlug: string) {
  const offers = await listPublicNeonOffers();
  const found = offers.find((o) => o.shopSlug === shopSlug);
  if (!found) throw new TRPCError({ code: "BAD_REQUEST", message: "Cet atelier ne propose pas le néon personnalisé." });
  const db = await requireDb();
  const shop = (await db.select({ id: shops.id, name: shops.name }).from(shops).where(eq(shops.slug, shopSlug)).limit(1))[0];
  return { ...shop, offer: found.offer };
}

/** Client connecté : demande de devis avec SON logo (envoyé juste avant, non encore utilisé). */
export async function createNeonQuote(userId: number, input: NeonQuoteInput) {
  const shop = await requireNeonShop(input.shopSlug);
  const db = await requireDb();
  const logo = (await db.select().from(media).where(and(eq(media.id, input.mediaId), eq(media.ownerUserId, userId), isNull(media.productId))).limit(1))[0];
  if (!logo || logo.kind !== "image" || logo.shopId !== shop.id) throw new TRPCError({ code: "BAD_REQUEST", message: "Logo introuvable : envoyez à nouveau votre image." });
  const used = await db.select({ id: neonQuoteRequests.id }).from(neonQuoteRequests).where(eq(neonQuoteRequests.mediaId, logo.id)).limit(1);
  if (used.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Ce logo a déjà été envoyé avec une autre demande." });
  if (input.sizeCode && !shop.offer.sizes.some((s) => s.code === input.sizeCode)) throw new TRPCError({ code: "BAD_REQUEST", message: "Cette taille n'est pas proposée par l'atelier." });
  const result = await db.insert(neonQuoteRequests).values({
    shopId: shop.id, userId, mediaId: logo.id,
    message: input.message?.trim() || null, phone: input.phone?.trim() || null,
    sizeCode: input.sizeCode ?? null, outdoor: input.outdoor && shop.offer.outdoorEnabled ? 1 : 0,
  });
  return { id: Number((result as unknown as Array<{ insertId?: number }>)[0]?.insertId ?? 0), shopName: shop.name };
}

const quoteColumns = {
  id: neonQuoteRequests.id, shopId: neonQuoteRequests.shopId, message: neonQuoteRequests.message, phone: neonQuoteRequests.phone,
  sizeCode: neonQuoteRequests.sizeCode, outdoor: neonQuoteRequests.outdoor, status: neonQuoteRequests.status, createdAt: neonQuoteRequests.createdAt,
  clientName: users.name, clientEmail: users.email, shopName: shops.name, logoKey: media.storageKey,
};
const withLogoUrl = <T extends { logoKey: string | null }>(rows: T[]) => rows.map(({ logoKey, ...r }) => ({ ...r, logoUrl: logoKey ? mediaUrl(logoKey) : null }));

/** Demandes reçues par la boutique du vendeur connecté (uniquement les siennes). */
export async function listVendorNeonQuotes(userId: number) {
  const shop = await getShopForUser(userId);
  if (!shop) return [];
  const db = await requireDb();
  return withLogoUrl(await db.select(quoteColumns).from(neonQuoteRequests)
    .innerJoin(users, eq(neonQuoteRequests.userId, users.id)).innerJoin(shops, eq(neonQuoteRequests.shopId, shops.id))
    .leftJoin(media, eq(neonQuoteRequests.mediaId, media.id))
    .where(eq(neonQuoteRequests.shopId, shop.id)).orderBy(desc(neonQuoteRequests.createdAt)).limit(200));
}

export async function setVendorNeonQuoteStatus(userId: number, quoteId: number, status: "new" | "seen" | "answered" | "closed") {
  const shop = await getShopForUser(userId);
  const db = await requireDb();
  const update = shop ? await db.update(neonQuoteRequests).set({ status }).where(and(eq(neonQuoteRequests.id, quoteId), eq(neonQuoteRequests.shopId, shop.id))) : null;
  if (!update || !Number((update as unknown as Array<{ affectedRows?: number }>)[0]?.affectedRows ?? 0)) throw new TRPCError({ code: "NOT_FOUND", message: "Demande introuvable" });
  return { success: true };
}

/** Toutes les demandes (administration). */
export async function adminListNeonQuotes() {
  const db = await requireDb();
  return withLogoUrl(await db.select(quoteColumns).from(neonQuoteRequests)
    .innerJoin(users, eq(neonQuoteRequests.userId, users.id)).innerJoin(shops, eq(neonQuoteRequests.shopId, shops.id))
    .leftJoin(media, eq(neonQuoteRequests.mediaId, media.id))
    .orderBy(desc(neonQuoteRequests.createdAt)).limit(500));
}

/** Logo privé d'une demande : visible aussi par le vendeur de la boutique destinataire. */
export async function canVendorViewQuoteLogo(userId: number, mediaId: number) {
  const shop = await getShopForUser(userId);
  if (!shop) return false;
  const db = await requireDb();
  const rows = await db.select({ id: neonQuoteRequests.id }).from(neonQuoteRequests)
    .where(and(eq(neonQuoteRequests.mediaId, mediaId), inArray(neonQuoteRequests.shopId, [shop.id]))).limit(1);
  return rows.length > 0;
}
