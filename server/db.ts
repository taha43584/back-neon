import { and, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { assertTestSafeDatabase } from "./testDbGuard";
import { drizzle } from "drizzle-orm/mysql2";
import { nanoid } from "nanoid";
import { addresses, categories, commissions, conversations, favoriteProducts, followedShops, messages, orderItems, orderStatusHistory, orders, products, reviews, shops, users } from "../drizzle/schema";
import { TRPCError } from "@trpc/server";
import type { InsertUser } from "../drizzle/schema";
import { ENV } from './_core/env';
import { assertReviewStatusChange, clientVisibleReviews, onlyPublishedReviews } from './reviews';
import { catalogProducts } from "./catalog";
import { effectivePrice, parseVariants } from "@shared/productValidation";
import { getPublicProductMedia } from "./vendorCatalog";
import { listPublicShopCategories } from "./shopCategories";
import { isCustomProduct, loadProductOptions, priceCustomLine } from "./customPricingServer";
import { describeCustomLine, parseOrderOptions, type CustomPriceSuccess } from "@shared/customPricing";
import { deleteStoredFile } from "./mediaStorage";
import { media } from "../drizzle/schema";
import { getSettings } from "./settings";
import { priceNeonLine } from "./neon";
import { describeNeonLine, neonFont, NEON_PRODUCT_NAME, NEON_PRODUCT_SLUG, type NeonLineRequest, type NeonPriceSuccess } from "@shared/neon";
import bcrypt from 'bcryptjs';

/** Les e-mails sont stockés et recherchés en minuscules, sans espaces. */
export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function slugify(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    // Tests : uniquement la base *_test (lève une erreur sinon, hors du try)
    assertTestSafeDatabase(process.env.DATABASE_URL);
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  const textFields = ["name", "email", "loginMethod"] as const;
  type TextField = (typeof textFields)[number];
  const assignNullable = (field: TextField) => {
    const value = user[field];
    if (value === undefined) return;
    const normalized = value ?? null;
    values[field] = normalized;
    updateSet[field] = normalized;
  };
  textFields.forEach(assignNullable);

  if (user.lastSignedIn !== undefined) {
    values.lastSignedIn = user.lastSignedIn;
    updateSet.lastSignedIn = user.lastSignedIn;
  }
  if (user.role !== undefined) {
    values.role = user.role;
    updateSet.role = user.role;
  } else if (user.openId === ENV.ownerOpenId) {
    values.role = 'admin';
    updateSet.role = 'admin';
  }
  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();

  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

const emptyClientDashboard = { stats: { orderCount: 0, favoriteCount: 0, followedShopCount: 0 }, orders: [], favorites: [], followedShops: [], addresses: [], reviews: [], reviewableProducts: [] };

export async function getClientDashboardData(userId: number) {
  const db = await getDb();
  if (!db) return emptyClientDashboard;
  const [orderRows, favoriteRows, followedShopRows, addressRows, reviewRows, reviewableRows] = await Promise.all([
    db.select({ id: orders.id, totalTnd: orders.totalTnd, status: orders.status, shippingCity: orders.shippingCity, createdAt: orders.createdAt }).from(orders).where(eq(orders.userId, userId)).orderBy(desc(orders.createdAt)).limit(20),
    db.select({ id: favoriteProducts.id, productId: favoriteProducts.productId, productName: favoriteProducts.productName, productSlug: favoriteProducts.productSlug, imageUrl: favoriteProducts.imageUrl, priceTnd: favoriteProducts.priceTnd }).from(favoriteProducts).where(eq(favoriteProducts.userId, userId)).orderBy(desc(favoriteProducts.createdAt)).limit(20),
    db.select({ id: followedShops.id, shopId: followedShops.shopId, shopName: followedShops.shopName, shopSlug: followedShops.shopSlug, status: sql<string>`COALESCE(${shops.status}, 'catalog')` }).from(followedShops).leftJoin(shops, eq(followedShops.shopId, shops.id)).where(eq(followedShops.userId, userId)).orderBy(desc(followedShops.createdAt)).limit(20),
    db.select({ id: addresses.id, label: addresses.label, recipientName: addresses.recipientName, phone: addresses.phone, addressLine: addresses.addressLine, city: addresses.city, postalCode: addresses.postalCode, isDefault: addresses.isDefault }).from(addresses).where(eq(addresses.userId, userId)).orderBy(desc(addresses.isDefault), desc(addresses.createdAt)).limit(20),
    db.select({ id: reviews.id, orderId: reviews.orderId, productName: reviews.productName, productSlug: reviews.productSlug, rating: reviews.rating, body: reviews.body, status: reviews.status, createdAt: reviews.createdAt }).from(reviews).where(eq(reviews.userId, userId)).orderBy(desc(reviews.createdAt)).limit(20),
    db.select({ orderId: orders.id, productSlug: orderItems.productSlug, productName: orderItems.productName, shopSlug: orderItems.shopSlug }).from(orderItems).innerJoin(orders, eq(orderItems.orderId, orders.id)).where(and(eq(orders.userId, userId), eq(orders.status, "delivered"))).orderBy(desc(orders.createdAt)).limit(20),
  ]);
  const clientReviews = clientVisibleReviews(reviewRows);
  const reviewedKeys = new Set(reviewRows.map((review) => `${review.orderId}:${review.productSlug}`));
  const reviewableProducts = reviewableRows.filter((item) => !reviewedKeys.has(`${item.orderId}:${item.productSlug}`));
  return {
    stats: { orderCount: orderRows.length, favoriteCount: favoriteRows.length, followedShopCount: followedShopRows.length },
    orders: orderRows,
    favorites: favoriteRows,
    followedShops: followedShopRows,
    addresses: addressRows,
    reviews: clientReviews,
    reviewableProducts,
  };
}

export type AddressInput = {
  label: string;
  recipientName: string;
  phone: string;
  addressLine: string;
  city: string;
  postalCode?: string;
  isDefault?: boolean;
};

export async function createAddress(userId: number, input: AddressInput) {
  const db = await getDb();
  if (!db) return { id: null };
  const addressId = await db.transaction(async (tx) => {
    if (input.isDefault) await tx.update(addresses).set({ isDefault: 0 }).where(eq(addresses.userId, userId));
    const result = await tx.insert(addresses).values({ userId, label: input.label, recipientName: input.recipientName, phone: input.phone, addressLine: input.addressLine, city: input.city, postalCode: input.postalCode ?? null, isDefault: input.isDefault ? 1 : 0 });
    return Number(((result as unknown as Array<{ insertId?: number }>)[0]?.insertId ?? 0));
  });
  return { id: addressId };
}

export async function deleteAddress(userId: number, addressId: number) {
  const db = await getDb();
  if (!db) return { deleted: false };
  await db.delete(addresses).where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)));
  return { deleted: true };
}

export type ReviewInput = { productSlug: string; rating: number; body: string };

export async function createReview(userId: number, input: ReviewInput) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  const purchase = (await db.select({ orderId: orders.id, productId: orderItems.productId, productName: orderItems.productName, productSlug: orderItems.productSlug, shopSlug: orderItems.shopSlug }).from(orderItems).innerJoin(orders, eq(orderItems.orderId, orders.id)).where(and(eq(orders.userId, userId), eq(orders.status, "delivered"), eq(orderItems.productSlug, input.productSlug))).orderBy(desc(orders.createdAt)).limit(1))[0];
  if (!purchase) throw new Error("Un avis est disponible après une commande livrée");
  const alreadyReviewed = await db.select({ id: reviews.id }).from(reviews).where(and(eq(reviews.userId, userId), eq(reviews.orderId, purchase.orderId), eq(reviews.productSlug, purchase.productSlug))).limit(1);
  if (alreadyReviewed[0]) throw new Error("Vous avez déjà évalué cette commande");
  const result = await db.insert(reviews).values({ userId, orderId: purchase.orderId, productId: purchase.productId ?? null, productSlug: purchase.productSlug, productName: purchase.productName, shopSlug: purchase.shopSlug, rating: input.rating, body: input.body, status: "pending" });
  return { id: Number(((result as unknown as Array<{ insertId?: number }>)[0]?.insertId ?? 0)), status: "pending" as const };
}

export async function getPublishedReviews(productSlug: string) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ id: reviews.id, productName: reviews.productName, rating: reviews.rating, body: reviews.body, status: reviews.status, createdAt: reviews.createdAt }).from(reviews).where(and(eq(reviews.productSlug, productSlug), eq(reviews.status, "published"))).orderBy(desc(reviews.createdAt)).limit(20);
  return onlyPublishedReviews(rows);
}

export type FavoriteProductInput = {
  productId?: number;
  productSlug: string;
  productName: string;
  imageUrl: string;
  priceTnd: string;
};

export async function toggleFavorite(userId: number, input: FavoriteProductInput) {
  const db = await getDb();
  if (!db) return { active: false };
  const existing = await db.select({ id: favoriteProducts.id }).from(favoriteProducts).where(and(eq(favoriteProducts.userId, userId), eq(favoriteProducts.productSlug, input.productSlug))).limit(1);
  if (existing[0]) {
    await db.delete(favoriteProducts).where(eq(favoriteProducts.id, existing[0].id));
    return { active: false };
  }
  const product = input.productId ? (await db.select({ id: products.id }).from(products).where(eq(products.id, input.productId)).limit(1))[0] : undefined;
  const normalizedPrice = input.priceTnd.replace(/[^0-9.,]/g, "").replace(",", ".") || "0";
  await db.insert(favoriteProducts).values({ userId, productId: product?.id ?? null, productSlug: input.productSlug, productName: input.productName, imageUrl: input.imageUrl, priceTnd: normalizedPrice });
  return { active: true };
}

export async function getFavoriteSlugs(userId: number): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ slug: favoriteProducts.productSlug }).from(favoriteProducts).where(eq(favoriteProducts.userId, userId));
  return rows.map((r) => r.slug);
}

export type FollowedShopInput = {
  shopId?: number;
  shopSlug: string;
  shopName: string;
};

export async function toggleFollowShop(userId: number, input: FollowedShopInput) {
  const db = await getDb();
  if (!db) return { active: false };
  const existing = await db.select({ id: followedShops.id }).from(followedShops).where(and(eq(followedShops.userId, userId), eq(followedShops.shopSlug, input.shopSlug))).limit(1);
  if (existing[0]) {
    await db.delete(followedShops).where(eq(followedShops.id, existing[0].id));
    return { active: false };
  }
  const shop = input.shopId ? (await db.select({ id: shops.id }).from(shops).where(eq(shops.id, input.shopId)).limit(1))[0] : undefined;
  await db.insert(followedShops).values({ userId, shopId: shop?.id ?? null, shopSlug: input.shopSlug, shopName: input.shopName });
  return { active: true };
}

