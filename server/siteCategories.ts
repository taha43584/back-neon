import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import { categorySlug } from "@shared/categoryKey";
import { effectivePrice } from "@shared/productValidation";

/**
 * Catégories du site = catégories créées par les vendeurs (shop_categories) + anciennes catégories globales,
 * regroupées par categorySlug(nom) (shared/categoryKey.ts : minuscules, sans accents, espaces réduits).
 * Seuls comptent les produits PUBLIÉS de boutiques ACTIVES ; une catégorie masquée par l'admin n'apparaît pas.
 */

export type SiteCategory = {
  slug: string;
  name: string;
  image: string | null;
  productCount: number;
  shopCount: number;
  hidden: boolean;
};

type Row = { kind: "p" | "h"; name: string; productId: number | null; shopId: number | null; imageUrl: string | null; createdAt: Date | string | null };

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  return db;
}

/**
 * UNE seule requête : une ligne par couple (produit publié, nom de catégorie) pour les deux sources,
 * plus les slugs actuellement masqués (kind = 'h').
 */
async function loadCategoryRows(): Promise<Row[]> {
  const db = await requireDb();
  const result = (await db.execute(sql`
    SELECT 'p' AS kind, sc.name AS name, p.id AS productId, p.shopId AS shopId, p.imageUrl AS imageUrl, p.createdAt AS createdAt
      FROM products p
      INNER JOIN shops s ON s.id = p.shopId AND s.status = 'active'
      INNER JOIN shop_categories sc ON sc.id = p.shopCategoryId AND sc.shopId = p.shopId
      WHERE p.status = 'published'
    UNION ALL
    SELECT 'p', c.name, p.id, p.shopId, p.imageUrl, p.createdAt
      FROM products p
      INNER JOIN shops s ON s.id = p.shopId AND s.status = 'active'
      INNER JOIN categories c ON c.id = p.categoryId AND c.status = 'approved' AND c.active = 1
      WHERE p.status = 'published'
    UNION ALL
    SELECT 'h', h.slug, NULL, NULL, NULL, NULL FROM hidden_site_categories h WHERE h.hidden = 1
  `)) as unknown as [Row[], unknown];
  return result[0];
}

type Group = { slug: string; variants: Map<string, Set<number>>; products: Set<number>; shops: Set<number>; image: string | null; imageAt: number };

/** Regroupe les lignes par slug (fonction de normalisation partagée). */
function aggregate(rows: Row[]) {
  const hidden = new Set(rows.filter((r) => r.kind === "h").map((r) => r.name));
  const groups = new Map<string, Group>();
  for (const row of rows) {
    if (row.kind !== "p" || row.productId == null || row.shopId == null) continue;
    const slug = categorySlug(row.name);
    const g = groups.get(slug) ?? { slug, variants: new Map(), products: new Set(), shops: new Set(), image: null, imageAt: -Infinity };
    const variant = row.name.replace(/\s+/g, " ").trim();
    g.variants.set(variant, (g.variants.get(variant) ?? new Set()).add(Number(row.productId)));
    g.products.add(Number(row.productId));
    g.shops.add(Number(row.shopId));
    // Photo : celle du produit publié le plus récent qui en a une
    const at = row.createdAt ? new Date(row.createdAt).getTime() : 0;
    if (row.imageUrl && at > g.imageAt) {
      g.image = row.imageUrl;
      g.imageAt = at;
    }
    groups.set(slug, g);
  }
  return { hidden, groups };
}

/** Nom affiché : la variante utilisée par le plus de produits (égalité : ordre alphabétique). */
function displayName(g: Group) {
  return Array.from(g.variants.entries()).sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0], "fr"))[0][0];
}

function toCategory(g: Group, hidden: boolean): SiteCategory {
  return { slug: g.slug, name: displayName(g), image: g.image, productCount: g.products.size, shopCount: g.shops.size, hidden };
}

const byProductCount = (a: SiteCategory, b: SiteCategory) => b.productCount - a.productCount || a.name.localeCompare(b.name, "fr");

/** Catégories publiques du site (accueil, menu), triées par nombre de créations. */
export async function listSiteCategories(): Promise<SiteCategory[]> {
  const { hidden, groups } = aggregate(await loadCategoryRows());
  return Array.from(groups.values()).filter((g) => !hidden.has(g.slug)).map((g) => toCategory(g, false)).sort(byProductCount);
}

/**
 * Catégories publiques de chaque boutique active (mêmes règles que listSiteCategories : produits publiés,
 * catégories masquées exclues, nom affiché commun), triées par nombre de créations de la boutique.
 */
export async function listShopSiteCategories(): Promise<Map<number, Array<{ slug: string; name: string }>>> {
  const rows = await loadCategoryRows();
  const { hidden, groups } = aggregate(rows);
  const perShop = new Map<number, Map<string, number>>();
  for (const row of rows) {
    if (row.kind !== "p" || row.shopId == null) continue;
    const slug = categorySlug(row.name);
    if (hidden.has(slug)) continue;
    const counts = perShop.get(Number(row.shopId)) ?? new Map<string, number>();
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
    perShop.set(Number(row.shopId), counts);
  }
  const result = new Map<number, Array<{ slug: string; name: string }>>();
  for (const [shopId, counts] of Array.from(perShop.entries())) {
    result.set(shopId, Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([slug]) => ({ slug, name: displayName(groups.get(slug)!) })));
  }
  return result;
}

