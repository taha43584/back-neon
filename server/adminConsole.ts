import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { addresses, cartItems, categories, commissions, favoriteProducts, media, orderItems, orderStatusHistory, orders, products, reviews, shopCategories, shops, users } from "../drizzle/schema";
import { getDb, withCustomSummary } from "./db";
import { deleteStoredFile, mediaUrl } from "./mediaStorage";

/**
 * Console d'administration : lectures paginées et actions de modération.
 * Toutes ces fonctions sont appelées uniquement depuis des procédures `adminProcedure`
 * (rôle admin vérifié côté serveur). Aucune ne renvoie de hash de mot de passe ni d'openId.
 */

export const PAGE_SIZE = 20;

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  return db;
}

/** Exécute une requête SQL brute et renvoie ses lignes. */
async function rawRows<T>(query: SQL): Promise<T[]> {
  const db = await requireDb();
  const result = (await db.execute(query)) as unknown as [T[], unknown];
  return result[0];
}

const num = (value: unknown) => Number(value ?? 0);
const money = (value: unknown) => Math.round(Number(value ?? 0) * 100) / 100;
const like = (search: string) => `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
export const orderReference = (id: number) => `ED-${String(id).padStart(6, "0")}`;

function pageOf(page: number | undefined) {
  const p = Math.max(1, Math.floor(page ?? 1));
  return { page: p, offset: (p - 1) * PAGE_SIZE };
}

function paged<T>(items: T[], total: number, page: number) {
  return { items, total, page, pageSize: PAGE_SIZE, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

/** Données publiques d'un compte (jamais de hash ni d'openId). */
const safeUserColumns = {
  id: users.id,
  name: users.name,
  firstName: users.firstName,
  lastName: users.lastName,
  email: users.email,
  phone: users.phone,
  city: users.city,
  address: users.address,
  role: users.role,
  suspended: users.suspended,
  loginMethod: users.loginMethod,
  createdAt: users.createdAt,
  lastSignedIn: users.lastSignedIn,
};

// ===========================================================
// Vue générale
// ===========================================================

export async function adminOverview() {
  const db = await requireDb();
  const [counts] = await rawRows<Record<string, unknown>>(sql`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'user') AS customers,
      (SELECT COUNT(*) FROM users WHERE role = 'vendor') AS vendors,
      (SELECT COUNT(*) FROM shops WHERE status = 'pending') AS pendingShops,
      (SELECT COUNT(*) FROM shops WHERE status = 'active') AS activeShops,
      (SELECT COUNT(*) FROM shops WHERE status = 'suspended') AS suspendedShops,
      (SELECT COUNT(*) FROM shops WHERE status = 'rejected') AS rejectedShops,
      (SELECT COUNT(*) FROM products) AS products,
      (SELECT COUNT(*) FROM products WHERE status = 'published') AS publishedProducts,
      (SELECT COUNT(*) FROM products WHERE status = 'pending') AS pendingProducts,
      (SELECT COUNT(*) FROM orders) AS orders,
      (SELECT COUNT(*) FROM orders WHERE status = 'pending') AS pendingOrders,
      (SELECT COALESCE(SUM(totalTnd), 0) FROM orders WHERE status <> 'cancelled') AS revenue,
      (SELECT COALESCE(SUM(totalTnd), 0) FROM orders WHERE status = 'delivered') AS deliveredRevenue,
      (SELECT COALESCE(SUM(commissionTnd), 0) FROM commissions WHERE status <> 'refunded') AS commission,
      (SELECT COUNT(*) FROM reviews WHERE status = 'pending') AS pendingReviews,
      (SELECT COUNT(*) FROM categories WHERE status = 'pending') AS pendingCategories
  `);

  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 29);
  const daily = await rawRows<{ day: string; orders: unknown; revenue: unknown }>(sql`
    SELECT DATE_FORMAT(createdAt, '%Y-%m-%d') AS day, COUNT(*) AS orders,
           COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN totalTnd ELSE 0 END), 0) AS revenue
    FROM orders WHERE createdAt >= ${since} GROUP BY day ORDER BY day`);
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const series = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(since);
    d.setDate(since.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const row = byDay.get(key);
    return { date: key, orders: num(row?.orders), revenue: money(row?.revenue) };
  });

  const [latestOrders, latestSignups, vendorRequests] = await Promise.all([
    db.select({ id: orders.id, totalTnd: orders.totalTnd, status: orders.status, createdAt: orders.createdAt, shippingName: orders.shippingName, shippingCity: orders.shippingCity, clientEmail: users.email })
      .from(orders).leftJoin(users, eq(orders.userId, users.id)).orderBy(desc(orders.createdAt)).limit(6),
    db.select({ id: users.id, name: users.name, email: users.email, role: users.role, createdAt: users.createdAt })
      .from(users).orderBy(desc(users.createdAt)).limit(6),
    db.select({ id: shops.id, name: shops.name, city: shops.city, createdAt: shops.createdAt, ownerName: users.name, ownerEmail: users.email })
      .from(shops).leftJoin(users, eq(shops.userId, users.id)).where(eq(shops.status, "pending")).orderBy(desc(shops.createdAt)).limit(6),
  ]);

  return {
    stats: {
      customers: num(counts.customers),
      vendors: num(counts.vendors),
      pendingShops: num(counts.pendingShops),
      activeShops: num(counts.activeShops),
      suspendedShops: num(counts.suspendedShops),
      rejectedShops: num(counts.rejectedShops),
      products: num(counts.products),
      publishedProducts: num(counts.publishedProducts),
      pendingProducts: num(counts.pendingProducts),
      orders: num(counts.orders),
      pendingOrders: num(counts.pendingOrders),
      revenueTnd: money(counts.revenue),
      deliveredRevenueTnd: money(counts.deliveredRevenue),
      commissionTnd: money(counts.commission),
      pendingReviews: num(counts.pendingReviews),
      pendingCategories: num(counts.pendingCategories),
    },
    series,
    latestOrders: latestOrders.map((o) => ({ ...o, reference: orderReference(o.id), totalTnd: money(o.totalTnd) })),
    latestSignups,
    vendorRequests,
  };
}

// ===========================================================
// Clients
// ===========================================================

export async function adminListClients(input: { search?: string; status?: "all" | "active" | "suspended"; page?: number }) {
  const db = await requireDb();
  const { page, offset } = pageOf(input.page);
  const conditions: SQL[] = [eq(users.role, "user")];
  if (input.status === "active") conditions.push(eq(users.suspended, 0));
  if (input.status === "suspended") conditions.push(eq(users.suspended, 1));
  const search = input.search?.trim();
  if (search) {
    const pattern = like(search);
    conditions.push(sql`(${users.name} LIKE ${pattern} OR ${users.firstName} LIKE ${pattern} OR ${users.lastName} LIKE ${pattern} OR ${users.email} LIKE ${pattern} OR ${users.phone} LIKE ${pattern})`);
  }
  const where = and(...conditions);
  const [rows, totalRow] = await Promise.all([
    db.select({
      ...safeUserColumns,
      orderCount: sql<number>`(SELECT COUNT(*) FROM orders o WHERE o.userId = users.id)`,
      totalSpent: sql<string>`(SELECT COALESCE(SUM(o.totalTnd), 0) FROM orders o WHERE o.userId = users.id AND o.status <> 'cancelled')`,
    }).from(users).where(where).orderBy(desc(users.createdAt)).limit(PAGE_SIZE).offset(offset),
    db.select({ value: count() }).from(users).where(where),
  ]);
  return paged(rows.map((r) => ({ ...r, orderCount: num(r.orderCount), totalSpent: money(r.totalSpent) })), num(totalRow[0]?.value), page);
}

export async function adminClientDetail(userId: number) {
  const db = await requireDb();
  const user = (await db.select(safeUserColumns).from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!user) throw new Error("Compte introuvable");
  const [addressRows, orderRows] = await Promise.all([
    db.select().from(addresses).where(eq(addresses.userId, userId)).orderBy(desc(addresses.isDefault)),
    db.select({
      id: orders.id, totalTnd: orders.totalTnd, status: orders.status, createdAt: orders.createdAt, shippingCity: orders.shippingCity,
      itemCount: sql<number>`(SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.orderId = orders.id)`,
    }).from(orders).where(eq(orders.userId, userId)).orderBy(desc(orders.createdAt)).limit(100),
  ]);
  const valid = orderRows.filter((o) => o.status !== "cancelled");
  return {
    user,
    addresses: addressRows,
    orders: orderRows.map((o) => ({ ...o, reference: orderReference(o.id), totalTnd: money(o.totalTnd), itemCount: num(o.itemCount) })),
    stats: { orderCount: orderRows.length, totalSpent: money(valid.reduce((s, o) => s + Number(o.totalTnd), 0)) },
  };
}

// ===========================================================
// Vendeurs
// ===========================================================

type ShopStatus = "pending" | "active" | "suspended" | "rejected";

export async function adminListVendors(input: { status?: ShopStatus | "all"; search?: string; page?: number }) {
  const db = await requireDb();
  const { page, offset } = pageOf(input.page);
  const conditions: SQL[] = [];
  if (input.status && input.status !== "all") conditions.push(eq(shops.status, input.status));
  const search = input.search?.trim();
  if (search) {
    const pattern = like(search);
    conditions.push(sql`(${shops.name} LIKE ${pattern} OR ${users.name} LIKE ${pattern} OR ${users.email} LIKE ${pattern} OR ${shops.whatsapp} LIKE ${pattern} OR ${users.phone} LIKE ${pattern})`);
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const [rows, totalRow, statusCounts] = await Promise.all([
    db.select({
      id: shops.id, name: shops.name, slug: shops.slug, status: shops.status, city: shops.city, whatsapp: shops.whatsapp, phone: shops.phone,
      logoUrl: shops.logoUrl, rejectionReason: shops.rejectionReason, termsAccepted: shops.termsAccepted, termsVersion: shops.termsVersion,
      termsAcceptedAt: shops.termsAcceptedAt, createdAt: shops.createdAt,
      userId: users.id, ownerName: users.name, ownerFirstName: users.firstName, ownerLastName: users.lastName, ownerEmail: users.email, ownerPhone: users.phone, ownerSuspended: users.suspended,
      productCount: sql<number>`(SELECT COUNT(*) FROM products p WHERE p.shopId = shops.id)`,
      publishedCount: sql<number>`(SELECT COUNT(*) FROM products p WHERE p.shopId = shops.id AND p.status = 'published')`,
      orderCount: sql<number>`(SELECT COUNT(DISTINCT oi.orderId) FROM order_items oi WHERE oi.shopId = shops.id)`,
    }).from(shops).leftJoin(users, eq(shops.userId, users.id)).where(where).orderBy(desc(shops.createdAt)).limit(PAGE_SIZE).offset(offset),
    db.select({ value: count() }).from(shops).leftJoin(users, eq(shops.userId, users.id)).where(where),
    db.select({ status: shops.status, value: count() }).from(shops).groupBy(shops.status),
  ]);
  const counts = { all: 0, pending: 0, active: 0, suspended: 0, rejected: 0 } as Record<ShopStatus | "all", number>;
  for (const row of statusCounts) {
    counts[row.status] = num(row.value);
    counts.all += num(row.value);
  }
  return {
    ...paged(rows.map((r) => ({ ...r, productCount: num(r.productCount), publishedCount: num(r.publishedCount), orderCount: num(r.orderCount) })), num(totalRow[0]?.value), page),
    counts,
  };
}

/** Liste courte des boutiques pour les filtres (produits, commandes). */
export async function adminShopOptions() {
  const db = await requireDb();
  return db.select({ id: shops.id, name: shops.name, status: shops.status }).from(shops).orderBy(asc(shops.name));
}

export async function adminVendorDetail(shopId: number) {
  const db = await requireDb();
  const shop = (await db.select().from(shops).where(eq(shops.id, shopId)).limit(1))[0];
  if (!shop) throw new Error("Boutique introuvable");
  const owner = (await db.select(safeUserColumns).from(users).where(eq(users.id, shop.userId)).limit(1))[0] ?? null;
  const [productRows, orderRows, totals] = await Promise.all([
    db.select({ id: products.id, name: products.name, slug: products.slug, status: products.status, priceTnd: products.priceTnd, promoPriceTnd: products.promoPriceTnd, stock: products.stock, imageUrl: products.imageUrl, category: products.category, createdAt: products.createdAt })
      .from(products).where(eq(products.shopId, shopId)).orderBy(desc(products.createdAt)).limit(100),
    rawRows<{ orderId: number; createdAt: Date; orderStatus: string; shopStatus: string; quantity: unknown; amount: unknown; shippingCity: string }>(sql`
      SELECT o.id AS orderId, o.createdAt, o.status AS orderStatus, MIN(oi.fulfillmentStatus) AS shopStatus,
             SUM(oi.quantity) AS quantity, SUM(oi.quantity * oi.unitPriceTnd) AS amount, o.shippingCity
      FROM order_items oi INNER JOIN orders o ON o.id = oi.orderId
      WHERE oi.shopId = ${shopId}
      GROUP BY o.id, o.createdAt, o.status, o.shippingCity
      ORDER BY o.createdAt DESC LIMIT 100`),
    rawRows<{ revenue: unknown; commission: unknown; units: unknown }>(sql`
      SELECT
        (SELECT COALESCE(SUM(oi.quantity * oi.unitPriceTnd), 0) FROM order_items oi WHERE oi.shopId = ${shopId} AND oi.fulfillmentStatus <> 'cancelled') AS revenue,
        (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.shopId = ${shopId} AND oi.fulfillmentStatus <> 'cancelled') AS units,
        (SELECT COALESCE(SUM(c.commissionTnd), 0) FROM commissions c WHERE c.shopId = ${shopId} AND c.status <> 'refunded') AS commission`),
  ]);
  return {
    shop,
    owner,
    products: productRows.map((p) => ({ ...p, priceTnd: money(p.priceTnd), promoPriceTnd: p.promoPriceTnd == null ? null : money(p.promoPriceTnd) })),
    orders: orderRows.map((o) => ({ ...o, reference: orderReference(o.orderId), quantity: num(o.quantity), amount: money(o.amount) })),
    stats: {
      productCount: productRows.length,
      publishedCount: productRows.filter((p) => p.status === "published").length,
      orderCount: orderRows.length,
      revenueTnd: money(totals[0]?.revenue),
      unitsSold: num(totals[0]?.units),
      commissionTnd: money(totals[0]?.commission),
    },
  };
}

// ===========================================================
// Produits
// ===========================================================

type ProductStatus = "draft" | "pending" | "published" | "rejected";

export async function adminListProducts(input: { search?: string; shopId?: number; categoryId?: number; status?: ProductStatus | "all"; minPrice?: number; maxPrice?: number; page?: number }) {
  const db = await requireDb();
  const { page, offset } = pageOf(input.page);
  const conditions: SQL[] = [];
  const search = input.search?.trim();
  if (search) conditions.push(sql`(${products.name} LIKE ${like(search)} OR ${products.sku} LIKE ${like(search)})`);
  if (input.shopId) conditions.push(eq(products.shopId, input.shopId));
  // Une catégorie principale inclut ses sous-catégories
  if (input.categoryId) conditions.push(sql`(${products.categoryId} = ${input.categoryId} OR ${products.categoryId} IN (SELECT c.id FROM categories c WHERE c.parentId = ${input.categoryId}))`);
  if (input.status && input.status !== "all") conditions.push(eq(products.status, input.status));
  if (input.minPrice !== undefined) conditions.push(sql`${products.priceTnd} >= ${input.minPrice}`);
  if (input.maxPrice !== undefined) conditions.push(sql`${products.priceTnd} <= ${input.maxPrice}`);
  const where = conditions.length ? and(...conditions) : undefined;

  const [rows, totalRow, statusCounts] = await Promise.all([
    db.select({
      id: products.id, name: products.name, slug: products.slug, imageUrl: products.imageUrl, status: products.status,
      priceTnd: products.priceTnd, promoPriceTnd: products.promoPriceTnd, stock: products.stock, availability: products.availability,
      category: products.category, categoryId: products.categoryId, moderationNote: products.moderationNote, createdAt: products.createdAt,
      shopCategoryName: shopCategories.name,
      shopId: shops.id, shopName: shops.name, shopSlug: shops.slug, shopStatus: shops.status,
    }).from(products).leftJoin(shops, eq(products.shopId, shops.id)).leftJoin(shopCategories, eq(products.shopCategoryId, shopCategories.id)).where(where).orderBy(desc(products.createdAt)).limit(PAGE_SIZE).offset(offset),
    db.select({ value: count() }).from(products).where(where),
    db.select({ status: products.status, value: count() }).from(products).groupBy(products.status),
  ]);
  const counts = { all: 0, draft: 0, pending: 0, published: 0, rejected: 0 } as Record<ProductStatus | "all", number>;
  for (const row of statusCounts) {
    counts[row.status] = num(row.value);
    counts.all += num(row.value);
  }
  return {
    ...paged(rows.map((r) => ({ ...r, priceTnd: money(r.priceTnd), promoPriceTnd: r.promoPriceTnd == null ? null : money(r.promoPriceTnd) })), num(totalRow[0]?.value), page),
    counts,
  };
}

export async function adminProductDetail(productId: number) {
  const db = await requireDb();
  const product = (await db.select().from(products).where(eq(products.id, productId)).limit(1))[0];
  if (!product) throw new Error("Produit introuvable");
  const [shop, files, orderCount, shopCategory] = await Promise.all([
    db.select({ id: shops.id, name: shops.name, slug: shops.slug, status: shops.status, ownerEmail: users.email, ownerName: users.name })
      .from(shops).leftJoin(users, eq(shops.userId, users.id)).where(eq(shops.id, product.shopId)).limit(1),
    db.select().from(media).where(eq(media.productId, productId)).orderBy(desc(media.isPrimary), asc(media.position)),
    db.select({ value: sql<number>`COUNT(DISTINCT ${orderItems.orderId})` }).from(orderItems).where(eq(orderItems.productId, productId)),
    product.shopCategoryId ? db.select({ name: shopCategories.name }).from(shopCategories).where(eq(shopCategories.id, product.shopCategoryId)).limit(1) : Promise.resolve([]),
  ]);
  return {
    product: { ...product, shopCategoryName: shopCategory[0]?.name ?? null, priceTnd: money(product.priceTnd), promoPriceTnd: product.promoPriceTnd == null ? null : money(product.promoPriceTnd) },
    shop: shop[0] ?? null,
    images: files.filter((f) => f.kind === "image").map((f) => ({ id: f.id, url: mediaUrl(f.storageKey), isPrimary: Boolean(f.isPrimary) })),
    video: files.filter((f) => f.kind === "video").map((f) => ({ url: mediaUrl(f.storageKey), mimeType: f.mimeType }))[0] ?? null,
    orderCount: num(orderCount[0]?.value),
  };
}

/**
 * Attribue (ou retire avec null) la catégorie globale du site, utilisée pour la navigation.
 * N'affecte pas la catégorie choisie par le vendeur dans sa boutique.
 */
export async function adminSetProductCategory(input: { productId: number; categoryId: number | null }) {
  const db = await requireDb();
  const product = (await db.select({ id: products.id }).from(products).where(eq(products.id, input.productId)).limit(1))[0];
  if (!product) throw new Error("Produit introuvable");
  if (input.categoryId === null) {
    // Le libellé historique `category` est NOT NULL : chaîne vide = aucune catégorie globale
    await db.update(products).set({ categoryId: null, category: "" }).where(eq(products.id, product.id));
    return { success: true, categoryId: null, category: "" };
  }
  const category = (await db.select().from(categories).where(eq(categories.id, input.categoryId)).limit(1))[0];
  if (!category || category.status !== "approved") throw new Error("Catégorie introuvable ou non validée");
  await db.update(products).set({ categoryId: category.id, category: category.name }).where(eq(products.id, product.id));
  return { success: true, categoryId: category.id, category: category.name };
}

/** Publier, dépublier, refuser (motif obligatoire) un produit. */
export async function adminSetProductStatus(input: { productId: number; action: "publish" | "unpublish" | "reject"; reason?: string }) {
  const db = await requireDb();
  const product = (await db.select().from(products).where(eq(products.id, input.productId)).limit(1))[0];
  if (!product) throw new Error("Produit introuvable");
  if (input.action === "publish") {
    if (!product.imageUrl) throw new Error("Ce produit n'a pas de photo : il ne peut pas être publié");
    // La catégorie globale est facultative ; si elle est renseignée, elle doit être validée
    const category = product.categoryId ? (await db.select().from(categories).where(eq(categories.id, product.categoryId)).limit(1))[0] : undefined;
    if (category && category.status !== "approved") throw new Error("La catégorie de ce produit n'est pas validée : validez-la d'abord dans « Catégories »");
    await db.update(products).set({ status: "published", moderationNote: null }).where(eq(products.id, product.id));
    return { success: true, status: "published" as const };
  }
  if (input.action === "reject") {
    const reason = input.reason?.trim() ?? "";
    if (reason.length < 3) throw new Error("Indiquez le motif du refus (au moins 3 caractères)");
    await db.update(products).set({ status: "rejected", moderationNote: reason }).where(eq(products.id, product.id));
    return { success: true, status: "rejected" as const };
  }
  await db.update(products).set({ status: "draft", moderationNote: input.reason?.trim() || null }).where(eq(products.id, product.id));
  return { success: true, status: "draft" as const };
}

/**
 * Suppression définitive d'un produit. Les commandes passées conservent leur copie
 * (nom, prix, boutique) : la référence au produit y est simplement détachée.
 */
export async function adminDeleteProduct(productId: number) {
  const db = await requireDb();
  const product = (await db.select({ id: products.id }).from(products).where(eq(products.id, productId)).limit(1))[0];
  if (!product) throw new Error("Produit introuvable");
  const files = await db.select({ id: media.id, storageKey: media.storageKey }).from(media).where(eq(media.productId, productId));
  await db.transaction(async (tx) => {
    await tx.update(orderItems).set({ productId: null }).where(eq(orderItems.productId, productId));
    await tx.update(favoriteProducts).set({ productId: null }).where(eq(favoriteProducts.productId, productId));
    await tx.delete(cartItems).where(eq(cartItems.productId, productId));
    if (files.length) await tx.delete(media).where(inArray(media.id, files.map((f) => f.id)));
    await tx.delete(products).where(eq(products.id, productId));
  });
  files.forEach((f) => deleteStoredFile(f.storageKey));
  return { success: true };
}

// ===========================================================
// Catégories
// ===========================================================

function slugify(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export async function adminCategoryList() {
  const db = await requireDb();
  const rows = await db.select({
    id: categories.id, name: categories.name, slug: categories.slug, description: categories.description, parentId: categories.parentId,
    status: categories.status, active: categories.active, sortOrder: categories.sortOrder, proposedByShopId: categories.proposedByShopId,
    shopName: shops.name, createdAt: categories.createdAt,
    productCount: sql<number>`(SELECT COUNT(*) FROM products p WHERE p.categoryId = categories.id)`,
  }).from(categories).leftJoin(shops, eq(categories.proposedByShopId, shops.id)).orderBy(asc(categories.sortOrder), asc(categories.name));
  return rows.map((r) => ({ ...r, productCount: num(r.productCount) }));
}

async function validateParent(categoryId: number | null, parentId: number | null | undefined) {
  if (!parentId) return null;
  const db = await requireDb();
  if (parentId === categoryId) throw new Error("Une catégorie ne peut pas être sa propre catégorie parente");
  const parent = (await db.select().from(categories).where(eq(categories.id, parentId)).limit(1))[0];
  if (!parent) throw new Error("Catégorie parente introuvable");
  if (parent.parentId) throw new Error("Une sous-catégorie ne peut pas contenir d'autres sous-catégories");
  if (categoryId) {
    const children = num((await db.select({ value: count() }).from(categories).where(eq(categories.parentId, categoryId)))[0]?.value);
    if (children > 0) throw new Error("Cette catégorie contient des sous-catégories : elle ne peut pas devenir une sous-catégorie");
  }
  return parent;
}

async function assertUniqueName(name: string, exceptId?: number) {
  const db = await requireDb();
  const slug = slugify(name);
  if (slug.length < 2) throw new Error("Nom de catégorie invalide");
  const duplicate = (await db.select({ id: categories.id, name: categories.name }).from(categories)
    .where(and(sql`(${categories.slug} = ${slug} OR LOWER(${categories.name}) = ${name.toLowerCase()})`, exceptId ? sql`${categories.id} <> ${exceptId}` : undefined)).limit(1))[0];
  if (duplicate) throw new Error(`La catégorie « ${duplicate.name} » existe déjà`);
  return slug;
}

export async function adminSaveCategory(input: { id?: number; name: string; description?: string | null; parentId?: number | null; active?: boolean }) {
  const db = await requireDb();
  const name = input.name.trim();
  const slug = await assertUniqueName(name, input.id);
  const parent = await validateParent(input.id ?? null, input.parentId);
  const values = { name, slug, description: input.description?.trim() || null, parentId: parent?.id ?? null, ...(input.active === undefined ? {} : { active: input.active ? 1 : 0 }) };
  if (input.id) {
    const existing = (await db.select({ id: categories.id }).from(categories).where(eq(categories.id, input.id)).limit(1))[0];
    if (!existing) throw new Error("Catégorie introuvable");
    await db.transaction(async (tx) => {
      await tx.update(categories).set(values).where(eq(categories.id, input.id!));
      // Le nom dénormalisé des produits suit le nouveau nom
      await tx.update(products).set({ category: name }).where(eq(products.categoryId, input.id!));
    });
    return { success: true, id: input.id };
  }
  const result = await db.insert(categories).values({ ...values, status: "approved", sortOrder: 500 });
  return { success: true, id: num((result as unknown as Array<{ insertId?: number }>)[0]?.insertId) };
}

export async function adminSetCategoryActive(categoryId: number, active: boolean) {
  const db = await requireDb();
  await db.update(categories).set({ active: active ? 1 : 0 }).where(eq(categories.id, categoryId));
  return { success: true };
}

/** Suppression : les sous-catégories doivent être traitées d'abord, les produits réaffectés explicitement. */
export async function adminDeleteCategory(input: { categoryId: number; reassignToCategoryId?: number }) {
  const db = await requireDb();
  const category = (await db.select().from(categories).where(eq(categories.id, input.categoryId)).limit(1))[0];
  if (!category) throw new Error("Catégorie introuvable");
  const children = num((await db.select({ value: count() }).from(categories).where(eq(categories.parentId, category.id)))[0]?.value);
  if (children > 0) throw new Error(`Cette catégorie contient ${children} sous-catégorie(s) : supprimez-les ou déplacez-les d'abord.`);
  const used = num((await db.select({ value: count() }).from(products).where(eq(products.categoryId, category.id)))[0]?.value);
  let target: typeof category | undefined;
  if (used > 0) {
    if (!input.reassignToCategoryId) throw new Error(`Cette catégorie est utilisée par ${used} produit(s). Choisissez une catégorie de remplacement.`);
    target = (await db.select().from(categories).where(eq(categories.id, input.reassignToCategoryId)).limit(1))[0];
    if (!target || target.id === category.id || target.status !== "approved") throw new Error("Catégorie de remplacement invalide");
  }
  await db.transaction(async (tx) => {
    if (target) await tx.update(products).set({ categoryId: target.id, category: target.name }).where(eq(products.categoryId, category.id));
    await tx.delete(categories).where(eq(categories.id, category.id));
  });
  return { success: true, reassigned: used };
}