const EMPTY_VENDOR_STATS = { productCount: 0, activeProductCount: 0, draftProductCount: 0, pendingProductCount: 0, orderCount: 0, unitsSold: 0, revenueTnd: 0, salesTnd: 0, commissionTnd: 0, netPayoutTnd: 0, avgRating: null as number | null };

export async function getVendorDashboardData(userId: number) {
  const db = await getDb();
  if (!db) return { shop: undefined, products: [], orders: [], reviews: [], commissions: [], stats: { ...EMPTY_VENDOR_STATS } };
  
  const shopRows = await db.select().from(shops).where(eq(shops.userId, userId)).orderBy(desc(shops.createdAt)).limit(1);
  const shop = shopRows[0];
  if (!shop) return { shop: undefined, products: [], orders: [], reviews: [], commissions: [], stats: { ...EMPTY_VENDOR_STATS } };

  const [productRows, orderItemRows, commissionRows, reviewRows] = await Promise.all([
    db.select().from(products).where(eq(products.shopId, shop.id)).orderBy(desc(products.createdAt)).limit(2000),
    db.select({
      id: orderItems.id,
      orderId: orders.id,
      productId: orderItems.productId,
      productName: orderItems.productName,
      productSlug: orderItems.productSlug,
      quantity: orderItems.quantity,
      unitPriceTnd: orderItems.unitPriceTnd,
      selectedColor: orderItems.selectedColor,
      personalization: orderItems.personalization,
      // Mesures figées des lignes sur mesure (nécessaires à la fabrication)
      ...customOrderItemFields,
      // Statut des articles de CETTE boutique (une commande peut concerner plusieurs boutiques)
      status: orderItems.fulfillmentStatus,
      orderStatus: orders.status,
      shippingName: orders.shippingName,
      shippingPhone: orders.shippingPhone,
      shippingCity: orders.shippingCity,
      shippingAddress: orders.shippingAddress,
      shippingNote: orders.shippingNote,
      createdAt: orders.createdAt,
    })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(eq(orderItems.shopId, shop.id))
      .orderBy(desc(orders.createdAt))
      .limit(500),
    db.select().from(commissions).where(eq(commissions.shopId, shop.id)).orderBy(desc(commissions.createdAt)).limit(100),
    db.select().from(reviews).where(eq(reviews.shopSlug, shop.slug)).orderBy(desc(reviews.createdAt)).limit(100),
  ]);

  const totalSales = commissionRows.reduce((acc, c) => acc + Number(c.grossTnd || 0), 0);
  const totalCommission = commissionRows.reduce((acc, c) => acc + Number(c.commissionTnd || 0), 0);
  const totalNetPayout = commissionRows.reduce((acc, c) => acc + Number(c.vendorPayoutTnd || 0), 0);

  const activeProducts = productRows.filter((p) => p.status === "published");
  const draftProducts = productRows.filter((p) => p.status === "draft");
  const pendingProducts = productRows.filter((p) => p.status === "pending");
  // Chiffres calculés uniquement à partir des lignes de commande réelles (commandes annulées exclues)
  const validItems = orderItemRows.filter((o) => o.status !== "cancelled");
  const revenueTnd = Math.round(validItems.reduce((sum, o) => sum + Number(o.unitPriceTnd) * o.quantity, 0) * 100) / 100;
  const unitsSold = validItems.reduce((sum, o) => sum + o.quantity, 0);
  const distinctOrders = new Set(orderItemRows.map((o) => o.orderId)).size;

  const ratings = reviewRows.filter((r) => r.rating > 0).map((r) => r.rating);
  const avgRating = ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null;

  return {
    shop,
    products: productRows,
    orders: orderItemRows.map(withCustomSummary),
    reviews: reviewRows,
    commissions: commissionRows,
    stats: {
      productCount: productRows.length,
      activeProductCount: activeProducts.length,
      draftProductCount: draftProducts.length,
      pendingProductCount: pendingProducts.length,
      orderCount: distinctOrders,
      unitsSold,
      revenueTnd,
      salesTnd: totalSales,
      commissionTnd: totalCommission,
      netPayoutTnd: totalNetPayout,
      avgRating,
    },
  };
}

/**
 * Logo et couverture ne font volontairement pas partie de ce type : ils ne sont modifiables
 * que par l'envoi d'image vérifié (server/shopImages.ts), jamais par une URL libre.
 * Les liens sociaux arrivent déjà normalisés (null = lien supprimé).
 */
export type VendorApplicationInput = {
  name: string;
  tagline?: string;
  about?: string;
  phone?: string;
  address?: string;
  city?: string;
  socialInstagram?: string | null;
  socialFacebook?: string | null;
  socialWebsite?: string;
  openingHours?: string;
};

export async function applyForVendorShop(userId: number, input: VendorApplicationInput) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");

  const existing = (await db.select().from(shops).where(eq(shops.userId, userId)).limit(1))[0];
  const baseSlug = slugify(input.name) || "boutique";

  // Une boutique active ou suspendue ne peut pas \u00eatre remise en attente par son
  // propri\u00e9taire : seule l'administration modifie ces statuts.
  if (existing && (existing.status === "active" || existing.status === "suspended")) {
    throw new Error("Votre boutique a d\u00e9j\u00e0 \u00e9t\u00e9 examin\u00e9e par l'administration. Modifiez ses informations depuis votre espace vendeur.");
  }

  if (existing) {
    await db.update(shops).set({
      name: input.name,
      tagline: input.tagline ?? existing.tagline,
      about: input.about ?? existing.about,
      phone: input.phone ?? existing.phone,
      address: input.address ?? existing.address,
      city: input.city ?? existing.city,
      socialInstagram: input.socialInstagram !== undefined ? input.socialInstagram : existing.socialInstagram,
      socialFacebook: input.socialFacebook !== undefined ? input.socialFacebook : existing.socialFacebook,
      socialWebsite: input.socialWebsite ?? existing.socialWebsite,
      openingHours: input.openingHours ?? existing.openingHours,
      status: "pending", // remet en pending pour réexamen
    }).where(eq(shops.id, existing.id));
    return { id: existing.id, slug: existing.slug, status: "pending" as const };
  }

  const slug = `${baseSlug}-${nanoid(6).toLowerCase()}`;
  const insertResult = await db.insert(shops).values({
    userId,
    name: input.name,
    slug,
    tagline: input.tagline ?? null,
    about: input.about ?? null,
    coverUrl: null,
    logoUrl: null,
    phone: input.phone ?? null,
    address: input.address ?? null,
    city: input.city ?? null,
    socialInstagram: input.socialInstagram ?? null,
    socialFacebook: input.socialFacebook ?? null,
    socialWebsite: input.socialWebsite ?? null,
    openingHours: input.openingHours ?? null,
    status: "pending",
  });

  const newId = Number(((insertResult as unknown as Array<{ insertId?: number }>)[0]?.insertId ?? 0));
  return { id: newId, slug, status: "pending" as const };
}

export async function createVendorShop(userId: number, input: { name: string; tagline?: string; about?: string }) {
  return applyForVendorShop(userId, input);
}

export async function updateVendorShop(userId: number, input: Partial<VendorApplicationInput> & { whatsapp?: string; deliveryInfo?: string; showWhatsapp?: boolean; showPhone?: boolean }) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");

  const shopRows = await db.select().from(shops).where(eq(shops.userId, userId)).limit(1);
  const shop = shopRows[0];
  if (!shop) throw new Error("Boutique introuvable");

  const updateSet: Record<string, unknown> = {};
  if (input.name !== undefined) updateSet.name = input.name;
  if (input.tagline !== undefined) updateSet.tagline = input.tagline;
  if (input.about !== undefined) updateSet.about = input.about;
  if (input.phone !== undefined) updateSet.phone = input.phone;
  if (input.address !== undefined) updateSet.address = input.address;
  if (input.city !== undefined) updateSet.city = input.city;
  if (input.socialInstagram !== undefined) updateSet.socialInstagram = input.socialInstagram;
  if (input.socialFacebook !== undefined) updateSet.socialFacebook = input.socialFacebook;
  if (input.socialWebsite !== undefined) updateSet.socialWebsite = input.socialWebsite;
  if (input.openingHours !== undefined) updateSet.openingHours = input.openingHours;
  if (input.whatsapp !== undefined) updateSet.whatsapp = input.whatsapp;
  if (input.deliveryInfo !== undefined) updateSet.deliveryInfo = input.deliveryInfo;
  if (input.showWhatsapp !== undefined) updateSet.showWhatsapp = input.showWhatsapp ? 1 : 0;
  if (input.showPhone !== undefined) updateSet.showPhone = input.showPhone ? 1 : 0;

  if (Object.keys(updateSet).length > 0) {
    await db.update(shops).set(updateSet).where(eq(shops.id, shop.id));
  }

  const updated = (await db.select().from(shops).where(eq(shops.id, shop.id)).limit(1))[0];
  return updated;
}

export const PLATFORM_COMMISSION_RATE = 0.1;

export function calculateCommission(grossTnd: number, rate = PLATFORM_COMMISSION_RATE) {
  const commissionTnd = Math.round(grossTnd * rate * 100) / 100;
  return { grossTnd, commissionTnd, vendorPayoutTnd: Math.round((grossTnd - commissionTnd) * 100) / 100 };
}

export type VendorProductInput = {
  name: string;
  category: string;
  priceTnd: string;
  imageUrl: string;
  description?: string;
  material?: string;
  dimensions?: string;
  delivery?: string;
  badge?: string;
  stock?: number;
  customization?: string;
  status?: "draft" | "pending" | "published";
};

export async function createVendorProduct(userId: number, input: VendorProductInput) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");

  const shopRows = await db.select().from(shops).where(eq(shops.userId, userId)).limit(1);
  const shop = shopRows[0];
  if (!shop) throw new Error("Boutique introuvable pour ce compte vendeur");
  if (shop.status !== "active") {
    throw new Error("Votre boutique doit être validée par l'administrateur avant de pouvoir créer des produits");
  }

  const slug = `${input.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${nanoid(6).toLowerCase()}`;
  const categorySlug = slugify(input.category) || "autres";

  // Plus aucune cat\u00e9gorie cr\u00e9\u00e9e \u00e0 la vol\u00e9e : on r\u00e9utilise une cat\u00e9gorie valid\u00e9e existante
  const categoryRow = (await db.select().from(categories).where(and(
    or(eq(categories.slug, categorySlug), sql`LOWER(${categories.name}) = ${input.category.trim().toLowerCase()}`),
    eq(categories.status, "approved"),
  )).limit(1))[0];
  if (!categoryRow) {
    throw new Error(`Cat\u00e9gorie \u00ab ${input.category} \u00bb inconnue. Choisissez une cat\u00e9gorie existante ou proposez-en une nouvelle.`);
  }

  const cleanPrice = input.priceTnd.replace(",", ".");
  await db.insert(products).values({
    shopId: shop.id,
    name: input.name,
    slug,
    category: categoryRow.name,
    categoryId: categoryRow.id,
    priceTnd: cleanPrice,
    imageUrl: input.imageUrl,
    description: input.description ?? null,
    material: input.material ?? null,
    dimensions: input.dimensions ?? null,
    delivery: input.delivery ?? null,
    badge: input.badge ?? "Nouveau",
    tint: "bg-[#f5ede7]",
    status: input.status ?? "published",
    stock: input.stock ?? 1,
    customization: input.customization ?? null,
  });

  return { success: true, slug };
}

