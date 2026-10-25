import { sql } from "drizzle-orm";
import { getCatalogProducts, getDb } from "./db";
import { listPublicCategories } from "./vendorCatalog";
import { listShopSiteCategories } from "./siteCategories";

/**
 * Données publiques de la page d'accueil, calculées uniquement à partir de la base :
 * produits publiés de boutiques validées, ventes réelles (commandes non annulées) et boutiques actives.
 * Aucune donnée de démonstration.
 */

export type PublicProductCard = {
  id: number;
  slug: string;
  name: string;
  shopName: string;
  shopSlug: string;
  shopLogoUrl: string | null;
  image: string;
  priceTnd: number;
  regularPriceTnd: number;
  promoPriceTnd: number | null;
  availability: "in_stock" | "made_to_order" | "out_of_stock";
  category: string;
  pricingMode: "fixed" | "per_m2" | "per_linear_m";
  rating: number | null;
  reviewCount: number;
};

async function rawRows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const db = await getDb();
  if (!db) return [];
  const result = (await db.execute(query)) as unknown as [T[], unknown];
  return result[0];
}

export async function getHomeData() {
  const [all, tree, shopCategories] = await Promise.all([getCatalogProducts(), listPublicCategories(), listShopSiteCategories()]);
  const cards: PublicProductCard[] = all.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    shopName: p.shopName,
    shopSlug: p.shopSlug,
    shopLogoUrl: p.shopLogoUrl ?? null,
    image: p.imageUrl,
    priceTnd: p.priceTnd,
    regularPriceTnd: p.regularPriceTnd,
    promoPriceTnd: p.promoPriceTnd,
    availability: p.availability,
    category: p.category,
    pricingMode: p.pricingMode,
    rating: p.rating,
    reviewCount: p.reviewCount,
  }));
  const bySlug = new Map(cards.map((c) => [c.slug, c]));

  // Populaires : quantités réellement commandées (commandes non annulées)
  const sold = await rawRows<{ slug: string; quantity: unknown }>(sql`
    SELECT p.slug AS slug, SUM(oi.quantity) AS quantity
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.orderId
    INNER JOIN products p ON p.id = oi.productId
    WHERE o.status <> 'cancelled' AND oi.fulfillmentStatus <> 'cancelled' AND p.status = 'published'
    GROUP BY p.slug ORDER BY quantity DESC LIMIT 8`);
  const popular = sold.map((s) => bySlug.get(s.slug)).filter((c): c is PublicProductCard => Boolean(c));

  // Catégories principales qui contiennent au moins un produit publié, avec une image réelle
  const categories = tree
    .map((main) => {
      const names = new Set([main.name, ...main.children.map((c) => c.name)]);
      const inCategory = cards.filter((c) => names.has(c.category));
      return {
        id: main.id,
        name: main.name,
        slug: main.slug,
        productCount: main.productCount + main.children.reduce((s, c) => s + c.productCount, 0),
        image: inCategory.find((c) => c.image)?.image ?? null,
        children: main.children.map((c) => ({ id: c.id, name: c.name, productCount: c.productCount })),
      };
    });

  // Boutiques validées avec au moins un produit publié
  const shopRows = await rawRows<{ id: number; name: string; slug: string; tagline: string | null; city: string | null; logoUrl: string | null; coverUrl: string | null; productCount: unknown; sales: unknown; rating: unknown; reviewCount: unknown; image: string | null }>(sql`
    SELECT s.id, s.name, s.slug, s.tagline, s.city, s.logoUrl, s.coverUrl,
      (SELECT COUNT(*) FROM products p WHERE p.shopId = s.id AND p.status = 'published') AS productCount,
      (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi INNER JOIN orders o ON o.id = oi.orderId WHERE oi.shopId = s.id AND o.status <> 'cancelled' AND oi.fulfillmentStatus <> 'cancelled') AS sales,
      (SELECT AVG(r.rating) FROM reviews r WHERE r.shopSlug = s.slug AND r.status = 'published') AS rating,
      (SELECT COUNT(*) FROM reviews r WHERE r.shopSlug = s.slug AND r.status = 'published') AS reviewCount,
      (SELECT p.imageUrl FROM products p WHERE p.shopId = s.id AND p.status = 'published' AND p.imageUrl <> '' ORDER BY p.createdAt DESC LIMIT 1) AS image
    FROM shops s
    WHERE s.status = 'active'
    ORDER BY sales DESC, productCount DESC, s.createdAt DESC`);
  const allShops = shopRows.map((s) => ({
    id: s.id,
    name: s.name,
    slug: s.slug,
    tagline: s.tagline,
    city: s.city,
    logoUrl: s.logoUrl,
    coverUrl: s.coverUrl,
    image: s.image,
    productCount: Number(s.productCount ?? 0),
    sales: Number(s.sales ?? 0),
    rating: s.rating == null ? null : Math.round(Number(s.rating) * 10) / 10,
    reviewCount: Number(s.reviewCount ?? 0),
    categories: (shopCategories.get(s.id) ?? []).slice(0, 3),
  }));
  const isCustom = (c: PublicProductCard) => c.pricingMode !== "fixed";

  return {
    newest: cards.slice(0, 8),
    // « Dernières créations » : les 8 plus récentes pour chaque filtre (Tout / Sur mesure / Promotions)
    latest: {
      all: cards.slice(0, 8),
      custom: cards.filter(isCustom).slice(0, 8),
      promo: cards.filter((c) => c.promoPriceTnd !== null).slice(0, 8),
    },
    // Exemple sur mesure du hero : la création sur mesure (avec photo) la plus récente
    customExample: cards.find((c) => isCustom(c) && c.image) ?? null,
    popular,
    promotions: cards.filter((c) => c.promoPriceTnd !== null).slice(0, 8),
    categories,
    shops: allShops.filter((s) => s.productCount > 0).slice(0, 8),
    allShops,
    totals: { products: cards.length, shops: allShops.filter((s) => s.productCount > 0).length, activeShops: allShops.length, customProducts: cards.filter(isCustom).length, categories: categories.filter((c) => c.productCount > 0).length },
  };
}