// ===========================================================
// Commandes
// ===========================================================

type OrderStatus = "pending" | "processing" | "shipped" | "delivered" | "cancelled";

export async function adminListOrders(input: { search?: string; status?: OrderStatus | "all"; shopId?: number; from?: string; to?: string; page?: number }) {
  const db = await requireDb();
  const { page, offset } = pageOf(input.page);
  const conditions: SQL[] = [];
  const search = input.search?.trim();
  if (search) {
    const ref = search.match(/^(?:ED-?)?0*(\d+)$/i);
    const pattern = like(search);
    conditions.push(ref
      ? sql`(${orders.id} = ${Number(ref[1])} OR ${orders.shippingPhone} LIKE ${pattern})`
      : sql`(${orders.shippingName} LIKE ${pattern} OR ${users.email} LIKE ${pattern} OR ${users.name} LIKE ${pattern} OR ${orders.shippingPhone} LIKE ${pattern})`);
  }
  if (input.status && input.status !== "all") conditions.push(eq(orders.status, input.status));
  if (input.shopId) conditions.push(sql`EXISTS (SELECT 1 FROM order_items oi WHERE oi.orderId = ${orders.id} AND oi.shopId = ${input.shopId})`);
  if (input.from) conditions.push(sql`${orders.createdAt} >= ${new Date(`${input.from}T00:00:00`)}`);
  if (input.to) conditions.push(sql`${orders.createdAt} < DATE_ADD(${new Date(`${input.to}T00:00:00`)}, INTERVAL 1 DAY)`);
  const where = conditions.length ? and(...conditions) : undefined;

  const [rows, totalRow, statusCounts] = await Promise.all([
    db.select({
      id: orders.id, totalTnd: orders.totalTnd, status: orders.status, createdAt: orders.createdAt,
      shippingName: orders.shippingName, shippingCity: orders.shippingCity, shippingPhone: orders.shippingPhone,
      clientId: users.id, clientName: users.name, clientEmail: users.email,
      itemCount: sql<number>`(SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.orderId = orders.id)`,
      shopNames: sql<string | null>`(SELECT GROUP_CONCAT(DISTINCT oi.shopName ORDER BY oi.shopName SEPARATOR ', ') FROM order_items oi WHERE oi.orderId = orders.id)`,
    }).from(orders).leftJoin(users, eq(orders.userId, users.id)).where(where).orderBy(desc(orders.createdAt)).limit(PAGE_SIZE).offset(offset),
    db.select({ value: count() }).from(orders).leftJoin(users, eq(orders.userId, users.id)).where(where),
    db.select({ status: orders.status, value: count() }).from(orders).groupBy(orders.status),
  ]);
  const counts = { all: 0, pending: 0, processing: 0, shipped: 0, delivered: 0, cancelled: 0 } as Record<OrderStatus | "all", number>;
  for (const row of statusCounts) {
    counts[row.status] = num(row.value);
    counts.all += num(row.value);
  }
  return {
    ...paged(rows.map((r) => ({ ...r, reference: orderReference(r.id), totalTnd: money(r.totalTnd), itemCount: num(r.itemCount) })), num(totalRow[0]?.value), page),
    counts,
  };
}