export async function updateVendorProduct(userId: number, productId: number, input: Partial<VendorProductInput>) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");

  const shopRows = await db.select().from(shops).where(eq(shops.userId, userId)).limit(1);
  const shop = shopRows[0];
  if (!shop) throw new Error("Boutique introuvable");
  if (shop.status !== "active") {
    throw new Error("Votre boutique n'est pas active");
  }

  // Strict ownership check
  const productRow = (await db.select().from(products).where(and(eq(products.id, productId), eq(products.shopId, shop.id))).limit(1))[0];
  if (!productRow) {
    throw new Error("Produit introuvable ou vous n'avez pas l'autorisation de le modifier");
  }

  const updateSet: Record<string, unknown> = {};
  if (input.name !== undefined) updateSet.name = input.name;
  if (input.category !== undefined) updateSet.category = input.category;
  if (input.priceTnd !== undefined) updateSet.priceTnd = input.priceTnd.replace(",", ".");
  if (input.imageUrl !== undefined) updateSet.imageUrl = input.imageUrl;
  if (input.description !== undefined) updateSet.description = input.description;
  if (input.material !== undefined) updateSet.material = input.material;
  if (input.dimensions !== undefined) updateSet.dimensions = input.dimensions;
  if (input.delivery !== undefined) updateSet.delivery = input.delivery;
  if (input.badge !== undefined) updateSet.badge = input.badge;
  if (input.stock !== undefined) updateSet.stock = input.stock;
  if (input.customization !== undefined) updateSet.customization = input.customization;
  if (input.status !== undefined) updateSet.status = input.status;

  if (Object.keys(updateSet).length > 0) {
    await db.update(products).set(updateSet).where(eq(products.id, productId));
  }

  return { success: true };
}

export async function toggleVendorProductStatus(userId: number, productId: number) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");

  const shop = (await db.select().from(shops).where(eq(shops.userId, userId)).limit(1))[0];
  if (!shop) throw new Error("Boutique introuvable");
  if (shop.status !== "active") {
    throw new Error("Votre boutique n'est pas encore validée par l'administrateur");
  }

  const product = (await db.select().from(products).where(and(eq(products.id, productId), eq(products.shopId, shop.id))).limit(1))[0];
  if (!product) throw new Error("Produit introuvable");

  const newStatus = (product as { status?: string }).status === "published" ? "draft" : "published";
  await db.update(products).set({ status: newStatus }).where(eq(products.id, productId));
  return { success: true, status: newStatus };
}

/** Supprime les références et fichiers médias d'un produit. */
async function deleteProductMediaFiles(productId: number) {
  const db = await getDb();
  if (!db) return;
  const files = await db.select({ id: media.id, storageKey: media.storageKey }).from(media).where(eq(media.productId, productId));
  if (!files.length) return;
  await db.delete(media).where(inArray(media.id, files.map((f) => f.id)));
  files.forEach((f) => deleteStoredFile(f.storageKey));
}

export async function deleteVendorProduct(userId: number, productId: number) {
  const db = await getDb();
  if (!db) return false;
  const shopRows = await db.select().from(shops).where(eq(shops.userId, userId)).limit(1);
  const shop = shopRows[0];
  if (!shop) return false;
  if (shop.status !== "active") {
    throw new Error("Votre boutique n'est pas encore validée par l'administrateur");
  }

  // Strict ownership check
  const owned = (await db.select({ id: products.id }).from(products).where(and(eq(products.id, productId), eq(products.shopId, shop.id))).limit(1))[0];
  if (!owned) return false;
  await deleteProductMediaFiles(owned.id);
  await db.delete(products).where(eq(products.id, owned.id));
  return true;
}

export async function updateVendorOrderStatus(userId: number, orderId: number, status: "pending" | "processing" | "shipped" | "delivered" | "cancelled") {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");

  const shop = (await db.select().from(shops).where(eq(shops.userId, userId)).limit(1))[0];
  if (!shop) throw new Error("Boutique introuvable");
  if (shop.status !== "active") {
    throw new Error("Votre boutique n'est pas encore validée par l'administrateur");
  }

  // Le vendeur ne modifie que SES lignes de la commande ; les articles des autres boutiques ne changent pas
  const shopItems = await db.select({ id: orderItems.id, fulfillmentStatus: orderItems.fulfillmentStatus }).from(orderItems).where(and(eq(orderItems.orderId, orderId), eq(orderItems.shopId, shop.id)));
  if (!shopItems.length) throw new TRPCError({ code: "FORBIDDEN", message: "Vous n'avez pas l'autorisation de modifier cette commande" });
  const order = (await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).limit(1))[0];
  if (order?.status === "cancelled") throw new Error("Cette commande a été annulée par l'administration");
  const previous = shopItems[0].fulfillmentStatus;

  if (previous === "cancelled" && status !== "cancelled") throw new Error("Ces articles ont été annulés : contactez l'administration pour les réactiver");

  const orderStatus = await db.transaction(async (tx) => {
    if (status === "cancelled") await restockItems(tx, and(eq(orderItems.orderId, orderId), eq(orderItems.shopId, shop.id), sql`${orderItems.fulfillmentStatus} <> 'cancelled'`)!);
    await tx.update(orderItems).set({ fulfillmentStatus: status }).where(and(eq(orderItems.orderId, orderId), eq(orderItems.shopId, shop.id)));
    await tx.insert(orderStatusHistory).values({ orderId, shopId: shop.id, fromStatus: previous, toStatus: status, changedByUserId: userId, changedByRole: "vendor" });
    // Statut global : identique si toutes les boutiques sont au même stade, sinon « en préparation »
    const all = await tx.select({ s: orderItems.fulfillmentStatus }).from(orderItems).where(eq(orderItems.orderId, orderId));
    const derived = deriveOrderStatus(all.map((row) => row.s));
    await tx.update(orders).set({ status: derived }).where(eq(orders.id, orderId));
    return derived;
  });
  return { success: true, status, orderStatus };
}

type FulfillmentStatus = "pending" | "processing" | "shipped" | "delivered" | "cancelled";
type Tx = Parameters<Parameters<NonNullable<Awaited<ReturnType<typeof getDb>>>["transaction"]>[0]>[0];

/** Réintègre en stock les quantités des lignes annulées (produits suivis en stock uniquement). */
async function restockItems(tx: Tx, where: ReturnType<typeof and>) {
  const lines = await tx.select({ productId: orderItems.productId, quantity: orderItems.quantity }).from(orderItems).where(where);
  for (const line of lines) {
    if (!line.productId) continue;
    await tx.update(products).set({ stock: sql`${products.stock} + ${line.quantity}` }).where(and(eq(products.id, line.productId), eq(products.availability, "in_stock")));
  }
}

export function deriveOrderStatus(itemStatuses: FulfillmentStatus[]): FulfillmentStatus {
  const active = itemStatuses.filter((s) => s !== "cancelled");
  if (!active.length) return "cancelled";
  const unique = Array.from(new Set(active));
  if (unique.length === 1) return unique[0];
  if (unique.every((s) => s === "shipped" || s === "delivered")) return "shipped";
  return "processing";
}

export type CheckoutOrderItem = {
  productId?: number;
  shopId?: number;
  productSlug: string;
  productName: string;
  shopSlug: string;
  shopName: string;
  quantity: number;
  unitPriceTnd: number;
  selectedColor?: string;
  personalization?: string;
  // Produit sur mesure : mesures et options choisies (le prix envoyé est ignoré et recalculé)
  widthCm?: number | string;
  heightCm?: number | string;
  optionIds?: number[];
  /** Renseigné par le serveur : instantané figé du calcul sur mesure */
  custom?: CustomPriceSuccess;
  /** Néon personnalisé : choix du client (aucun montant) */
  neon?: NeonLineRequest & { shopSlug: string };
  /** Renseigné par le serveur : instantané figé du calcul néon */
  neonPriced?: NeonPriceSuccess;
};

/** Produits vendables (publiés, boutique active) avec leurs options, pour le panier et la commande. */
async function loadSellableProducts(slugs: string[]) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  const rows = slugs.length
    ? await db.select({ product: products, shopId: shops.id, shopSlug: shops.slug, shopName: shops.name })
        .from(products)
        .innerJoin(shops, eq(products.shopId, shops.id))
        .where(and(inArray(products.slug, slugs), eq(products.status, "published"), eq(shops.status, "active")))
    : [];
  const options = await loadProductOptions(rows.filter((r) => isCustomProduct(r.product)).map((r) => r.product.id));
  return new Map(rows.map((row) => [row.product.slug, { ...row, options: options.get(row.product.id) ?? [] }]));
}

/**
 * Devis du panier calculé par le serveur (prix, promotion, stock, prix sur mesure), sans créer de commande.
 * Le panier du navigateur n'est qu'une liste de produits, quantités et mesures : son affichage
 * de prix est remplacé par ces valeurs.
 */