// ===========================================================
// Noms des catégories partagées entre vendeurs
// ===========================================================

/**
 * Tous les NOMS de catégories du site (catégories des boutiques actives + catégories globales validées),
 * même sans produit publié, regroupés par slug, avec le nom officiel (variante la plus utilisée par les boutiques)
 * et les slugs masqués. UNE requête ; ne renvoie jamais de produit ni de statistique.
 */
export async function loadCategoryNames() {
  const db = await requireDb();
  const result = (await db.execute(sql`
    SELECT 'n' AS kind, sc.name AS name FROM shop_categories sc INNER JOIN shops s ON s.id = sc.shopId AND s.status = 'active'
    UNION ALL
    SELECT 'n', c.name FROM categories c WHERE c.status = 'approved' AND c.active = 1
    UNION ALL
    SELECT 'h', h.slug FROM hidden_site_categories h WHERE h.hidden = 1
  `)) as unknown as [Array<{ kind: "n" | "h"; name: string }>, unknown];
  const hidden = new Set<string>();
  const variants = new Map<string, Map<string, number>>();
  for (const row of result[0]) {
    if (row.kind === "h") { hidden.add(row.name); continue; }
    const slug = categorySlug(row.name);
    const variant = row.name.replace(/\s+/g, " ").trim();
    const map = variants.get(slug) ?? new Map<string, number>();
    map.set(variant, (map.get(variant) ?? 0) + 1);
    variants.set(slug, map);
  }
  const official = new Map<string, string>();
  for (const [slug, map] of Array.from(variants.entries())) {
    official.set(slug, Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fr"))[0][0]);
  }
  return { official, hidden };
}

// ===========================================================
// Page /categorie/<slug>
// ===========================================================

export type CategoryPageFilters = {
  custom?: boolean;
  promo?: boolean;
  minPrice?: number;
  maxPrice?: number;
  shops?: string[];
  sort?: "recent" | "price_asc" | "price_desc";
};

type CardRow = {
  id: number; slug: string; name: string; imageUrl: string; priceTnd: string; promoPriceTnd: string | null; availability: "in_stock" | "made_to_order" | "out_of_stock";
  stock: number | null; pricingMode: "fixed" | "per_m2" | "per_linear_m"; unitPriceTnd: string | null; promoPercent: string | null; createdAt: Date | string;
  shopId: number; shopName: string; shopSlug: string; shopLogoUrl: string | null;
};

/** Produits d'une catégorie du site (toutes boutiques), avec filtres et tri calculés côté serveur. */
export async function getCategoryPage(slug: string, filters: CategoryPageFilters = {}) {
  const { hidden, groups } = aggregate(await loadCategoryRows());
  const group = groups.get(slug);
  if (!group || hidden.has(slug)) throw new TRPCError({ code: "NOT_FOUND", message: "Catégorie introuvable" });

  const db = await requireDb();
  const ids = Array.from(group.products);
  const result = (await db.execute(sql`
    SELECT p.id, p.slug, p.name, p.imageUrl, p.priceTnd, p.promoPriceTnd, p.availability, p.stock, p.pricingMode, p.unitPriceTnd, p.promoPercent, p.createdAt,
           s.id AS shopId, s.name AS shopName, s.slug AS shopSlug, s.logoUrl AS shopLogoUrl
      FROM products p INNER JOIN shops s ON s.id = p.shopId AND s.status = 'active'
      WHERE p.status = 'published' AND p.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `)) as unknown as [CardRow[], unknown];

  const all = result[0].map((r) => {
    const custom = r.pricingMode !== "fixed";
    const regular = Number(custom ? r.unitPriceTnd ?? r.priceTnd : r.priceTnd);
    const promoPercent = custom && r.promoPercent != null ? Number(r.promoPercent) : null;
    const promo = custom
      ? (promoPercent ? Math.round(regular * (100 - promoPercent)) / 100 : null)
      : (r.promoPriceTnd == null ? null : Number(r.promoPriceTnd));
    const price = effectivePrice(regular, promo);
    return {
      id: Number(r.id), slug: r.slug, name: r.name, image: r.imageUrl, createdAt: new Date(r.createdAt).toISOString(),
      priceTnd: price, regularPriceTnd: regular, promoPriceTnd: price < regular ? price : null,
      availability: r.availability === "in_stock" && r.stock === 0 ? "out_of_stock" as const : r.availability,
      pricingMode: r.pricingMode, shopName: r.shopName, shopSlug: r.shopSlug, shopLogoUrl: r.shopLogoUrl,
    };
  });

  // Facettes (sur l'ensemble de la catégorie, avant filtres)
  const shopFacets = new Map<string, { slug: string; name: string; count: number }>();
  for (const p of all) {
    const f = shopFacets.get(p.shopSlug) ?? { slug: p.shopSlug, name: p.shopName, count: 0 };
    f.count++;
    shopFacets.set(p.shopSlug, f);
  }
  const prices = all.map((p) => p.priceTnd);

  const shopsFilter = new Set(filters.shops ?? []);
  let products = all.filter((p) =>
    (!filters.custom || p.pricingMode !== "fixed") &&
    (!filters.promo || p.promoPriceTnd !== null) &&
    (filters.minPrice === undefined || p.priceTnd >= filters.minPrice) &&
    (filters.maxPrice === undefined || p.priceTnd <= filters.maxPrice) &&
    (!shopsFilter.size || shopsFilter.has(p.shopSlug)));
  const sort = filters.sort ?? "recent";
  products = products.sort((a, b) =>
    sort === "price_asc" ? a.priceTnd - b.priceTnd || b.createdAt.localeCompare(a.createdAt)
      : sort === "price_desc" ? b.priceTnd - a.priceTnd || b.createdAt.localeCompare(a.createdAt)
        : b.createdAt.localeCompare(a.createdAt));

  return {
    category: toCategory(group, false),
    products,
    facets: {
      shops: Array.from(shopFacets.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "fr")),
      customCount: all.filter((p) => p.pricingMode !== "fixed").length,
      promoCount: all.filter((p) => p.promoPriceTnd !== null).length,
      minPrice: prices.length ? Math.min(...prices) : 0,
      maxPrice: prices.length ? Math.max(...prices) : 0,
      total: all.length,
    },
  };
}

