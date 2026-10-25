import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { TRPCError } from "@trpc/server";
import { categories, media, productOptions, products, shopCategories, shops } from "../drizzle/schema";
import { getDb } from "./db";
import { deleteStoredFile, mediaUrl } from "./mediaStorage";
import { getSettings } from "./settings";
import { parseVariants, toVideoEmbedUrl, type ProductInput } from "@shared/productValidation";

/**
 * Espace vendeur : catégories, médias et produits.
 * Chaque fonction reçoit l'identifiant de l'utilisateur authentifié et vérifie elle-même
 * la propriété (boutique, produit, média) côté serveur.
 */

function slugify(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  return db;
}

export async function getShopForUser(userId: number) {
  const db = await requireDb();
  return (await db.select().from(shops).where(eq(shops.userId, userId)).limit(1))[0];
}

/** Boutique du vendeur, obligatoirement approuvée (statut `active`). */
export async function requireActiveShop(userId: number) {
  const shop = await getShopForUser(userId);
  if (!shop) throw new TRPCError({ code: "FORBIDDEN", message: "Boutique introuvable pour ce compte vendeur" });
  if (shop.status !== "active") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Votre boutique doit être validée par l'administrateur avant de pouvoir gérer des produits" });
  }
  return shop;
}

// ===========================================================
// Catégories
// ===========================================================

export type CategoryNode = {
  id: number;
  name: string;
  slug: string;
  parentId: number | null;
  status: "approved" | "pending" | "rejected";
  proposedByShopId: number | null;
  productCount: number;
  children: CategoryNode[];
};