export async function quoteCart(lines: Array<{ productSlug: string; quantity: number; widthCm?: number | string; heightCm?: number | string; optionIds?: number[]; neon?: NeonLineRequest & { shopSlug: string } }>) {
  const bySlug = await loadSellableProducts(Array.from(new Set(lines.filter((line) => !line.neon).map((line) => line.productSlug))));
  const requested = new Map<string, number>();
  for (const line of lines) requested.set(line.productSlug, (requested.get(line.productSlug) ?? 0) + line.quantity);

  const quoted = await Promise.all(lines.map(async (line) => {
    // Néon personnalisé : prix recalculé depuis l'offre ACTUELLE de l'atelier
    if (line.neon) {
      const { shop, priced } = await priceNeonLine(line.neon.shopSlug, line.neon);
      return priced.ok
        ? { productSlug: NEON_PRODUCT_SLUG, available: true, unitPriceTnd: priced.priceTnd, regularPriceTnd: priced.priceTnd, maxQuantity: 20, problem: null, imageUrl: null, name: NEON_PRODUCT_NAME, custom: null, neon: priced, shopName: shop?.name ?? null }
        : { productSlug: NEON_PRODUCT_SLUG, available: false, unitPriceTnd: 0, regularPriceTnd: 0, maxQuantity: 0, problem: priced.error, imageUrl: null, name: NEON_PRODUCT_NAME, custom: null, neon: null, shopName: shop?.name ?? null };
    }
    const entry = bySlug.get(line.productSlug);
    if (!entry) return { productSlug: line.productSlug, available: false, unitPriceTnd: 0, regularPriceTnd: 0, maxQuantity: 0, problem: "Ce produit n'est plus disponible à la vente.", custom: null };
    const row = entry.product;
    let regular = Number(row.priceTnd);
    let unit = effectivePrice(regular, row.promoPriceTnd == null ? null : Number(row.promoPriceTnd));
    let custom: CustomPriceSuccess | null = null;
    let problem: string | null = null;
    if (isCustomProduct(row)) {
      const priced = priceCustomLine(row, entry.options, line);
      if (priced.ok) {
        custom = priced;
        regular = priced.regularPriceTnd;
        unit = priced.priceTnd;
      } else {
        problem = priced.error;
        regular = 0;
        unit = 0;
      }
    }
    const tracked = row.availability === "in_stock";
    const stock = row.stock ?? 0;
    if (problem) { /* mesures invalides : déjà signalé */ }
    else if (row.availability === "out_of_stock" || (tracked && stock <= 0)) problem = "Rupture de stock.";
    else if (tracked && (requested.get(line.productSlug) ?? 0) > stock) problem = `Stock insuffisant : ${stock} disponible(s).`;
    return { productSlug: line.productSlug, available: problem === null, unitPriceTnd: unit, regularPriceTnd: regular, maxQuantity: tracked ? stock : 99, problem, imageUrl: row.imageUrl, name: row.name, custom };
  }));
  const subtotalTnd = Math.round(quoted.reduce((sum, q, i) => sum + (q.available ? q.unitPriceTnd * lines[i].quantity : 0), 0) * 100) / 100;
  return { lines: quoted, subtotalTnd, totalTnd: subtotalTnd, hasProblems: quoted.some((q) => !q.available) };
}

/**
 * Ne fait jamais confiance aux prix, boutiques ou identifiants envoyés par le navigateur :
 * chaque ligne est recalculée depuis la base (produits vendeurs publiés d'une boutique active).
 */
export async function resolveCheckoutItems(items: CheckoutOrderItem[]): Promise<CheckoutOrderItem[]> {
  const bySlug = await loadSellableProducts(Array.from(new Set(items.filter((item) => !item.neon).map((item) => item.productSlug))));

  return Promise.all(items.map(async (item) => {
    if (item.neon) {
      // Néon : atelier, offre et prix relus en base ; le prix et le nom envoyés par le navigateur sont ignorés.
      // La ligne appartient à l'atelier de la page /neon/<slug> : une ligne annoncée chez un autre atelier est refusée.
      if (item.shopSlug && item.shopSlug !== item.neon.shopSlug) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `${NEON_PRODUCT_NAME} : la ligne ne correspond pas à l'atelier choisi. Recréez votre néon depuis la page de l'atelier.` });
      }
      const { shop, priced } = await priceNeonLine(item.neon.shopSlug, item.neon);
      if (!shop || !priced.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `${NEON_PRODUCT_NAME} : ${priced.ok ? "atelier indisponible" : priced.error}` });
      return {
        ...item, productId: undefined, shopId: shop.id, productSlug: NEON_PRODUCT_SLUG, productName: NEON_PRODUCT_NAME, shopSlug: shop.slug, shopName: shop.name,
        unitPriceTnd: priced.priceTnd, selectedColor: undefined, personalization: undefined, widthCm: undefined, heightCm: undefined, optionIds: undefined, custom: undefined, neonPriced: priced,
      };
    }
    const entry = bySlug.get(item.productSlug);
    if (entry) {
      const dbProduct = entry.product;
      if (dbProduct.availability === "out_of_stock" || (dbProduct.availability === "in_stock" && (dbProduct.stock ?? 0) <= 0)) {
        throw new Error(`« ${dbProduct.name} » est en rupture de stock. Retirez-le de votre panier.`);
      }
      const base = { ...item, productId: dbProduct.id, shopId: entry.shopId, productName: dbProduct.name, shopSlug: entry.shopSlug, shopName: entry.shopName };
      if (isCustomProduct(dbProduct)) {
        // Prix recalculé depuis les mesures : le prix envoyé par le navigateur est ignoré
        const priced = priceCustomLine(dbProduct, entry.options, item);
        if (!priced.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `« ${dbProduct.name} » : ${priced.error}` });
        return { ...base, unitPriceTnd: priced.priceTnd, custom: priced };
      }
      // Produit à prix fixe : comportement historique, les mesures éventuelles sont ignorées
      const unitPriceTnd = effectivePrice(Number(dbProduct.priceTnd), dbProduct.promoPriceTnd == null ? null : Number(dbProduct.promoPriceTnd));
      return { ...base, unitPriceTnd, widthCm: undefined, heightCm: undefined, optionIds: undefined, custom: undefined };
    }
    // Les produits du catalogue de démonstration ne sont pas vendables : seuls les produits vendeurs publiés le sont
    throw new Error(`Le produit « ${item.productName} » n'est plus disponible. Retirez-le de votre panier.`);
  }));
}

export async function createOrderWithCommissions(userId: number, input: {
  totalTnd?: number;
  shippingName: string;
  shippingPhone: string;
  shippingAddress: string;
  shippingCity: string;
  shippingNote?: string;
  items: CheckoutOrderItem[];
}) {
  const db = await getDb();
  if (!db) return { orderId: null, reference: null };
  if (input.items.length === 0) throw new Error("Une commande doit contenir au moins un article");

  const items = await resolveCheckoutItems(input.items);
  const totalTnd = Math.round(items.reduce((sum, item) => sum + item.unitPriceTnd * item.quantity, 0) * 100) / 100;
  const commissionRate = (await getSettings()).commissionRate / 100;

  const orderId = await db.transaction(async (tx) => {
    const orderResult = await tx.insert(orders).values({
      userId,
      totalTnd: totalTnd.toFixed(2),
      shippingName: input.shippingName,
      shippingPhone: input.shippingPhone,
      shippingAddress: input.shippingAddress,
      shippingCity: input.shippingCity,
      shippingNote: input.shippingNote ?? null,
      status: "pending",
    });
    const inserted = (orderResult as unknown as Array<{ insertId?: number }>)[0];
    const id = Number(inserted?.insertId ?? 0);
    if (!id) throw new Error("La commande n'a pas pu être créée");

    // Réservation du stock des produits suivis en quantité (mise à jour conditionnelle atomique)
    const quantities = new Map<number, { quantity: number; name: string }>();
    for (const item of items) {
      if (!item.productId) continue;
      const current = quantities.get(item.productId) ?? { quantity: 0, name: item.productName };
      current.quantity += item.quantity;
      quantities.set(item.productId, current);
    }
    for (const [productId, { quantity, name }] of Array.from(quantities.entries())) {
      const tracked = (await tx.select({ availability: products.availability, stock: products.stock }).from(products).where(eq(products.id, productId)).limit(1))[0];
      if (!tracked || tracked.availability !== "in_stock") continue;
      const update = await tx.update(products).set({ stock: sql`${products.stock} - ${quantity}` }).where(and(eq(products.id, productId), sql`${products.stock} >= ${quantity}`));
      const affected = Number((update as unknown as Array<{ affectedRows?: number }>)[0]?.affectedRows ?? 0);
      if (!affected) {
        throw new Error(`Stock insuffisant pour « ${name} » : ${tracked.stock ?? 0} disponible(s).`);
      }
    }

    await tx.insert(orderItems).values(items.map((item) => ({
      orderId: id,
      productId: item.productId ?? null,
      shopId: item.shopId ?? null,
      productSlug: item.productSlug,
      productName: item.productName,
      shopSlug: item.shopSlug,
      shopName: item.shopName,
      quantity: item.quantity,
      unitPriceTnd: item.unitPriceTnd.toFixed(2),
      selectedColor: item.selectedColor ?? null,
      personalization: item.personalization ?? null,
      // Instantané FIGÉ : un changement de prix du vendeur ne modifie jamais une commande passée
      pricingMode: item.custom ? item.custom.mode : item.neonPriced ? "neon" : null,
      widthCm: item.custom ? item.custom.widthCm : item.neonPriced ? item.neonPriced.size.widthCm : null,
      heightCm: item.custom ? item.custom.heightCm : item.neonPriced ? item.neonPriced.heightCm : null,
      areaM2: item.custom ? item.custom.areaM2.toFixed(4) : null,
      billedAreaM2: item.custom ? item.custom.billedAreaM2.toFixed(4) : null,
      appliedUnitPriceTnd: item.custom ? item.custom.unitPriceTnd.toFixed(3) : item.neonPriced ? item.neonPriced.priceTnd.toFixed(3) : null,
      optionsJson: item.custom ? JSON.stringify(item.custom.options) : null,
      lineTotalTnd: (Math.round(item.unitPriceTnd * 100) * item.quantity / 100).toFixed(2),
      // Néon : texte exact, style et détail du prix FIGÉS (un changement de tarif de l'atelier ne les modifie jamais)
      ...(item.neonPriced ? {
        neonText: item.neonPriced.text,
        neonScript: item.neonPriced.script,
        neonFont: item.neonPriced.font.key,
        neonColorName: item.neonPriced.color.name,
        neonColorHex: item.neonPriced.color.hex,
        neonSize: item.neonPriced.size.code,
        neonSupport: item.neonPriced.support.code,
        neonOutdoor: item.neonPriced.outdoor ? 1 : 0,
        neonDetailsJson: JSON.stringify({
          letters: item.neonPriced.letters, extraLetters: item.neonPriced.extraLetters,
          supportName: item.neonPriced.support.name,
          basePriceTnd: item.neonPriced.basePriceTnd, letterSurchargeTnd: item.neonPriced.letterSurchargeTnd,
          supportSurchargeTnd: item.neonPriced.supportSurchargeTnd, outdoorSurchargeTnd: item.neonPriced.outdoorSurchargeTnd,
          priceTnd: item.neonPriced.priceTnd, productionDays: item.neonPriced.productionDays,
        }),
      } : {}),
    })));

    const grouped = new Map<string, { shopId?: number; shopSlug: string; grossTnd: number }>();
    for (const item of items) {
      const key = item.shopId ? `id:${item.shopId}` : `slug:${item.shopSlug}`;
      const current = grouped.get(key) ?? { shopId: item.shopId, shopSlug: item.shopSlug, grossTnd: 0 };
      current.grossTnd += item.unitPriceTnd * item.quantity;
      grouped.set(key, current);
    }
    await tx.insert(commissions).values(Array.from(grouped.values()).map((group) => {
      const commission = calculateCommission(Math.round(group.grossTnd * 100) / 100, commissionRate);
      return {
        orderId: id,
        shopId: group.shopId ?? null,
        shopSlug: group.shopSlug,
        grossTnd: commission.grossTnd.toFixed(2),
        commissionTnd: commission.commissionTnd.toFixed(2),
        vendorPayoutTnd: commission.vendorPayoutTnd.toFixed(2),
        status: "pending" as const,
      };
    }));
    return id;
  });

  return { orderId, reference: `ED-${String(orderId).padStart(6, "0")}`, totalTnd };
}