export async function adminOrderDetail(orderId: number) {
  const db = await requireDb();
  const order = (await db.select().from(orders).where(eq(orders.id, orderId)).limit(1))[0];
  if (!order) throw new Error("Commande introuvable");
  const [client, items, commissionRows, history] = await Promise.all([
    db.select({ id: users.id, name: users.name, email: users.email, phone: users.phone, suspended: users.suspended }).from(users).where(eq(users.id, order.userId)).limit(1),
    db.select().from(orderItems).where(eq(orderItems.orderId, orderId)),
    db.select().from(commissions).where(eq(commissions.orderId, orderId)),
    db.select({ id: orderStatusHistory.id, shopId: orderStatusHistory.shopId, fromStatus: orderStatusHistory.fromStatus, toStatus: orderStatusHistory.toStatus, changedByRole: orderStatusHistory.changedByRole, note: orderStatusHistory.note, createdAt: orderStatusHistory.createdAt, userName: users.name, shopName: shops.name })
      .from(orderStatusHistory).leftJoin(users, eq(orderStatusHistory.changedByUserId, users.id)).leftJoin(shops, eq(orderStatusHistory.shopId, shops.id))
      .where(eq(orderStatusHistory.orderId, orderId)).orderBy(desc(orderStatusHistory.createdAt)),
  ]);
  return {
    order: { ...order, reference: orderReference(order.id), totalTnd: money(order.totalTnd) },
    client: client[0] ?? null,
    // Lignes sur mesure : mesures, surface et options FIGÉES au moment de la commande
    items: items.map((i) => ({ ...withCustomSummary(i), unitPriceTnd: money(i.unitPriceTnd), lineTotalTnd: i.lineTotalTnd != null ? money(i.lineTotalTnd) : money(Number(i.unitPriceTnd) * i.quantity) })),
    commissions: commissionRows.map((c) => ({ ...c, grossTnd: money(c.grossTnd), commissionTnd: money(c.commissionTnd), vendorPayoutTnd: money(c.vendorPayoutTnd) })),
    history,
  };
}

