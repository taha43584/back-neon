import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { products, shopCategories } from "../drizzle/schema";
import { getDb } from "./db";
import { requireActiveShop } from "./vendorCatalog";
import { SHOP_CATEGORY_NAME_RULE } from "@shared/productValidation";
import { categorySlug } from "@shared/categoryKey";
import { loadCategoryNames } from "./siteCategories";

/**
 * Catégories propres à chaque boutique. La boutique est TOUJOURS celle du vendeur connecté
 * (jamais un identifiant reçu du navigateur) et doit être approuvée.
 * L'unicité du nom par boutique repose sur la collation utf8mb4_unicode_ci (casse et accents ignorés).
 */

const SHOP_CATEGORY_NAME_MIN = SHOP_CATEGORY_NAME_RULE.min;
const SHOP_CATEGORY_NAME_MAX = SHOP_CATEGORY_NAME_RULE.max;

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  return db;
}

function slugify(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 56);
}

export function normalizeShopCategoryName(raw: string) {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < SHOP_CATEGORY_NAME_MIN || name.length > SHOP_CATEGORY_NAME_MAX) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Le nom de la catégorie doit comporter entre ${SHOP_CATEGORY_NAME_MIN} et ${SHOP_CATEGORY_NAME_MAX} caractères` });
  }
  return name;
}

const duplicateError = (name: string) => new TRPCError({ code: "CONFLICT", message: `Vous avez déjà une catégorie « ${name} »` });
const notFoundError = () => new TRPCError({ code: "NOT_FOUND", message: "Catégorie introuvable" });

function isDuplicateKey(error: unknown) {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === "ER_DUP_ENTRY" || e?.cause?.code === "ER_DUP_ENTRY";
}

/** Doublon dans la boutique = même slug de catégorie du site (« Décor », « decor », « DÉCOR », « Dé-cor »…). */
async function findDuplicate(shopId: number, name: string, exceptId?: number) {
  const db = await requireDb();
  const slug = categorySlug(name);
  const rows = await db.select({ id: shopCategories.id, name: shopCategories.name }).from(shopCategories).where(eq(shopCategories.shopId, shopId));
  return rows.find((r) => r.id !== exceptId && categorySlug(r.name) === slug);
}

const unavailableError = () => new TRPCError({ code: "FORBIDDEN", message: "Cette catégorie n'est pas disponible" });

/**
 * Nom à enregistrer pour un nom saisi : refusé s'il correspond à une catégorie masquée par l'admin ;
 * s'il correspond à une catégorie déjà utilisée par d'autres boutiques, on reprend son nom officiel
 * (même slug → regroupement automatique sur le site).
 */
async function resolveCategoryName(name: string) {
  const { official, hidden } = await loadCategoryNames();
  const slug = categorySlug(name);
  if (hidden.has(slug)) throw unavailableError();
  return official.get(slug) ?? name;
}

/** Slug unique dans la boutique (deux noms différents peuvent donner le même slug, ex. « A&B » et « A B »). */
async function uniqueSlug(shopId: number, name: string, exceptId?: number) {
  const db = await requireDb();
  const base = slugify(name) || "categorie";
  const taken = new Set((await db.select({ slug: shopCategories.slug }).from(shopCategories)
    .where(and(eq(shopCategories.shopId, shopId), sql`${shopCategories.slug} LIKE ${`${base}%`}`, exceptId ? sql`${shopCategories.id} <> ${exceptId}` : undefined)))
    .map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Catégorie appartenant à la boutique, sinon « introuvable » (on ne révèle pas l'existence des catégories d'autrui). */
export async function requireOwnShopCategory(shopId: number, categoryId: number) {
  const db = await requireDb();
  const row = (await db.select().from(shopCategories).where(and(eq(shopCategories.id, categoryId), eq(shopCategories.shopId, shopId))).limit(1))[0];
  if (!row) throw notFoundError();
  return row;
}

export async function listShopCategories(userId: number) {
  const db = await requireDb();
  const shop = await requireActiveShop(userId);
  const rows = await db.select({
    id: shopCategories.id, name: shopCategories.name, slug: shopCategories.slug, position: shopCategories.position, createdAt: shopCategories.createdAt,
    productCount: sql<number>`(SELECT COUNT(*) FROM products p WHERE p.shopCategoryId = shop_categories.id AND p.shopId = ${shop.id})`,
  }).from(shopCategories).where(eq(shopCategories.shopId, shop.id)).orderBy(asc(shopCategories.position), asc(shopCategories.id));
  const uncategorized = Number((await db.select({ value: count() }).from(products).where(and(eq(products.shopId, shop.id), sql`${products.shopCategoryId} IS NULL`)))[0]?.value ?? 0);
  return { categories: rows.map((r) => ({ ...r, productCount: Number(r.productCount) })), uncategorized };
}

/**
 * Liste du sélecteur de catégorie du vendeur :
 * 1. les catégories de SA boutique ; 2. les catégories utilisées par d'autres boutiques (NOMS uniquement,
 * non masquées, même sans produit publié — jamais leurs produits ni leurs statistiques).
 */
export async function listCategoryChoices(userId: number) {
  const db = await requireDb();
  const shop = await requireActiveShop(userId);
  const own = await db.select({ id: shopCategories.id, name: shopCategories.name }).from(shopCategories)
    .where(eq(shopCategories.shopId, shop.id)).orderBy(asc(shopCategories.position), asc(shopCategories.id));
  const { official, hidden } = await loadCategoryNames();
  const ownSlugs = new Set(own.map((c) => categorySlug(c.name)));
  const others = Array.from(official.entries())
    .filter(([slug]) => !ownSlugs.has(slug) && !hidden.has(slug))
    .map(([slug, name]) => ({ slug, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  return {
    own: own.map((c) => ({ id: c.id, name: c.name, slug: categorySlug(c.name), hidden: hidden.has(categorySlug(c.name)) })),
    others,
  };
}

/** Ajoute à SA boutique une catégorie déjà utilisée par d'autres boutiques (nom officiel). Idempotent. */
export async function adoptShopCategory(userId: number, input: { slug: string }) {
  const shop = await requireActiveShop(userId);
  const { official, hidden } = await loadCategoryNames();
  if (hidden.has(input.slug)) throw unavailableError();
  const name = official.get(input.slug);
  if (!name) throw notFoundError();
  const existing = await findDuplicate(shop.id, name);
  if (existing) return { id: existing.id, name: existing.name, slug: input.slug, created: false };
  const created = await createShopCategory(userId, { name });
  return { ...created, slug: input.slug, created: true, shopId: shop.id };
}

export async function createShopCategory(userId: number, input: { name: string }) {
  const db = await requireDb();
  const shop = await requireActiveShop(userId);
  const name = await resolveCategoryName(normalizeShopCategoryName(input.name));
  const existing = await findDuplicate(shop.id, name);
  if (existing) throw duplicateError(existing.name);
  const slug = await uniqueSlug(shop.id, name);
  const last = (await db.select({ value: sql<number | null>`MAX(${shopCategories.position})` }).from(shopCategories).where(eq(shopCategories.shopId, shop.id)))[0]?.value;
  try {
    const result = await db.insert(shopCategories).values({ shopId: shop.id, name, slug, position: Number(last ?? -1) + 1 });
    const id = Number((result as unknown as Array<{ insertId?: number }>)[0]?.insertId ?? 0);
    return { id, name, slug };
  } catch (error) {
    // Deux créations simultanées : l'index unique de la base tranche
    if (isDuplicateKey(error)) throw duplicateError(name);
    throw error;
  }
}

export async function renameShopCategory(userId: number, input: { categoryId: number; name: string }) {
  const db = await requireDb();
  const shop = await requireActiveShop(userId);
  const category = await requireOwnShopCategory(shop.id, input.categoryId);
  const name = await resolveCategoryName(normalizeShopCategoryName(input.name));
  const existing = await findDuplicate(shop.id, name, category.id);
  if (existing) throw duplicateError(existing.name);
  const slug = await uniqueSlug(shop.id, name, category.id);
  try {
    await db.update(shopCategories).set({ name, slug }).where(and(eq(shopCategories.id, category.id), eq(shopCategories.shopId, shop.id)));
  } catch (error) {
    if (isDuplicateKey(error)) throw duplicateError(name);
    throw error;
  }
  return { id: category.id, name, slug };
}

/** Supprime la catégorie ; ses produits passent à « Sans catégorie ». Aucun produit n'est supprimé. */
export async function deleteShopCategory(userId: number, input: { categoryId: number }) {
  const db = await requireDb();
  const shop = await requireActiveShop(userId);
  const category = await requireOwnShopCategory(shop.id, input.categoryId);
  const uncategorized = await db.transaction(async (tx) => {
    const [update] = await tx.update(products).set({ shopCategoryId: null })
      .where(and(eq(products.shopCategoryId, category.id), eq(products.shopId, shop.id))) as unknown as [{ affectedRows: number }];
    await tx.delete(shopCategories).where(and(eq(shopCategories.id, category.id), eq(shopCategories.shopId, shop.id)));
    return update?.affectedRows ?? 0;
  });
  return { success: true, uncategorized };
}

/** Nouvel ordre : la liste doit contenir exactement toutes les catégories de la boutique. */
export async function reorderShopCategories(userId: number, input: { orderedIds: number[] }) {
  const db = await requireDb();
  const shop = await requireActiveShop(userId);
  const own = await db.select({ id: shopCategories.id }).from(shopCategories).where(eq(shopCategories.shopId, shop.id));
  const ownIds = new Set(own.map((r) => r.id));
  const unique = new Set(input.orderedIds);
  if (unique.size !== input.orderedIds.length || unique.size !== ownIds.size || input.orderedIds.some((id) => !ownIds.has(id))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Ordre invalide : la liste doit contenir chacune de vos catégories une seule fois" });
  }
  await db.transaction(async (tx) => {
    for (let position = 0; position < input.orderedIds.length; position++) {
      await tx.update(shopCategories).set({ position }).where(and(eq(shopCategories.id, input.orderedIds[position]), eq(shopCategories.shopId, shop.id)));
    }
  });
  return { success: true };
}

// ===========================================================
// Administration des catégories partagées (aucun produit supprimé)
// ===========================================================

/** Catégories de boutiques (toutes boutiques) dont le slug de site est `slug`, regroupées par boutique. */
async function vendorRowsBySlug(slug: string) {
  const db = await requireDb();
  const rows = await db.select({ id: shopCategories.id, shopId: shopCategories.shopId, name: shopCategories.name, position: shopCategories.position }).from(shopCategories);
  const byShop = new Map<number, typeof rows>();
  for (const r of rows) {
    if (categorySlug(r.name) !== slug) continue;
    byShop.set(r.shopId, [...(byShop.get(r.shopId) ?? []), r].sort((a, b) => a.position - b.position || a.id - b.id));
  }
  return { rows, byShop };
}

/**
 * Renomme le nom affiché d'une catégorie du site chez TOUTES les boutiques qui l'utilisent.
 * Si le nouveau nom correspond à une autre catégorie existante, il faut fusionner.
 */
export async function adminRenameSiteCategory(input: { slug: string; name: string }) {
  const db = await requireDb();
  const name = normalizeShopCategoryName(input.name);
  const newSlug = categorySlug(name);
  const { official, hidden } = await loadCategoryNames();
  if (hidden.has(input.slug)) throw new TRPCError({ code: "BAD_REQUEST", message: "Réaffichez d'abord cette catégorie avant de la renommer." });
  if (newSlug !== input.slug && official.has(newSlug)) {
    throw new TRPCError({ code: "CONFLICT", message: `La catégorie « ${official.get(newSlug)} » existe déjà : utilisez « Fusionner ».` });
  }
  if (newSlug !== input.slug && hidden.has(newSlug)) throw unavailableError();
  const { byShop, rows } = await vendorRowsBySlug(input.slug);
  if (!byShop.size) throw new TRPCError({ code: "NOT_FOUND", message: "Aucune catégorie de boutique à renommer (catégorie globale : renommez-la dans « Catégories globales »)." });
  let renamed = 0;
  await db.transaction(async (tx) => {
    for (const [shopId, list] of Array.from(byShop.entries())) {
      const [keep, ...extra] = list;
      // Doublons historiques dans une même boutique : regroupés dans la première (produits déplacés, jamais supprimés)
      if (extra.length) {
        await tx.update(products).set({ shopCategoryId: keep.id }).where(and(eq(products.shopId, shopId), inArray(products.shopCategoryId, extra.map((e) => e.id))));
        await tx.delete(shopCategories).where(inArray(shopCategories.id, extra.map((e) => e.id)));
      }
      const taken = new Set(rows.filter((r) => r.shopId === shopId && r.id !== keep.id && !extra.some((e) => e.id === r.id)).map((r) => slugify(r.name)));
      let vendorSlug = slugify(name) || "categorie";
      for (let i = 2; taken.has(vendorSlug); i++) vendorSlug = `${slugify(name) || "categorie"}-${i}`;
      await tx.update(shopCategories).set({ name, slug: vendorSlug }).where(eq(shopCategories.id, keep.id));
      renamed++;
    }
  });
  return { slug: newSlug, name, shops: renamed };
}

/**
 * Fusionne la catégorie `sourceSlug` dans `targetSlug` (ex. « Déco murale » → « Décoration murale ») :
 * dans chaque boutique, les produits passent dans la catégorie cible (créée au besoin sous son nom officiel).
 * Aucun produit n'est supprimé ; seules les catégories de boutique devenues vides disparaissent.
 */
export async function adminMergeSiteCategories(input: { sourceSlug: string; targetSlug: string }) {
  const db = await requireDb();
  if (input.sourceSlug === input.targetSlug) throw new TRPCError({ code: "BAD_REQUEST", message: "Choisissez deux catégories différentes." });
  const { official, hidden } = await loadCategoryNames();
  const targetName = official.get(input.targetSlug);
  if (!targetName || hidden.has(input.targetSlug)) throw new TRPCError({ code: "BAD_REQUEST", message: "Catégorie cible introuvable ou masquée." });
  const { byShop: sourceByShop } = await vendorRowsBySlug(input.sourceSlug);
  if (!sourceByShop.size) throw new TRPCError({ code: "NOT_FOUND", message: "Aucune catégorie de boutique à fusionner (catégorie globale : gérez-la dans « Catégories globales »)." });
  const { byShop: targetByShop, rows } = await vendorRowsBySlug(input.targetSlug);
  let movedProducts = 0;
  await db.transaction(async (tx) => {
    for (const [shopId, sources] of Array.from(sourceByShop.entries())) {
      const target = targetByShop.get(shopId)?.[0];
      if (target) {
        const [moved] = await tx.update(products).set({ shopCategoryId: target.id })
          .where(and(eq(products.shopId, shopId), inArray(products.shopCategoryId, sources.map((s) => s.id)))) as unknown as [{ affectedRows: number }];
        movedProducts += moved?.affectedRows ?? 0;
        await tx.delete(shopCategories).where(inArray(shopCategories.id, sources.map((s) => s.id)));
      } else {
        // La boutique n'a pas encore la cible : sa catégorie source prend le nom officiel de la cible
        const [keep, ...extra] = sources;
        if (extra.length) {
          await tx.update(products).set({ shopCategoryId: keep.id }).where(and(eq(products.shopId, shopId), inArray(products.shopCategoryId, extra.map((e) => e.id))));
          await tx.delete(shopCategories).where(inArray(shopCategories.id, extra.map((e) => e.id)));
        }
        const taken = new Set(rows.filter((r) => r.shopId === shopId).map((r) => slugify(r.name)));
        let vendorSlug = slugify(targetName) || "categorie";
        for (let i = 2; taken.has(vendorSlug); i++) vendorSlug = `${slugify(targetName) || "categorie"}-${i}`;
        await tx.update(shopCategories).set({ name: targetName, slug: vendorSlug }).where(eq(shopCategories.id, keep.id));
        const [count] = await tx.select({ value: sql<number>`COUNT(*)` }).from(products).where(eq(products.shopCategoryId, keep.id));
        movedProducts += Number(count?.value ?? 0);
      }
    }
  });
  return { sourceSlug: input.sourceSlug, targetSlug: input.targetSlug, targetName, shops: sourceByShop.size, movedProducts };
}

/** Catégories publiques d'une boutique : uniquement celles qui contiennent au moins un produit publié. */
export async function listPublicShopCategories(shopId: number) {
  const db = await requireDb();
  const rows = await db.select({
    id: shopCategories.id, name: shopCategories.name, slug: shopCategories.slug,
    productCount: sql<number>`(SELECT COUNT(*) FROM products p WHERE p.shopCategoryId = shop_categories.id AND p.shopId = ${shopId} AND p.status = 'published')`,
  }).from(shopCategories).where(eq(shopCategories.shopId, shopId)).orderBy(asc(shopCategories.position), asc(shopCategories.id));
  return rows.map((r) => ({ ...r, productCount: Number(r.productCount) })).filter((r) => r.productCount > 0);
}

/** Noms des catégories de boutique, pour l'affichage admin. */
export async function shopCategoryNames(ids: number[]) {
  if (!ids.length) return new Map<number, string>();
  const db = await requireDb();
  const rows = await db.select({ id: shopCategories.id, name: shopCategories.name }).from(shopCategories).where(inArray(shopCategories.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}