/** Colonnes figées d'une ligne sur mesure, lues partout où une commande est affichée. */
export const customOrderItemFields = {
  pricingMode: orderItems.pricingMode,
  widthCm: orderItems.widthCm,
  heightCm: orderItems.heightCm,
  areaM2: orderItems.areaM2,
  billedAreaM2: orderItems.billedAreaM2,
  appliedUnitPriceTnd: orderItems.appliedUnitPriceTnd,
  optionsJson: orderItems.optionsJson,
  lineTotalTnd: orderItems.lineTotalTnd,
  neonText: orderItems.neonText,
  neonScript: orderItems.neonScript,
  neonFont: orderItems.neonFont,
  neonColorName: orderItems.neonColorName,
  neonColorHex: orderItems.neonColorHex,
  neonSize: orderItems.neonSize,
  neonSupport: orderItems.neonSupport,
  neonOutdoor: orderItems.neonOutdoor,
  neonDetailsJson: orderItems.neonDetailsJson,
};

type NeonOrderColumns = {
  neonText?: string | null; neonScript?: string | null; neonFont?: string | null; neonColorName?: string | null; neonColorHex?: string | null;
  neonSize?: string | null; neonSupport?: string | null; neonOutdoor?: number | null; neonDetailsJson?: string | null;
};

/** Ligne néon FIGÉE lisible par les espaces vendeur, client et admin (null pour les autres lignes). */
export function readNeonOrderLine(item: NeonOrderColumns & { widthCm: number | null; heightCm: number | null }) {
  if (!item.neonText) return null;
  let details: Record<string, unknown> = {};
  try { details = JSON.parse(item.neonDetailsJson ?? "{}"); } catch { /* détail illisible : champs principaux seulement */ }
  const font = neonFont(item.neonFont ?? "");
  return {
    text: item.neonText,
    script: item.neonScript === "arabic" ? "arabic" as const : "latin" as const,
    fontKey: item.neonFont ?? "",
    fontName: font?.name ?? item.neonFont ?? "",
    colorName: item.neonColorName ?? "",
    colorHex: item.neonColorHex ?? "#FFFFFF",
    size: item.neonSize ?? "",
    widthCm: item.widthCm,
    heightCm: item.heightCm,
    supportName: typeof details.supportName === "string" ? details.supportName : item.neonSupport ?? "",
    outdoor: item.neonOutdoor === 1,
    letters: typeof details.letters === "number" ? details.letters : null,
    productionDays: (details.productionDays as { min: number | null; max: number | null } | undefined) ?? null,
  };
}

/** Ajoute à une ligne de commande ses options figées et le résumé « 80 × 150 cm · 1,2 m² · Cadre doré ». */
export function withCustomSummary<T extends { pricingMode: string | null; widthCm: number | null; heightCm: number | null; areaM2: string | null; optionsJson: string | null } & NeonOrderColumns>(item: T) {
  const neon = readNeonOrderLine(item);
  if (neon) {
    const { optionsJson: _raw, neonDetailsJson: _details, ...rest } = item;
    return { ...rest, options: [], neon, customSummary: describeNeonLine(neon) };
  }
  const options = parseOrderOptions(item.optionsJson);
  const { optionsJson: _raw, ...rest } = item;
  return { ...rest, options, neon: null, customSummary: describeCustomLine({ ...item, options }) };
}

/** Détail d'une commande, uniquement si elle appartient au client connecté. */
export async function getClientOrderDetail(userId: number, orderId: number) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  const order = (await db.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.userId, userId))).limit(1))[0];
  if (!order) return null;
  const items = await db.select({
    id: orderItems.id,
    productSlug: orderItems.productSlug,
    productName: orderItems.productName,
    shopSlug: orderItems.shopSlug,
    shopName: orderItems.shopName,
    quantity: orderItems.quantity,
    unitPriceTnd: orderItems.unitPriceTnd,
    selectedColor: orderItems.selectedColor,
    personalization: orderItems.personalization,
    ...customOrderItemFields,
  }).from(orderItems).where(eq(orderItems.orderId, orderId));
  return { ...order, reference: `ED-${String(order.id).padStart(6, "0")}`, items: items.map(withCustomSummary) };
}

export async function getAdminDashboardData() {
  const db = await getDb();
  if (!db) return {
    stats: {
      userCount: 0,
      customerCount: 0,
      vendorCount: 0,
      adminCount: 0,
      shopCount: 0,
      pendingShopCount: 0,
      activeShopCount: 0,
      suspendedShopCount: 0,
      productCount: 0,
      orderCount: 0,
      grossSalesTnd: 0,
      commissionTnd: 0,
      pendingReviewCount: 0,
      reviewCount: 0,
    },
    users: [],
    shops: [],
    reviews: [],
    products: [],
    orders: [],
    commissions: [],
  };

  const [
    userRows,
    customerCountRow,
    vendorCountRow,
    adminCountRow,
    shopCountRow,
    pendingShopCountRow,
    activeShopCountRow,
    suspendedShopCountRow,
    productCountRow,
    orderCountRow,
    salesRow,
    commissionRow,
    reviewCountRow,
    pendingReviewRow,
    usersList,
    shopsList,
    reviewRows,
    productsList,
    ordersList,
    commissionsList,
  ] = await Promise.all([
    db.select({ value: count() }).from(users),
    db.select({ value: count() }).from(users).where(eq(users.role, "user")),
    db.select({ value: count() }).from(users).where(eq(users.role, "vendor")),
    db.select({ value: count() }).from(users).where(eq(users.role, "admin")),
    db.select({ value: count() }).from(shops),
    db.select({ value: count() }).from(shops).where(eq(shops.status, "pending")),
    db.select({ value: count() }).from(shops).where(eq(shops.status, "active")),
    db.select({ value: count() }).from(shops).where(eq(shops.status, "suspended")),
    db.select({ value: count() }).from(products),
    db.select({ value: count() }).from(orders),
    db.select({ value: sql<string>`COALESCE(SUM(${orders.totalTnd}), 0)` }).from(orders),
    db.select({ value: sql<string>`COALESCE(SUM(${commissions.commissionTnd}), 0)` }).from(commissions).where(sql`${commissions.status} <> 'refunded'`),
    db.select({ value: count() }).from(reviews),
    db.select({ value: count() }).from(reviews).where(eq(reviews.status, "pending")),
    db.select({ id: users.id, name: users.name, firstName: users.firstName, lastName: users.lastName, email: users.email, phone: users.phone, city: users.city, address: users.address, role: users.role, suspended: users.suspended, createdAt: users.createdAt }).from(users).orderBy(desc(users.createdAt)).limit(100),
    db.select({
      id: shops.id,
      name: shops.name,
      slug: shops.slug,
      tagline: shops.tagline,
      about: shops.about,
      coverUrl: shops.coverUrl,
      logoUrl: shops.logoUrl,
      phone: shops.phone,
      whatsapp: shops.whatsapp,
      address: shops.address,
      city: shops.city,
      socialInstagram: shops.socialInstagram,
      socialFacebook: shops.socialFacebook,
      socialWebsite: shops.socialWebsite,
      openingHours: shops.openingHours,
      status: shops.status,
      rejectionReason: shops.rejectionReason,
      termsAccepted: shops.termsAccepted,
      termsVersion: shops.termsVersion,
      termsAcceptedAt: shops.termsAcceptedAt,
      userId: shops.userId,
      userName: users.name,
      userFirstName: users.firstName,
      userLastName: users.lastName,
      userEmail: users.email,
      userPhone: users.phone,
      userCity: users.city,
      createdAt: shops.createdAt,
    })
      .from(shops)
      .leftJoin(users, eq(shops.userId, users.id))
      .orderBy(desc(shops.createdAt))
      .limit(100),
    db.select({ id: reviews.id, productName: reviews.productName, productSlug: reviews.productSlug, shopSlug: reviews.shopSlug, rating: reviews.rating, body: reviews.body, status: reviews.status, createdAt: reviews.createdAt }).from(reviews).orderBy(desc(reviews.createdAt)).limit(100),
    db.select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      category: products.category,
      priceTnd: products.priceTnd,
      imageUrl: products.imageUrl,
      status: products.status,
      stock: products.stock,
      shopId: products.shopId,
      shopName: shops.name,
      createdAt: products.createdAt,
    })
      .from(products)
      .leftJoin(shops, eq(products.shopId, shops.id))
      .orderBy(desc(products.createdAt))
      .limit(100),
    db.select({
      id: orders.id,
      userId: orders.userId,
      totalTnd: orders.totalTnd,
      status: orders.status,
      shippingName: orders.shippingName,
      shippingPhone: orders.shippingPhone,
      shippingCity: orders.shippingCity,
      createdAt: orders.createdAt,
    })
      .from(orders)
      .orderBy(desc(orders.createdAt))
      .limit(100),
    db.select({
      id: commissions.id,
      orderId: commissions.orderId,
      shopId: commissions.shopId,
      shopSlug: commissions.shopSlug,
      grossTnd: commissions.grossTnd,
      commissionTnd: commissions.commissionTnd,
      vendorPayoutTnd: commissions.vendorPayoutTnd,
      status: commissions.status,
      createdAt: commissions.createdAt,
    })
      .from(commissions)
      .orderBy(desc(commissions.createdAt))
      .limit(100),
  ]);

  return {
    stats: {
      userCount: Number(userRows[0]?.value ?? 0),
      customerCount: Number(customerCountRow[0]?.value ?? 0),
      vendorCount: Number(vendorCountRow[0]?.value ?? 0),
      adminCount: Number(adminCountRow[0]?.value ?? 0),
      shopCount: Number(shopCountRow[0]?.value ?? 0),
      pendingShopCount: Number(pendingShopCountRow[0]?.value ?? 0),
      activeShopCount: Number(activeShopCountRow[0]?.value ?? 0),
      suspendedShopCount: Number(suspendedShopCountRow[0]?.value ?? 0),
      productCount: Number(productCountRow[0]?.value ?? 0),
      orderCount: Number(orderCountRow[0]?.value ?? 0),
      grossSalesTnd: Number(salesRow[0]?.value ?? 0),
      commissionTnd: Number(commissionRow[0]?.value ?? 0),
      reviewCount: Number(reviewCountRow[0]?.value ?? 0),
      pendingReviewCount: Number(pendingReviewRow[0]?.value ?? 0),
    },
    users: usersList,
    shops: shopsList,
    reviews: reviewRows,
    products: productsList,
    orders: ordersList,
    commissions: commissionsList,
  };
}