// ===========================================================
// Administration : masquer / réafficher (aucune suppression)
// ===========================================================

/** Toutes les catégories du site (masquées comprises) avec leurs compteurs, pour l'admin. */
export async function adminListSiteCategories() {
  const db = await requireDb();
  const { groups } = aggregate(await loadCategoryRows());
  const records = (await db.execute(sql`SELECT h.slug, h.label, h.hidden, h.reason, h.hiddenAt, u.name AS hiddenByName, u.email AS hiddenByEmail
    FROM hidden_site_categories h LEFT JOIN users u ON u.id = h.hiddenByUserId`)) as unknown as [Array<{ slug: string; label: string; hidden: number; reason: string | null; hiddenAt: Date; hiddenByName: string | null; hiddenByEmail: string | null }>, unknown];
  const bySlug = new Map(records[0].map((r) => [r.slug, r]));
  const list = Array.from(groups.values()).map((g) => {
    const rec = bySlug.get(g.slug);
    return { ...toCategory(g, Boolean(rec?.hidden)), reason: rec?.reason ?? null, hiddenAt: rec?.hiddenAt ?? null, hiddenBy: rec?.hiddenByName || rec?.hiddenByEmail || null };
  });
  // Catégories masquées qui n'ont plus de produit publié : toujours listées (pour pouvoir les réafficher)
  for (const rec of records[0]) {
    if (rec.hidden && !groups.has(rec.slug)) {
      list.push({ slug: rec.slug, name: rec.label, image: null, productCount: 0, shopCount: 0, hidden: true, reason: rec.reason, hiddenAt: rec.hiddenAt, hiddenBy: rec.hiddenByName || rec.hiddenByEmail || null });
    }
  }
  return list.sort((a, b) => Number(b.hidden) - Number(a.hidden) || byProductCount(a, b));
}

/** Masque ou réaffiche une catégorie du site (clé = categorySlug) ; enregistre l'admin, le motif et la date. */
export async function setSiteCategoryHidden(input: { slug: string; hidden: boolean; reason?: string | null; label?: string | null }, adminUserId: number) {
  const db = await requireDb();
  const slug = input.slug.trim();
  if (categorySlug(slug) !== slug) throw new TRPCError({ code: "BAD_REQUEST", message: "Catégorie invalide" });
  const { groups } = aggregate(await loadCategoryRows());
  const existing = (await db.execute(sql`SELECT label FROM hidden_site_categories WHERE slug = ${slug}`)) as unknown as [Array<{ label: string }>, unknown];
  const group = groups.get(slug);
  if (!group && !existing[0].length) throw new TRPCError({ code: "NOT_FOUND", message: "Catégorie introuvable" });
  const label = (group ? displayName(group) : existing[0][0].label).slice(0, 120);
  const reason = input.reason?.trim().slice(0, 255) || null;
  await db.execute(sql`
    INSERT INTO hidden_site_categories (slug, label, hidden, reason, hiddenByUserId, hiddenAt)
    VALUES (${slug}, ${label}, ${input.hidden ? 1 : 0}, ${reason}, ${adminUserId}, NOW())
    ON DUPLICATE KEY UPDATE label = VALUES(label), hidden = VALUES(hidden), reason = VALUES(reason), hiddenByUserId = VALUES(hiddenByUserId), hiddenAt = NOW()
  `);
  return { slug, hidden: input.hidden };
}