// ===========================================================
// Avis
// ===========================================================

export async function adminListReviews(input: { status?: "pending" | "published" | "rejected" | "all"; search?: string; page?: number }) {
  const db = await requireDb();
  const { page, offset } = pageOf(input.page);
  const conditions: SQL[] = [];
  if (input.status && input.status !== "all") conditions.push(eq(reviews.status, input.status));
  const search = input.search?.trim();
  if (search) conditions.push(sql`(${reviews.productName} LIKE ${like(search)} OR ${reviews.body} LIKE ${like(search)} OR ${users.email} LIKE ${like(search)})`);
  const where = conditions.length ? and(...conditions) : undefined;
  const [rows, totalRow, statusCounts] = await Promise.all([
    db.select({
      id: reviews.id, rating: reviews.rating, body: reviews.body, status: reviews.status, createdAt: reviews.createdAt, orderId: reviews.orderId,
      productName: reviews.productName, productSlug: reviews.productSlug, shopSlug: reviews.shopSlug,
      shopName: sql<string | null>`(SELECT s.name FROM shops s WHERE s.slug = reviews.shopSlug LIMIT 1)`,
      productPublished: sql<number>`(SELECT COUNT(*) FROM products p WHERE p.slug = reviews.productSlug AND p.status = 'published')`,
      authorName: users.name, authorEmail: users.email,
    }).from(reviews).leftJoin(users, eq(reviews.userId, users.id)).where(where).orderBy(desc(reviews.createdAt)).limit(PAGE_SIZE).offset(offset),
    db.select({ value: count() }).from(reviews).leftJoin(users, eq(reviews.userId, users.id)).where(where),
    db.select({ status: reviews.status, value: count() }).from(reviews).groupBy(reviews.status),
  ]);
  const counts = { all: 0, pending: 0, published: 0, rejected: 0 } as Record<string, number>;
  for (const row of statusCounts) {
    counts[row.status] = num(row.value);
    counts.all += num(row.value);
  }
  return { ...paged(rows.map((r) => ({ ...r, productPublished: num(r.productPublished) > 0 })), num(totalRow[0]?.value), page), counts };
}