export async function updateShopStatus(
  shopId: number,
  status: "pending" | "active" | "suspended" | "rejected",
  rejectionReason?: string
) {
  const db = await getDb();
  if (!db) return false;
  
  const shop = (await db.select().from(shops).where(eq(shops.id, shopId)).limit(1))[0];
  if (!shop) throw new Error("Boutique introuvable");

  // `rejectionReason` conserve le motif du dernier refus ou de la dernière suspension.
  const updateSet: Record<string, unknown> = { status };
  if ((status === "rejected" || status === "suspended") && rejectionReason !== undefined) {
    updateSet.rejectionReason = rejectionReason.trim() || null;
  } else if (status === "active") {
    updateSet.rejectionReason = null;
  }

  await db.update(shops).set(updateSet).where(eq(shops.id, shopId));

  // Boutique approuvée : son propriétaire doit avoir le rôle vendeur (jamais de rétrogradation d'un admin)
  if (status === "active") {
    await db.update(users).set({ role: "vendor" }).where(and(eq(users.id, shop.userId), eq(users.role, "user")));
  }
  return true;
}

export async function adminModerateProduct(productId: number, input: { status?: "draft" | "pending" | "published"; delete?: boolean }) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");

  if (input.delete) {
    await deleteProductMediaFiles(productId);
    await db.delete(products).where(eq(products.id, productId));
    return { success: true, deleted: true };
  }

  if (input.status) {
    await db.update(products).set({ status: input.status }).where(eq(products.id, productId));
    return { success: true, status: input.status };
  }

  return { success: true };
}

/** L'administration change le statut de toute la commande (toutes boutiques) et l'historise. */
export async function adminUpdateOrderStatus(orderId: number, status: FulfillmentStatus, adminUserId?: number, note?: string) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  const order = (await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).limit(1))[0];
  if (!order) throw new Error("Commande introuvable");
  if (order.status === status) return { success: true, status };
  // Une annulation a réintégré le stock : la réactiver créerait un stock incohérent
  if (order.status === "cancelled") throw new Error("Une commande annulée ne peut pas être réactivée. Le client doit passer une nouvelle commande.");

  await db.transaction(async (tx) => {
    if (status === "cancelled") await restockItems(tx, and(eq(orderItems.orderId, orderId), sql`${orderItems.fulfillmentStatus} <> 'cancelled'`)!);
    await tx.update(orders).set({ status }).where(eq(orders.id, orderId));
    await tx.update(orderItems).set({ fulfillmentStatus: status }).where(eq(orderItems.orderId, orderId));
    // Une commande annulée n'est pas due : ses commissions passent en « remboursé »
    if (status === "cancelled") await tx.update(commissions).set({ status: "refunded" }).where(and(eq(commissions.orderId, orderId), eq(commissions.status, "pending")));
    await tx.insert(orderStatusHistory).values({ orderId, shopId: null, fromStatus: order.status, toStatus: status, changedByUserId: adminUserId ?? null, changedByRole: "admin", note: note?.trim() || null });
  });
  return { success: true, status };
}

export async function updateReviewStatus(reviewId: number, status: "pending" | "published" | "rejected") {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  const existing = await db.select({ id: reviews.id, status: reviews.status }).from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!existing[0]) throw new Error("Avis introuvable");
  assertReviewStatusChange(existing[0].status, status);
  const result = await db.update(reviews).set({ status }).where(eq(reviews.id, reviewId));
  const affectedRows = Number((result as unknown as { affectedRows?: number }).affectedRows ?? 1);
  if (affectedRows === 0 && existing[0].status !== status) throw new Error("Le statut de l'avis n'a pas pu être mis à jour");
  return true;
}

export type ConversationInput = {
  shopSlug: string;
  body: string;
  subject?: string;
};

async function getConversationForParticipant(userId: number, conversationId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(conversations).where(and(
    eq(conversations.id, conversationId),
    or(eq(conversations.clientId, userId), eq(conversations.vendorId, userId)),
  )).limit(1);
  return rows[0];
}

export async function getPublicShopContact(shopSlug: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select({ id: shops.id, userId: shops.userId, slug: shops.slug, name: shops.name, status: shops.status }).from(shops).where(and(eq(shops.slug, shopSlug), eq(shops.status, "active"))).limit(1);
  return rows[0];
}

export async function getUserConversations(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ id: conversations.id, clientId: conversations.clientId, vendorId: conversations.vendorId, shopId: conversations.shopId, shopSlug: conversations.shopSlug, shopName: conversations.shopName, subject: conversations.subject, lastMessageAt: conversations.lastMessageAt, createdAt: conversations.createdAt }).from(conversations).where(or(eq(conversations.clientId, userId), eq(conversations.vendorId, userId))).orderBy(desc(conversations.lastMessageAt)).limit(50);
  if (!rows.length) return [];
  const participantIds = Array.from(new Set(rows.map((row) => row.clientId === userId ? row.vendorId : row.clientId)));
  const participantRows = participantIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, participantIds)) : [];
  const participantNames = new Map(participantRows.map((participant) => [participant.id, participant.name]));
  return Promise.all(rows.map(async (row) => {
    const unreadRows = await db.select({ value: count() }).from(messages).where(and(eq(messages.conversationId, row.id), sql`${messages.senderId} <> ${userId}`, isNull(messages.readAt)));
    const participantId = row.clientId === userId ? row.vendorId : row.clientId;
    return { ...row, participantId, participantName: participantNames.get(participantId) ?? (row.clientId === userId ? row.shopName : "Client"), unreadCount: Number(unreadRows[0]?.value ?? 0) };
  }));
}

export async function getConversationMessages(userId: number, conversationId: number) {
  const db = await getDb();
  if (!db) return { conversation: undefined, messages: [] };
  const conversation = await getConversationForParticipant(userId, conversationId);
  if (!conversation) throw new Error("Conversation introuvable ou accès refusé");
  await db.update(messages).set({ readAt: new Date() }).where(and(eq(messages.conversationId, conversationId), sql`${messages.senderId} <> ${userId}`, isNull(messages.readAt)));
  const messageRows = await db.select({ id: messages.id, senderId: messages.senderId, body: messages.body, readAt: messages.readAt, createdAt: messages.createdAt }).from(messages).where(eq(messages.conversationId, conversationId)).orderBy(messages.createdAt).limit(100);
  return { conversation, messages: messageRows };
}

export async function startConversation(userId: number, input: ConversationInput) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  const body = input.body.trim();
  if (!body) throw new Error("Le message ne peut pas être vide");
  const shop = await getPublicShopContact(input.shopSlug);
  if (!shop) throw new Error("Cette boutique n'est pas encore disponible pour la messagerie");
  if (shop.userId === userId) throw new Error("Vous ne pouvez pas vous écrire à vous-même");
  return db.transaction(async (tx) => {
    const existingRows = await tx.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.clientId, userId), eq(conversations.vendorId, shop.userId), eq(conversations.shopSlug, shop.slug))).limit(1);
    let conversationId = existingRows[0]?.id;
    if (!conversationId) {
      const result = await tx.insert(conversations).values({ clientId: userId, vendorId: shop.userId, shopId: shop.id, shopSlug: shop.slug, shopName: shop.name, subject: input.subject?.trim() || null, lastMessageAt: new Date() });
      conversationId = Number(((result as unknown as Array<{ insertId?: number }>)[0]?.insertId ?? 0));
    }
    if (!conversationId) throw new Error("La conversation n'a pas pu être créée");
    await tx.insert(messages).values({ conversationId, senderId: userId, body });
    await tx.update(conversations).set({ lastMessageAt: new Date(), subject: input.subject?.trim() || undefined }).where(eq(conversations.id, conversationId));
    return { conversationId };
  });
}

export async function sendConversationMessage(userId: number, conversationId: number, bodyInput: string) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  const body = bodyInput.trim();
  if (!body) throw new Error("Le message ne peut pas être vide");
  const conversation = await getConversationForParticipant(userId, conversationId);
  if (!conversation) throw new Error("Conversation introuvable ou accès refusé");
  await db.insert(messages).values({ conversationId, senderId: userId, body });
  await db.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, conversationId));
  return { sent: true };
}

export async function markConversationRead(userId: number, conversationId: number) {
  const db = await getDb();
  if (!db) return { marked: false };
  const conversation = await getConversationForParticipant(userId, conversationId);
  if (!conversation) throw new Error("Conversation introuvable ou accès refusé");
  await db.update(messages).set({ readAt: new Date() }).where(and(eq(messages.conversationId, conversationId), sql`${messages.senderId} <> ${userId}`, isNull(messages.readAt)));
  return { marked: true };
}

export async function getCatalogProducts(filters?: {
  search?: string;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: "pertinence" | "prix_asc" | "prix_desc" | "note_desc" | "recent";
}) {
  const db = await getDb();
  if (!db) return [];

  // Build query with joins to get shop info and review stats
  const rows = await db.select({
    id: products.id,
    name: products.name,
    slug: products.slug,
    category: products.category,
    priceTnd: products.priceTnd,
    description: products.description,
    material: products.material,
    dimensions: products.dimensions,
    delivery: products.delivery,
    imageUrl: products.imageUrl,
    badge: products.badge,
    tint: products.tint,
    createdAt: products.createdAt,
    promoPriceTnd: products.promoPriceTnd,
    availability: products.availability,
    stock: products.stock,
    pricingMode: products.pricingMode,
    categoryId: products.categoryId,
    parentCategoryName: sql<string | null>`(SELECT pc.name FROM categories c INNER JOIN categories pc ON pc.id = c.parentId WHERE c.id = ${products.categoryId})`,
    shopId: shops.id,
    shopName: shops.name,
    shopSlug: shops.slug,
    shopLogoUrl: shops.logoUrl,
  })
    .from(products)
    .innerJoin(shops, eq(products.shopId, shops.id))
    .where(and(eq(shops.status, "active"), eq(products.status, "published")))
    .orderBy(desc(products.createdAt))
    .limit(200);

  // Get review stats for all fetched products in one query
  const slugs = rows.map((r) => r.slug);
  const reviewStatsRows = slugs.length
    ? await db
        .select({
          productSlug: reviews.productSlug,
          reviewCount: count(),
          rating: sql<number | null>`avg(${reviews.rating})`,
        })
        .from(reviews)
        .where(and(inArray(reviews.productSlug, slugs), eq(reviews.status, "published")))
        .groupBy(reviews.productSlug)
    : [];

  const statsMap = new Map(
    reviewStatsRows.map((s) => [
      s.productSlug,
      {
        reviewCount: Number(s.reviewCount ?? 0),
        rating: s.rating === null || s.rating === undefined ? null : Number(s.rating),
      },
    ])
  );

  let results = rows.map((row) => {
    const stats = statsMap.get(row.slug) ?? { reviewCount: 0, rating: null };
    const regularPrice = Number(row.priceTnd);
    const promo = row.promoPriceTnd == null ? null : Number(row.promoPriceTnd);
    return {
      ...row,
      regularPriceTnd: regularPrice,
      promoPriceTnd: promo,
      // Prix réellement payé (promotion incluse) : utilisé pour le tri, les filtres et l'affichage
      priceTnd: effectivePrice(regularPrice, promo),
      availability: row.stock === 0 && row.availability === "in_stock" ? "out_of_stock" as const : row.availability,
      reviewCount: stats.reviewCount,
      rating: stats.rating,
      source: "db" as const,
    };
  });

  // Apply filters
  const { search, category, minPrice, maxPrice, sort } = filters ?? {};

  if (search) {
    const q = search.toLowerCase();
    results = results.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.shopName.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q)
    );
  }

  if (category && category !== "Toutes") {
    // Une catégorie principale inclut ses sous-catégories
    results = results.filter((p) => p.category === category || p.parentCategoryName === category);
  }

  if (minPrice !== undefined && !isNaN(minPrice)) {
    results = results.filter((p) => p.priceTnd >= minPrice);
  }

  if (maxPrice !== undefined && !isNaN(maxPrice)) {
    results = results.filter((p) => p.priceTnd <= maxPrice);
  }

  if (sort === "prix_asc") results.sort((a, b) => a.priceTnd - b.priceTnd);
  else if (sort === "prix_desc") results.sort((a, b) => b.priceTnd - a.priceTnd);
  else if (sort === "note_desc") results.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
  // "recent" and "pertinence" keep default createdAt DESC

  return results;
}