function buildTree(rows: Array<Omit<CategoryNode, "children">>): CategoryNode[] {
  const byId = new Map<number, CategoryNode>(rows.map((row) => [row.id, { ...row, children: [] }]));
  const roots: CategoryNode[] = [];
  for (const node of Array.from(byId.values())) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Catégories publiques (approuvées) avec le nombre de produits publiés. */
export async function listPublicCategories() {
  const db = await requireDb();
  const rows = await db.select({
    id: categories.id, name: categories.name, slug: categories.slug, parentId: categories.parentId,
    status: categories.status, proposedByShopId: categories.proposedByShopId,
    productCount: sql<number>`(SELECT COUNT(*) FROM products p INNER JOIN shops s ON s.id = p.shopId WHERE p.categoryId = categories.id AND p.status = 'published' AND s.status = 'active')`,
  }).from(categories).where(and(eq(categories.status, "approved"), eq(categories.active, 1))).orderBy(asc(categories.sortOrder), asc(categories.name));
  // Une sous-catégorie dont le parent est désactivé n'est pas affichée
  return buildTree(rows.map((r) => ({ ...r, productCount: Number(r.productCount) }))).filter((node) => node.parentId === null);
}

/** Catégories visibles par un vendeur : catégories approuvées + ses propres propositions. */
export async function listVendorCategories(userId: number) {
  const db = await requireDb();
  const shop = await getShopForUser(userId);
  const shopId = shop?.id ?? -1;
  const rows = await db.select({
    id: categories.id, name: categories.name, slug: categories.slug, parentId: categories.parentId,
    status: categories.status, proposedByShopId: categories.proposedByShopId,
    productCount: sql<number>`(SELECT COUNT(*) FROM products p WHERE p.categoryId = categories.id AND p.shopId = ${shopId})`,
  }).from(categories)
    .where(or(and(eq(categories.status, "approved"), eq(categories.active, 1)), eq(categories.proposedByShopId, shopId)))
    .orderBy(asc(categories.sortOrder), asc(categories.name));
  return buildTree(rows.map((r) => ({ ...r, productCount: Number(r.productCount) })));
}

async function getParentForProposal(parentId: number | null | undefined) {
  if (!parentId) return null;
  const db = await requireDb();
  const parent = (await db.select().from(categories).where(eq(categories.id, parentId)).limit(1))[0];
  if (!parent || parent.status !== "approved") throw new Error("Catégorie parente introuvable");
  if (parent.parentId) throw new Error("Une sous-catégorie ne peut pas contenir d'autres sous-catégories");
  return parent;
}

/** Le vendeur propose une catégorie ; elle reste `pending` jusqu'à validation par l'administration. */
export async function proposeCategory(userId: number, input: { name: string; parentId?: number | null }) {
  const db = await requireDb();
  const shop = await requireActiveShop(userId);
  const parent = await getParentForProposal(input.parentId);
  const name = input.name.trim();
  const slug = slugify(name);
  if (slug.length < 2) throw new Error("Nom de catégorie invalide");

  const duplicate = (await db.select().from(categories).where(or(eq(categories.slug, slug), sql`LOWER(${categories.name}) = ${name.toLowerCase()}`)).limit(1))[0];
  if (duplicate) {
    if (duplicate.status === "approved") throw new Error(`La catégorie « ${duplicate.name} » existe déjà : sélectionnez-la directement.`);
    if (duplicate.proposedByShopId === shop.id) throw new Error("Vous avez déjà proposé cette catégorie.");
    throw new Error("Cette catégorie a déjà été proposée et est en cours d'examen.");
  }

  const result = await db.insert(categories).values({ name, slug, parentId: parent?.id ?? null, status: "pending", proposedByShopId: shop.id, sortOrder: 999 });
  return { id: Number((result as unknown as Array<{ insertId?: number }>)[0]?.insertId ?? 0), status: "pending" as const };
}

async function requireOwnProposal(userId: number, categoryId: number) {
  const db = await requireDb();
  const shop = await requireActiveShop(userId);
  const category = (await db.select().from(categories).where(eq(categories.id, categoryId)).limit(1))[0];
  if (!category || category.proposedByShopId !== shop.id) throw new Error("Catégorie introuvable ou non modifiable");
  if (category.status === "approved") throw new Error("Une catégorie validée par l'administration ne peut plus être modifiée par un vendeur");
  return { shop, category };
}

export async function updateProposedCategory(userId: number, input: { categoryId: number; name: string; parentId?: number | null }) {
  const db = await requireDb();
  const { category } = await requireOwnProposal(userId, input.categoryId);
  const parent = await getParentForProposal(input.parentId);
  const name = input.name.trim();
  const slug = slugify(name);
  const duplicate = (await db.select({ id: categories.id }).from(categories).where(and(eq(categories.slug, slug), sql`${categories.id} <> ${category.id}`)).limit(1))[0];
  if (duplicate) throw new Error("Une catégorie portant ce nom existe déjà");
  await db.update(categories).set({ name, slug, parentId: parent?.id ?? null, status: "pending" }).where(eq(categories.id, category.id));
  await db.update(products).set({ category: name }).where(eq(products.categoryId, category.id));
  return { success: true };
}

/**
 * Supprime une catégorie proposée. Si des produits l'utilisent, une catégorie de
 * remplacement valide est obligatoire : aucun produit ne reste sans catégorie.
 */
export async function deleteProposedCategory(userId: number, input: { categoryId: number; reassignToCategoryId?: number }) {
  const db = await requireDb();
  const { shop, category } = await requireOwnProposal(userId, input.categoryId);
  const used = Number((await db.select({ value: count() }).from(products).where(eq(products.categoryId, category.id)))[0]?.value ?? 0);
  if (used > 0) {
    if (!input.reassignToCategoryId) {
      throw new Error(`Cette catégorie est utilisée par ${used} produit(s). Choisissez une catégorie de remplacement pour confirmer la suppression.`);
    }
    const target = (await db.select().from(categories).where(eq(categories.id, input.reassignToCategoryId)).limit(1))[0];
    const targetAllowed = target && target.id !== category.id && (target.status === "approved" || target.proposedByShopId === shop.id);
    if (!targetAllowed) throw new Error("Catégorie de remplacement invalide");
    await db.update(products).set({ categoryId: target.id, category: target.name }).where(eq(products.categoryId, category.id));
  }
  await db.update(categories).set({ parentId: null }).where(eq(categories.parentId, category.id));
  await db.delete(categories).where(eq(categories.id, category.id));
  return { success: true, reassigned: used };
}

// --- Administration des catégories ---

export async function adminListCategories() {
  const db = await requireDb();
  const rows = await db.select({
    id: categories.id, name: categories.name, slug: categories.slug, parentId: categories.parentId, status: categories.status,
    proposedByShopId: categories.proposedByShopId, shopName: shops.name, createdAt: categories.createdAt,
    productCount: sql<number>`(SELECT COUNT(*) FROM products p WHERE p.categoryId = categories.id)`,
  }).from(categories).leftJoin(shops, eq(categories.proposedByShopId, shops.id)).orderBy(asc(categories.sortOrder), asc(categories.name));
  return rows.map((r) => ({ ...r, productCount: Number(r.productCount) }));
}

export async function adminModerateCategory(categoryId: number, status: "approved" | "rejected") {
  const db = await requireDb();
  const category = (await db.select().from(categories).where(eq(categories.id, categoryId)).limit(1))[0];
  if (!category) throw new Error("Catégorie introuvable");
  await db.update(categories).set({ status }).where(eq(categories.id, categoryId));
  return { success: true };
}

export async function adminCreateCategory(input: { name: string; parentId?: number | null }) {
  const db = await requireDb();
  const parent = await getParentForProposal(input.parentId);
  const name = input.name.trim();
  const slug = slugify(name);
  const duplicate = (await db.select({ id: categories.id }).from(categories).where(eq(categories.slug, slug)).limit(1))[0];
  if (duplicate) throw new Error("Une catégorie portant ce nom existe déjà");
  await db.insert(categories).values({ name, slug, parentId: parent?.id ?? null, status: "approved", sortOrder: 500 });
  return { success: true };
}

// ===========================================================
// Médias
// ===========================================================

export const MAX_UNATTACHED_UPLOADS = 40;

export async function countUnattachedMedia(userId: number) {
  const db = await requireDb();
  return Number((await db.select({ value: count() }).from(media).where(and(eq(media.ownerUserId, userId), isNull(media.productId))))[0]?.value ?? 0);
}

export async function createMediaRecord(input: { ownerUserId: number; shopId: number; kind: "image" | "video"; storageKey: string; mimeType: string; sizeBytes: number; originalName?: string | null }) {
  const db = await requireDb();
  const result = await db.insert(media).values({ ...input, originalName: input.originalName?.slice(0, 191) ?? null });
  const id = Number((result as unknown as Array<{ insertId?: number }>)[0]?.insertId ?? 0);
  return { id, url: mediaUrl(input.storageKey), kind: input.kind, mimeType: input.mimeType, sizeBytes: input.sizeBytes };
}

/** Informations nécessaires pour décider si un fichier peut être servi. */
export async function getMediaAccessInfo(storageKey: string) {
  const db = await requireDb();
  const row = (await db.select({
    id: media.id, ownerUserId: media.ownerUserId, mimeType: media.mimeType, productId: media.productId,
    productStatus: products.status, shopStatus: shops.status,
  }).from(media)
    .leftJoin(products, eq(media.productId, products.id))
    .leftJoin(shops, eq(products.shopId, shops.id))
    .where(eq(media.storageKey, storageKey)).limit(1))[0];
  if (!row) return null;
  return { ...row, isPublic: row.productStatus === "published" && row.shopStatus === "active" };
}

/** Supprime un média appartenant au vendeur (fichier + référence). */
export async function deleteVendorMedia(userId: number, mediaId: number) {
  const db = await requireDb();
  await requireActiveShop(userId);
  const row = (await db.select().from(media).where(and(eq(media.id, mediaId), eq(media.ownerUserId, userId))).limit(1))[0];
  if (!row) throw new Error("Fichier introuvable");
  if (row.productId) {
    const product = (await db.select({ status: products.status }).from(products).where(eq(products.id, row.productId)).limit(1))[0];
    const remainingImages = Number((await db.select({ value: count() }).from(media).where(and(eq(media.productId, row.productId), eq(media.kind, "image"))))[0]?.value ?? 0);
    if (row.kind === "image" && product?.status === "published" && remainingImages <= 1) {
      throw new Error("Un produit publié doit garder au moins une photo. Ajoutez-en une autre ou dépubliez le produit.");
    }
  }
  await db.delete(media).where(eq(media.id, row.id));
  deleteStoredFile(row.storageKey);
  if (row.productId) await syncPrimaryImage(row.productId);
  return { success: true };
}

/** Met à jour products.imageUrl (utilisée par les cartes, le panier et les favoris) avec l'image principale. */
async function syncPrimaryImage(productId: number) {
  const db = await requireDb();
  const images = await db.select().from(media).where(and(eq(media.productId, productId), eq(media.kind, "image"))).orderBy(desc(media.isPrimary), asc(media.position));
  if (images[0] && !images[0].isPrimary) await db.update(media).set({ isPrimary: 1 }).where(eq(media.id, images[0].id));
  await db.update(products).set({ imageUrl: images[0] ? mediaUrl(images[0].storageKey) : "" }).where(eq(products.id, productId));
}

/** Supprime les fichiers envoyés mais jamais rattachés à un produit depuis plus de 24 h. */
export async function cleanupOrphanMedia() {
  const db = await getDb();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const orphans = await db.select({ id: media.id, storageKey: media.storageKey }).from(media).where(and(isNull(media.productId), lt(media.createdAt, cutoff)));
  if (!orphans.length) return 0;
  await db.delete(media).where(inArray(media.id, orphans.map((o) => o.id)));
  orphans.forEach((o) => deleteStoredFile(o.storageKey));
  return orphans.length;
}

// ===========================================================
// Produits
// ===========================================================

export async function getVendorProduct(userId: number, productId: number) {
  const db = await requireDb();
  const shop = await getShopForUser(userId);
  if (!shop) throw new Error("Boutique introuvable");
  const product = (await db.select().from(products).where(and(eq(products.id, productId), eq(products.shopId, shop.id))).limit(1))[0];
  if (!product) throw new Error("Produit introuvable ou vous n'avez pas l'autorisation de le consulter");
  const files = await db.select().from(media).where(eq(media.productId, product.id)).orderBy(asc(media.position));
  const options = await db.select().from(productOptions).where(eq(productOptions.productId, product.id)).orderBy(asc(productOptions.position), asc(productOptions.id));
  return {
    ...product,
    unitPriceTnd: product.unitPriceTnd == null ? null : Number(product.unitPriceTnd),
    minBillableArea: product.minBillableArea == null ? null : Number(product.minBillableArea),
    minPriceTnd: product.minPriceTnd == null ? null : Number(product.minPriceTnd),
    promoPercent: product.promoPercent == null ? null : Number(product.promoPercent),
    options: options.map((o) => ({ id: o.id, name: o.name, surchargeType: o.surchargeType, amountTnd: Number(o.amountTnd) })),
    priceTnd: Number(product.priceTnd),
    promoPriceTnd: product.promoPriceTnd == null ? null : Number(product.promoPriceTnd),
    variants: parseVariants(product.variants),
    images: files.filter((f) => f.kind === "image").map((f) => ({ id: f.id, url: mediaUrl(f.storageKey), isPrimary: Boolean(f.isPrimary) })),
    video: files.filter((f) => f.kind === "video").map((f) => ({ id: f.id, url: mediaUrl(f.storageKey), mimeType: f.mimeType }))[0] ?? null,
  };
}

/** La catégorie choisie doit appartenir à la boutique du vendeur connecté. */
async function resolveShopCategory(shopId: number, shopCategoryId: number | null | undefined) {
  if (!shopCategoryId) return null;
  const db = await requireDb();
  const row = (await db.select({ id: shopCategories.id }).from(shopCategories)
    .where(and(eq(shopCategories.id, shopCategoryId), eq(shopCategories.shopId, shopId))).limit(1))[0];
  if (!row) throw new TRPCError({ code: "BAD_REQUEST", message: "Catégorie invalide : choisissez une de vos catégories" });
  return row.id;
}

/**
 * Crée ou modifie un produit avec ses médias, en une seule opération.
 * `action: "publish"` rend le produit immédiatement visible dans le catalogue public
 * (règle de modération existante : boutique validée ⇒ publication directe, l'admin peut dépublier ensuite).
 */
export async function saveVendorProduct(userId: number, input: ProductInput) {
  const db = await requireDb();
  const shop = await requireActiveShop(userId);
  const shopCategoryId = await resolveShopCategory(shop.id, input.shopCategoryId);

  let existing: typeof products.$inferSelect | undefined;
  if (input.productId) {
    existing = (await db.select().from(products).where(and(eq(products.id, input.productId), eq(products.shopId, shop.id))).limit(1))[0];
    if (!existing) throw new Error("Produit introuvable ou vous n'avez pas l'autorisation de le modifier");
  }

  // Médias : tous doivent appartenir au vendeur et être libres ou déjà rattachés à ce produit
  const requestedIds = [...input.images.map((i) => i.mediaId), ...(input.videoMediaId ? [input.videoMediaId] : [])];
  if (new Set(requestedIds).size !== requestedIds.length) throw new Error("Un même fichier ne peut pas être utilisé deux fois");
  const ownedMedia = requestedIds.length ? await db.select().from(media).where(and(inArray(media.id, requestedIds), eq(media.ownerUserId, userId))) : [];
  const ownedById = new Map(ownedMedia.map((m) => [m.id, m]));
  for (const id of requestedIds) {
    const file = ownedById.get(id);
    if (!file || (file.productId && file.productId !== existing?.id)) throw new Error("Un des fichiers sélectionnés est introuvable ou ne vous appartient pas");
  }
  if (input.images.some((i) => ownedById.get(i.mediaId)?.kind !== "image")) throw new Error("Les photos doivent être des images");
  if (input.videoMediaId && ownedById.get(input.videoMediaId)?.kind !== "video") throw new Error("Le fichier vidéo est invalide");

  const variants = input.variants;
  const videoEmbed = input.videoUrl ? toVideoEmbedUrl(input.videoUrl) : null;
  // Si l'administration impose une validation, « Publier » envoie le produit en modération
  const requireApproval = (await getSettings()).requireProductApproval;
  const status = input.action === "publish" ? (requireApproval ? "pending" as const : "published" as const) : "draft" as const;
  const primary = input.images.find((i) => i.isPrimary) ?? input.images[0];
  const primaryFile = primary ? ownedById.get(primary.mediaId) : undefined;

  // Prix sur mesure : priceTnd reprend le prix unitaire (« à partir de X DT / m² » dans le catalogue, tri et filtres inchangés)
  const custom = input.pricingMode !== "fixed";
  const dec = (value: number | null | undefined, digits: number) => (custom && value != null ? value.toFixed(digits) : null);
  const values = {
    name: input.name.trim(),
    description: input.description.trim(),
    shopCategoryId,
    priceTnd: custom ? input.unitPriceTnd!.toFixed(2) : input.priceTnd.toFixed(2),
    promoPriceTnd: !custom && input.promoPriceTnd != null ? input.promoPriceTnd.toFixed(2) : null,
    pricingMode: input.pricingMode,
    unitPriceTnd: dec(input.unitPriceTnd, 3),
    minWidthCm: custom ? input.minWidthCm ?? null : null,
    maxWidthCm: custom ? input.maxWidthCm ?? null : null,
    minHeightCm: input.pricingMode === "per_m2" ? input.minHeightCm ?? null : null,
    maxHeightCm: input.pricingMode === "per_m2" ? input.maxHeightCm ?? null : null,
    minBillableArea: dec(input.minBillableArea, 3),
    minPriceTnd: dec(input.minPriceTnd, 3),
    promoPercent: dec(input.promoPercent, 2),
    availability: input.availability,
    stock: input.availability === "in_stock" ? input.stock ?? 0 : input.stock ?? null,
    sku: input.sku?.trim() || null,
    variants: JSON.stringify(variants),
    // Champs historiques conservés pour la recherche et l'affichage existants
    material: variants.materials.join(", ") || null,
    dimensions: variants.dimensions.join(", ") || null,
    delivery: input.delivery?.trim() || null,
    preparationTime: input.preparationTime?.trim() || null,
    extraInfo: input.extraInfo?.trim() || null,
    videoUrl: videoEmbed,
    imageUrl: primaryFile ? mediaUrl(primaryFile.storageKey) : "",
    badge: input.promoPriceTnd != null || (custom && input.promoPercent != null) ? "Promo" : (existing?.badge ?? "Nouveau"),
    status,
  };

  const detached: string[] = [];
  const productId = await db.transaction(async (tx) => {
    let id = existing?.id;
    if (id) {
      await tx.update(products).set(values).where(eq(products.id, id));
    } else {
      const slug = `${slugify(input.name) || "creation"}-${nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
      // Catégorie globale du site : facultative, attribuée ensuite par l'administration (le libellé historique reste NOT NULL)
      const result = await tx.insert(products).values({ ...values, category: "", categoryId: null, shopId: shop.id, slug, tint: "bg-[#f5ede7]" });
      id = Number((result as unknown as Array<{ insertId?: number }>)[0]?.insertId ?? 0);
      if (!id) throw new Error("Le produit n'a pas pu être enregistré");
    }

    // Fichiers retirés du produit : supprimés (référence + fichier après validation de la transaction)
    const previous = await tx.select().from(media).where(eq(media.productId, id));
    const removed = previous.filter((m) => !requestedIds.includes(m.id));
    if (removed.length) {
      await tx.delete(media).where(inArray(media.id, removed.map((m) => m.id)));
      detached.push(...removed.map((m) => m.storageKey));
    }

    for (let position = 0; position < input.images.length; position++) {
      const image = input.images[position];
      await tx.update(media).set({ productId: id, shopId: shop.id, position, isPrimary: image.mediaId === primary?.mediaId ? 1 : 0 }).where(eq(media.id, image.mediaId));
    }
    if (input.videoMediaId) {
      await tx.update(media).set({ productId: id, shopId: shop.id, position: 0, isPrimary: 0 }).where(eq(media.id, input.videoMediaId));
    }

    // Options du produit sur mesure : remplacées en bloc (les commandes passées en gardent leur copie figée)
    await tx.delete(productOptions).where(eq(productOptions.productId, id));
    const options = custom ? input.options : [];
    if (options.length) {
      await tx.insert(productOptions).values(options.map((o, position) => ({ productId: id!, name: o.name.trim(), surchargeType: o.surchargeType, amountTnd: o.amountTnd.toFixed(3), position })));
    }
    return id;
  });

  detached.forEach(deleteStoredFile);
  const saved = (await db.select({ id: products.id, slug: products.slug, status: products.status }).from(products).where(eq(products.id, productId)).limit(1))[0];
  return { success: true, ...saved };
}

/** Publier / dépublier. La publication exige une photo et un prix valide (la catégorie globale est facultative). */
export async function setVendorProductStatus(userId: number, productId: number, status: "draft" | "published") {
  const db = await requireDb();
  const shop = await requireActiveShop(userId);
  const product = (await db.select().from(products).where(and(eq(products.id, productId), eq(products.shopId, shop.id))).limit(1))[0];
  if (!product) throw new Error("Produit introuvable ou vous n'avez pas l'autorisation de le modifier");
  if (status === "published") {
    if (!product.imageUrl) throw new Error("Ajoutez au moins une photo avant de publier ce produit");
    if (Number(product.priceTnd) <= 0) throw new Error("Le prix du produit est invalide");
  }
  const finalStatus = status === "published" && (await getSettings()).requireProductApproval ? "pending" as const : status;
  await db.update(products).set({ status: finalStatus }).where(eq(products.id, product.id));
  return { success: true, status: finalStatus };
}

/** Suppression définitive d'un produit du vendeur et de ses fichiers. Les commandes passées conservent leur copie du nom et du prix. */
export async function deleteVendorProductWithMedia(userId: number, productId: number) {
  const db = await requireDb();
  const shop = await requireActiveShop(userId);
  const product = (await db.select({ id: products.id }).from(products).where(and(eq(products.id, productId), eq(products.shopId, shop.id))).limit(1))[0];
  if (!product) throw new Error("Produit introuvable ou vous n'avez pas l'autorisation de le supprimer");
  const files = await db.select({ id: media.id, storageKey: media.storageKey }).from(media).where(eq(media.productId, product.id));
  await db.transaction(async (tx) => {
    if (files.length) await tx.delete(media).where(inArray(media.id, files.map((f) => f.id)));
    await tx.delete(products).where(eq(products.id, product.id));
  });
  files.forEach((f) => deleteStoredFile(f.storageKey));
  return { success: true };
}

/** Médias publics d'un produit (galerie + vidéo) pour la fiche produit. */
export async function getPublicProductMedia(productId: number) {
  const db = await requireDb();
  const files = await db.select().from(media).where(eq(media.productId, productId)).orderBy(desc(media.isPrimary), asc(media.position));
  return {
    images: files.filter((f) => f.kind === "image").map((f) => ({ id: f.id, url: mediaUrl(f.storageKey) })),
    video: files.filter((f) => f.kind === "video").map((f) => ({ url: mediaUrl(f.storageKey), mimeType: f.mimeType }))[0] ?? null,
  };
}