export async function adminDeleteReview(reviewId: number) {
  const db = await requireDb();
  const existing = (await db.select({ id: reviews.id }).from(reviews).where(eq(reviews.id, reviewId)).limit(1))[0];
  if (!existing) throw new Error("Avis introuvable");
  await db.delete(reviews).where(eq(reviews.id, reviewId));
  return { success: true };
}

// ===========================================================
// Statistiques
// ===========================================================

export type StatsPeriod = "7d" | "30d" | "90d" | "12m";

export async function adminStats(period: StatsPeriod) {
  const now = new Date();
  const monthly = period === "12m";
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (monthly) {
    start.setDate(1);
    start.setMonth(start.getMonth() - 11);
  } else {
    start.setDate(start.getDate() - ({ "7d": 6, "30d": 29, "90d": 89 } as const)[period]);
  }
  const fmt = monthly ? "%Y-%m" : "%Y-%m-%d";

  const [orderSeries, signupSeries, topProducts, topCategories, vendorActivity, totals] = await Promise.all([
    rawRows<{ bucket: string; orders: unknown; revenue: unknown; cancelled: unknown }>(sql`
      SELECT DATE_FORMAT(createdAt, ${fmt}) AS bucket, COUNT(*) AS orders,
             COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN totalTnd ELSE 0 END), 0) AS revenue,
             SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
      FROM orders WHERE createdAt >= ${start} GROUP BY bucket ORDER BY bucket`),
    rawRows<{ bucket: string; customers: unknown; vendors: unknown }>(sql`
      SELECT DATE_FORMAT(createdAt, ${fmt}) AS bucket,
             SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS customers,
             SUM(CASE WHEN role = 'vendor' THEN 1 ELSE 0 END) AS vendors
      FROM users WHERE createdAt >= ${start} GROUP BY bucket ORDER BY bucket`),
    rawRows<{ productSlug: string; productName: string; shopName: string; quantity: unknown; revenue: unknown; orders: unknown }>(sql`
      SELECT oi.productSlug, MAX(oi.productName) AS productName, MAX(oi.shopName) AS shopName,
             SUM(oi.quantity) AS quantity, SUM(oi.quantity * oi.unitPriceTnd) AS revenue, COUNT(DISTINCT oi.orderId) AS orders
      FROM order_items oi INNER JOIN orders o ON o.id = oi.orderId
      WHERE o.createdAt >= ${start} AND oi.fulfillmentStatus <> 'cancelled'
      GROUP BY oi.productSlug ORDER BY quantity DESC, revenue DESC LIMIT 10`),
    rawRows<{ categoryName: string; quantity: unknown; revenue: unknown }>(sql`
      SELECT COALESCE(pc.name, c.name, p.category, 'Produit supprimé') AS categoryName,
             SUM(oi.quantity) AS quantity, SUM(oi.quantity * oi.unitPriceTnd) AS revenue
      FROM order_items oi
      INNER JOIN orders o ON o.id = oi.orderId
      LEFT JOIN products p ON p.id = oi.productId
      LEFT JOIN categories c ON c.id = p.categoryId
      LEFT JOIN categories pc ON pc.id = c.parentId
      WHERE o.createdAt >= ${start} AND oi.fulfillmentStatus <> 'cancelled'
      GROUP BY COALESCE(pc.name, c.name, p.category, 'Produit supprimé') ORDER BY revenue DESC LIMIT 10`),
    rawRows<{ shopId: number; shopName: string; shopSlug: string; orders: unknown; quantity: unknown; revenue: unknown; publishedProducts: unknown; newProducts: unknown }>(sql`
      SELECT s.id AS shopId, s.name AS shopName, s.slug AS shopSlug,
             (SELECT COUNT(DISTINCT oi.orderId) FROM order_items oi INNER JOIN orders o ON o.id = oi.orderId WHERE oi.shopId = s.id AND o.createdAt >= ${start}) AS orders,
             (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi INNER JOIN orders o ON o.id = oi.orderId WHERE oi.shopId = s.id AND o.createdAt >= ${start} AND oi.fulfillmentStatus <> 'cancelled') AS quantity,
             (SELECT COALESCE(SUM(oi.quantity * oi.unitPriceTnd), 0) FROM order_items oi INNER JOIN orders o ON o.id = oi.orderId WHERE oi.shopId = s.id AND o.createdAt >= ${start} AND oi.fulfillmentStatus <> 'cancelled') AS revenue,
             (SELECT COUNT(*) FROM products p WHERE p.shopId = s.id AND p.status = 'published') AS publishedProducts,
             (SELECT COUNT(*) FROM products p WHERE p.shopId = s.id AND p.createdAt >= ${start}) AS newProducts
      FROM shops s WHERE s.status = 'active'
      ORDER BY revenue DESC, orders DESC, publishedProducts DESC LIMIT 10`),
    rawRows<{ orders: unknown; revenue: unknown; cancelled: unknown; customers: unknown; vendors: unknown; units: unknown }>(sql`
      SELECT
        (SELECT COUNT(*) FROM orders WHERE createdAt >= ${start}) AS orders,
        (SELECT COALESCE(SUM(totalTnd), 0) FROM orders WHERE createdAt >= ${start} AND status <> 'cancelled') AS revenue,
        (SELECT COUNT(*) FROM orders WHERE createdAt >= ${start} AND status = 'cancelled') AS cancelled,
        (SELECT COUNT(*) FROM users WHERE createdAt >= ${start} AND role = 'user') AS customers,
        (SELECT COUNT(*) FROM users WHERE createdAt >= ${start} AND role = 'vendor') AS vendors,
        (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi INNER JOIN orders o ON o.id = oi.orderId WHERE o.createdAt >= ${start} AND oi.fulfillmentStatus <> 'cancelled') AS units`),
  ]);

  // Toutes les périodes sont présentes dans les séries (zéro si aucune donnée)
  const buckets: string[] = [];
  const cursor = new Date(start);
  while (cursor <= now) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, "0");
    buckets.push(monthly ? `${y}-${m}` : `${y}-${m}-${String(cursor.getDate()).padStart(2, "0")}`);
    if (monthly) cursor.setMonth(cursor.getMonth() + 1);
    else cursor.setDate(cursor.getDate() + 1);
  }
  const ordersBy = new Map(orderSeries.map((r) => [r.bucket, r]));
  const signupsBy = new Map(signupSeries.map((r) => [r.bucket, r]));
  const t = totals[0] ?? {};
  const orderCount = num(t.orders);
  const revenue = money(t.revenue);

  return {
    period,
    from: start.toISOString(),
    totals: {
      orders: orderCount,
      revenueTnd: revenue,
      cancelledOrders: num(t.cancelled),
      averageOrderTnd: orderCount - num(t.cancelled) > 0 ? money(revenue / (orderCount - num(t.cancelled))) : 0,
      unitsSold: num(t.units),
      newCustomers: num(t.customers),
      newVendors: num(t.vendors),
    },
    sales: buckets.map((b) => ({ bucket: b, orders: num(ordersBy.get(b)?.orders), revenue: money(ordersBy.get(b)?.revenue), cancelled: num(ordersBy.get(b)?.cancelled) })),
    signups: buckets.map((b) => ({ bucket: b, customers: num(signupsBy.get(b)?.customers), vendors: num(signupsBy.get(b)?.vendors) })),
    topProducts: topProducts.map((p) => ({ ...p, quantity: num(p.quantity), revenue: money(p.revenue), orders: num(p.orders) })),
    topCategories: topCategories.map((c) => ({ category: c.categoryName, quantity: num(c.quantity), revenue: money(c.revenue) })),
    vendorActivity: vendorActivity.map((v) => ({ ...v, orders: num(v.orders), quantity: num(v.quantity), revenue: money(v.revenue), publishedProducts: num(v.publishedProducts), newProducts: num(v.newProducts) })),
  };
}