export async function getPublicShopData(shopSlug: string) {
  const db = await getDb();
  if (!db) return undefined;
  const shopRows = await db.select({
    id: shops.id, userId: shops.userId, name: shops.name, slug: shops.slug, tagline: shops.tagline, about: shops.about,
    coverUrl: shops.coverUrl, logoUrl: shops.logoUrl, city: shops.city, openingHours: shops.openingHours, deliveryInfo: shops.deliveryInfo,
    socialInstagram: shops.socialInstagram, socialFacebook: shops.socialFacebook, socialWebsite: shops.socialWebsite,
    whatsapp: shops.whatsapp, showWhatsapp: shops.showWhatsapp, phone: shops.phone, showPhone: shops.showPhone,
    status: shops.status, createdAt: shops.createdAt,
  }).from(shops).where(and(eq(shops.slug, shopSlug), eq(shops.status, "active"))).limit(1);
  const fullShop = shopRows[0];
  if (!fullShop) return undefined;
  // Coordonnées : uniquement celles que le vendeur a choisi de rendre publiques
  const { whatsapp, showWhatsapp, phone, showPhone, ...shopRest } = fullShop;
  const shop = { ...shopRest, whatsapp: showWhatsapp ? whatsapp : null, phone: showPhone ? phone : null };
  const productRows = await db.select({ id: products.id, name: products.name, slug: products.slug, category: products.category, shopCategoryId: products.shopCategoryId, pricingMode: products.pricingMode, priceTnd: products.priceTnd, promoPriceTnd: products.promoPriceTnd, availability: products.availability, stock: products.stock, description: products.description, imageUrl: products.imageUrl, badge: products.badge, tint: products.tint, createdAt: products.createdAt }).from(products).where(and(eq(products.shopId, shop.id), eq(products.status, "published"))).orderBy(desc(products.createdAt)).limit(60);
  const reviewStats = await db.select({ reviewCount: count(), rating: sql<number | null>`avg(${reviews.rating})` }).from(reviews).where(and(eq(reviews.shopSlug, shop.slug), eq(reviews.status, "published")));
  // Onglets de la boutique : uniquement les catégories du vendeur qui contiennent des produits publiés
  const shopCategoryTabs = await listPublicShopCategories(shop.id);
  return { shop, products: productRows, categories: shopCategoryTabs, reviewCount: Number(reviewStats[0]?.reviewCount ?? 0), rating: reviewStats[0]?.rating === null || reviewStats[0]?.rating === undefined ? null : Number(reviewStats[0].rating) };
}

export async function getPublicProductData(productSlug: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select({
    id: products.id,
    name: products.name,
    slug: products.slug,
    category: products.category,
    priceTnd: products.priceTnd,
    description: products.description,
    material: products.material,
    dimensions: products.dimensions,
    delivery: products.delivery,
    imageUrl: products.imageUrl,
    badge: products.badge,
    tint: products.tint,
    shopId: shops.id,
    shopUserId: shops.userId,
    shopName: shops.name,
    shopSlug: shops.slug,
    shopTagline: shops.tagline,
    shopAbout: shops.about,
    shopCoverUrl: shops.coverUrl,
    shopLogoUrl: shops.logoUrl,
    shopCity: shops.city,
    shopSocialFacebook: shops.socialFacebook,
    shopSocialInstagram: shops.socialInstagram,
    pricingMode: products.pricingMode,
    unitPriceTnd: products.unitPriceTnd,
    minWidthCm: products.minWidthCm,
    maxWidthCm: products.maxWidthCm,
    minHeightCm: products.minHeightCm,
    maxHeightCm: products.maxHeightCm,
    minBillableArea: products.minBillableArea,
    minPriceTnd: products.minPriceTnd,
    promoPercent: products.promoPercent,
    promoPriceTnd: products.promoPriceTnd,
    availability: products.availability,
    stock: products.stock,
    sku: products.sku,
    variants: products.variants,
    preparationTime: products.preparationTime,
    extraInfo: products.extraInfo,
    videoUrl: products.videoUrl,
  }).from(products).innerJoin(shops, eq(products.shopId, shops.id)).where(and(eq(products.slug, productSlug), eq(products.status, "published"), eq(shops.status, "active"))).limit(1);
  const row = rows[0];
  if (!row) return undefined;
  const reviewStats = await db.select({ reviewCount: count(), rating: sql<number | null>`avg(${reviews.rating})` }).from(reviews).where(and(eq(reviews.productSlug, row.slug), eq(reviews.status, "published")));
  const files = await getPublicProductMedia(row.id);
  const otherProducts = await db.select({ id: products.id, name: products.name, slug: products.slug, priceTnd: products.priceTnd, promoPriceTnd: products.promoPriceTnd, imageUrl: products.imageUrl })
    .from(products).where(and(eq(products.shopId, row.shopId), eq(products.status, "published"), sql`${products.id} <> ${row.id}`)).orderBy(desc(products.createdAt)).limit(8);
  const regularPrice = Number(row.priceTnd);
  const promo = row.promoPriceTnd == null ? null : Number(row.promoPriceTnd);
  const product = {
    ...row,
    regularPriceTnd: regularPrice,
    promoPriceTnd: promo,
    effectivePriceTnd: effectivePrice(regularPrice, promo),
    availability: row.stock === 0 && row.availability === "in_stock" ? "out_of_stock" as const : row.availability,
    variants: parseVariants(row.variants),
    images: files.images.length ? files.images : row.imageUrl ? [{ id: 0, url: row.imageUrl }] : [],
    video: files.video,
    // Options du produit sur mesure (le prix affiché en direct n'est qu'une estimation : le serveur recalcule)
    options: isCustomProduct(row)
      ? ((await loadProductOptions([row.id])).get(row.id) ?? []).map((o) => ({ id: o.id, name: o.name, surchargeType: o.surchargeType, amountTnd: Number(o.amountTnd) }))
      : [],
  };
  return {
    product,
    otherProducts: otherProducts.map((p) => ({ ...p, priceTnd: Number(p.priceTnd), promoPriceTnd: p.promoPriceTnd == null ? null : Number(p.promoPriceTnd) })),
    reviewCount: Number(reviewStats[0]?.reviewCount ?? 0),
    rating: reviewStats[0]?.rating === null || reviewStats[0]?.rating === undefined ? null : Number(reviewStats[0].rating),
  };
}

// ===========================================================
// Native email/password auth
// ===========================================================

export const BCRYPT_ROUNDS = 12;

/** Message renvoyé quand l'e-mail est déjà utilisé (identique pour tous les types de comptes). */
export const EMAIL_TAKEN_MESSAGE = "Un compte avec cet email existe déjà";

async function assertEmailAvailable(email: string) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing[0]) throw new Error(EMAIL_TAKEN_MESSAGE);
}

/** Traduit une violation d'unicité MySQL (inscriptions simultanées) en message lisible. */
function rethrowDuplicate(error: unknown): never {
  const cause = (error as { cause?: { code?: string } })?.cause ?? (error as { code?: string });
  if (cause?.code === "ER_DUP_ENTRY") throw new Error(EMAIL_TAKEN_MESSAGE);
  throw error;
}

/** Crée un compte Client minimal (nom, email, mot de passe). Le rôle est toujours `user`. */
export async function createNativeUser(input: {
  name: string;
  email: string;
  password: string;
  phone?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");

  const email = normalizeEmail(input.email);
  await assertEmailAvailable(email);

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const openId = `native_${nanoid(24)}`;

  await db.insert(users).values({
    openId,
    name: input.name.trim(),
    email,
    phone: input.phone?.trim() || null,
    passwordHash,
    loginMethod: "email",
    role: "user",
    lastSignedIn: new Date(),
  }).catch(rethrowDuplicate);

  const row = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return row[0];
}

/** Crée un compte Client avec nom, prénom, email, téléphone, localisation et adresse de livraison. */
export async function createCustomerUser(input: {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  city: string;
  address: string;
  password: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");

  const email = normalizeEmail(input.email);
  await assertEmailAvailable(email);

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const openId = `native_${nanoid(24)}`;
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const fullName = `${firstName} ${lastName}`.trim();

  // Compte + adresse de livraison par défaut écrits ensemble ou pas du tout.
  const userId = await db.transaction(async (tx) => {
    const result = await tx.insert(users).values({
      openId,
      name: fullName,
      firstName,
      lastName,
      email,
      phone: input.phone.trim(),
      city: input.city.trim(),
      address: input.address.trim(),
      passwordHash,
      loginMethod: "email",
      role: "user",
      lastSignedIn: new Date(),
    });
    const id = Number(((result as unknown as Array<{ insertId?: number }>)[0]?.insertId ?? 0));
    if (!id) throw new Error("Erreur lors de la création du compte client");

    await tx.insert(addresses).values({
      userId: id,
      label: "Adresse de livraison",
      recipientName: fullName,
      phone: input.phone.trim(),
      city: input.city.trim(),
      addressLine: input.address.trim(),
      isDefault: 1,
    });
    return id;
  }).catch(rethrowDuplicate);

  const row = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!row) throw new Error("Erreur lors de la création du compte client");
  return row;
}

export const VENDOR_TERMS_VERSION = "v1.0-2026";

/**
 * Crée un compte Vendeur : utilisateur (rôle `vendor`) + profil boutique distinct
 * au statut `pending`. Le vendeur ne peut rien publier avant l'approbation admin.
 */
export async function createVendorUser(input: {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  city: string;
  shopName: string;
  whatsapp: string;
  password: string;
  termsAccepted: boolean;
  termsVersion?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");

  if (input.termsAccepted !== true) {
    throw new Error("Vous devez accepter les conditions générales d'utilisation pour créer un compte vendeur");
  }

  const email = normalizeEmail(input.email);
  await assertEmailAvailable(email);

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const openId = `native_${nanoid(24)}`;
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const fullName = `${firstName} ${lastName}`.trim();
  const shopName = input.shopName.trim();

  // Slug unique, sans collision avec les boutiques du catalogue éditorial
  const baseSlug = slugify(shopName) || "boutique";
  const existingShop = (await db.select({ id: shops.id }).from(shops).where(eq(shops.slug, baseSlug)).limit(1))[0];
  const takenByCatalog = catalogProducts.some((product) => product.shopSlug === baseSlug);
  const slug = existingShop || takenByCatalog ? `${baseSlug}-${nanoid(5).toLowerCase()}` : baseSlug;

  const userId = await db.transaction(async (tx) => {
    const result = await tx.insert(users).values({
      openId,
      name: fullName,
      firstName,
      lastName,
      email,
      phone: input.phone.trim(),
      city: input.city.trim(),
      passwordHash,
      loginMethod: "email",
      role: "vendor",
      lastSignedIn: new Date(),
    });
    const id = Number(((result as unknown as Array<{ insertId?: number }>)[0]?.insertId ?? 0));
    if (!id) throw new Error("Erreur lors de la création du compte vendeur");

    await tx.insert(shops).values({
      userId: id,
      name: shopName,
      slug,
      phone: input.phone.trim(),
      whatsapp: input.whatsapp.trim(),
      city: input.city.trim(),
      status: "pending", // STATUT INITIAL TOUJOURS EN ATTENTE
      termsAccepted: 1,
      termsVersion: input.termsVersion ?? VENDOR_TERMS_VERSION,
      termsAcceptedAt: new Date(),
    });
    return id;
  }).catch(rethrowDuplicate);

  const userRow = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  const shopRow = (await db.select().from(shops).where(eq(shops.userId, userId)).limit(1))[0];
  if (!userRow || !shopRow) throw new Error("Erreur lors de la création du compte vendeur");
  return { user: userRow, shop: shopRow };
}

/** Met à jour les informations du profil utilisateur et synchronise l'adresse de livraison par défaut. */
export async function updateUserProfile(userId: number, input: {
  firstName?: string;
  lastName?: string;
  phone?: string;
  city?: string;
  address?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");

  const updateSet: Record<string, unknown> = {};
  if (input.firstName !== undefined) updateSet.firstName = input.firstName.trim();
  if (input.lastName !== undefined) updateSet.lastName = input.lastName.trim();
  if (input.phone !== undefined) updateSet.phone = input.phone.trim();
  if (input.city !== undefined) updateSet.city = input.city.trim();
  if (input.address !== undefined) updateSet.address = input.address.trim();

  if (input.firstName !== undefined || input.lastName !== undefined) {
    const existing = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
    const fn = input.firstName !== undefined ? input.firstName.trim() : (existing?.firstName ?? "");
    const ln = input.lastName !== undefined ? input.lastName.trim() : (existing?.lastName ?? "");
    updateSet.name = `${fn} ${ln}`.trim();
  }

  if (Object.keys(updateSet).length > 0) {
    await db.update(users).set(updateSet).where(eq(users.id, userId));
  }

  // Synchronisation de l'adresse par défaut si adresse / ville / téléphone mis à jour
  if (input.address || input.city || input.phone) {
    const defaultAddr = (await db.select().from(addresses).where(and(eq(addresses.userId, userId), eq(addresses.isDefault, 1))).limit(1))[0];
    if (defaultAddr) {
      await db.update(addresses).set({
        city: input.city ?? defaultAddr.city,
        addressLine: input.address ?? defaultAddr.addressLine,
        phone: input.phone ?? defaultAddr.phone,
      }).where(eq(addresses.id, defaultAddr.id));
    } else if (input.address && input.city) {
      const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
      await db.insert(addresses).values({
        userId,
        label: "Adresse de livraison",
        recipientName: user?.name ?? "Client",
        phone: input.phone ?? user?.phone ?? "",
        city: input.city,
        addressLine: input.address,
        isDefault: 1,
      });
    }
  }

  const updatedUser = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  return updatedUser;
}

/** Recherche un utilisateur par email (pour la connexion). */
export async function findUserByEmail(email: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1);
  return rows[0];
}

/** Vérifie un mot de passe bcrypt. Retourne true si valide. */
export async function verifyUserPassword(user: { passwordHash: string | null }, password: string): Promise<boolean> {
  if (!user.passwordHash) return false;
  return bcrypt.compare(password, user.passwordHash);
}

// Token de reset en mémoire (suffisant pour dev ; remplacer par table DB en prod)
const resetTokens = new Map<string, { userId: number; expiresAt: Date }>();

/** Génère et stocke un token de reset de 1h. */
export function storePasswordResetToken(userId: number): string {
  const token = nanoid(48);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  resetTokens.set(token, { userId, expiresAt });
  return token;
}

/** Consomme un token de reset. Retourne l'userId si valide, null sinon. */
export function consumePasswordResetToken(token: string): number | null {
  const entry = resetTokens.get(token);
  if (!entry) return null;
  resetTokens.delete(token);
  if (entry.expiresAt < new Date()) return null;
  return entry.userId;
}

/** Met à jour le mot de passe d'un utilisateur. */
export async function updateUserPassword(userId: number, newPassword: string) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  return true;
}

/** Crée ou met à jour un compte administrateur avec mot de passe hashé bcrypt. */
export async function createOrUpdateAdminUser(input: {
  email: string;
  password: string;
  name?: string;
  phone?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");

  if (!input.email || !input.password) {
    throw new Error("L'email et le mot de passe sont obligatoires");
  }
  if (input.password.length < 8) {
    throw new Error("Le mot de passe doit comporter au moins 8 caractères");
  }

  input = { ...input, email: normalizeEmail(input.email) };
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const existing = await db.select().from(users).where(eq(users.email, input.email)).limit(1);

  if (existing[0]) {
    await db.update(users).set({
      role: "admin",
      passwordHash,
      name: input.name ?? existing[0].name ?? "Administrateur",
      phone: input.phone ?? existing[0].phone ?? null,
      suspended: 0,
      updatedAt: new Date(),
    }).where(eq(users.id, existing[0].id));

    const updated = await db.select().from(users).where(eq(users.id, existing[0].id)).limit(1);
    return { user: updated[0], created: false };
  } else {
    const openId = `native_${nanoid(24)}`;
    await db.insert(users).values({
      openId,
      name: input.name ?? "Administrateur",
      email: input.email,
      phone: input.phone ?? null,
      passwordHash,
      loginMethod: "email",
      role: "admin",
      suspended: 0,
      lastSignedIn: new Date(),
    });

    const created = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
    return { user: created[0], created: true };
  }
}

// ===========================================================
// Admin — gestion directe des comptes
// ===========================================================

export type AdminCreateUserInput = {
  name: string;
  email: string;
  phone?: string;
  password?: string;          // auto-généré si absent
  role: "customer" | "seller";
  shopName?: string;
  shopDescription?: string;
};

/** Génère un mot de passe aléatoire lisible (12 chars). */
function generatePassword(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

/** Admin : crée un compte directement (customer ou seller).
 *  Si seller, crée aussi la boutique avec status='active'.
 *  Retourne { user, shop, plainPassword } pour envoyer l'email. */
export async function adminCreateUser(input: AdminCreateUserInput) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");

  input = { ...input, email: normalizeEmail(input.email) };
  await assertEmailAvailable(input.email);

  const plainPassword = input.password || generatePassword();
  const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
  const openId = `native_${nanoid(24)}`;
  const dbRole = input.role === "seller" ? "vendor" : "user";

  await db.insert(users).values({
    openId,
    name: input.name,
    email: input.email,
    phone: input.phone ?? null,
    passwordHash,
    loginMethod: "email",
    role: dbRole,
    lastSignedIn: new Date(),
  });

  const userRow = (await db.select().from(users).where(eq(users.openId, openId)).limit(1))[0];
  if (!userRow) throw new Error("Erreur lors de la création du compte");

  let shop = undefined;
  if (input.role === "seller" && input.shopName) {
    const baseSlug = input.shopName
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "boutique";
    const slug = `${baseSlug}-${nanoid(6).toLowerCase()}`;
    await db.insert(shops).values({
      userId: userRow.id,
      name: input.shopName,
      slug,
      about: input.shopDescription ?? null,
      tagline: null,
      coverUrl: null,
      status: "active", // approuvé directement par l'admin
    });
    const shopRows = await db.select().from(shops).where(eq(shops.slug, slug)).limit(1);
    shop = shopRows[0];
  }

  return { user: userRow, shop, plainPassword };
}

/** Admin : liste tous les comptes, filtrables par rôle. */
export async function adminListUsers(role?: "user" | "vendor" | "admin") {
  const db = await getDb();
  if (!db) return [];
  const base = db.select({
    id: users.id,
    name: users.name,
    email: users.email,
    phone: users.phone,
    role: users.role,
    suspended: users.suspended,
    createdAt: users.createdAt,
    loginMethod: users.loginMethod,
  }).from(users);

  const rows = role
    ? await base.where(eq(users.role, role)).orderBy(desc(users.createdAt)).limit(200)
    : await base.orderBy(desc(users.createdAt)).limit(200);
  return rows;
}

export type AdminUpdateUserInput = {
  name?: string;
  email?: string;
  phone?: string;
  role?: "user" | "vendor" | "admin";
};

/** Admin : met à jour les champs d'un compte. */
export async function adminUpdateUser(id: number, input: AdminUpdateUserInput) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  if (input.email !== undefined) input = { ...input, email: normalizeEmail(input.email) };
  const updateSet: Record<string, unknown> = {};
  if (input.name !== undefined) updateSet.name = input.name;
  if (input.email !== undefined) updateSet.email = input.email;
  if (input.phone !== undefined) updateSet.phone = input.phone;
  if (input.role !== undefined) updateSet.role = input.role;
  if (Object.keys(updateSet).length === 0) return true;

  if (input.email) {
    const conflict = await db.select({ id: users.id }).from(users).where(and(eq(users.email, input.email), sql`${users.id} <> ${id}`)).limit(1);
    if (conflict[0]) throw new Error("Cet email est déjà utilisé par un autre compte");
  }

  await db.update(users).set(updateSet).where(eq(users.id, id));
  return true;
}

/** Admin : suspend un compte (ne le supprime pas). */
export async function adminSuspendUser(id: number) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  const existing = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, id)).limit(1);
  if (!existing[0]) throw new Error("Compte introuvable");
  if (existing[0].role === "admin") throw new Error("Impossible de suspendre un compte administrateur");
  await db.update(users).set({ suspended: 1 }).where(eq(users.id, id));
  return true;
}

/** Admin : réactive un compte suspendu. */
export async function adminUnsuspendUser(id: number) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  await db.update(users).set({ suspended: 0 }).where(eq(users.id, id));
  return true;
}

