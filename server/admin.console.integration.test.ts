import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import fs from "fs";
import { eq, inArray, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { appRouter } from "./routers";
import { ensureDatabaseConnection } from "./dbConnection";
import { createOrUpdateAdminUser, getDb } from "./db";
import { registerMediaRoutes } from "./mediaRoutes";
import { resolveStoragePath } from "./mediaStorage";
import { clearSettingsCache } from "./settings";
import { sdk } from "./_core/sdk";
import { COOKIE_NAME } from "../shared/const";
import {
  addresses, categories, commissions, marketplaceSettings, media, orderItems, orderStatusHistory, orders, products, reviews, shops, users,
} from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import type { ProductInput } from "../shared/productValidation";

/**
 * Console d'administration, espace vendeur et parcours client de bout en bout,
 * sur la vraie base MySQL et un vrai serveur HTTP pour les fichiers.
 * Comptes de test en @elegancedeco.test, supprimés à la fin ; les paramètres du
 * marketplace sont restaurés à leur valeur d'origine.
 */

const suffix = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, "x");
const password = "MotDePasse2026";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function makeContext(cookieHeader = "") {
  const cookies: Record<string, string> = {};
  const ctx: TrpcContext = {
    user: null,
    req: { protocol: "http", headers: { cookie: cookieHeader } } as unknown as TrpcContext["req"],
    res: { cookie: (n: string, v: string) => { cookies[n] = v; }, clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
  return { ctx, cookies };
}
async function caller(token: string) {
  const { ctx } = makeContext(`${COOKIE_NAME}=${token}`);
  ctx.user = await sdk.authenticateRequest(ctx.req);
  return appRouter.createCaller(ctx);
}
const anonymous = () => appRouter.createCaller(makeContext().ctx);

describe("Console admin, espace vendeur et commandes (MySQL réel)", () => {
  let server: Server;
  let base = "";
  let adminToken = "";
  let clientToken = "";
  let clientId = 0;
  const vendors: Record<"a" | "b" | "pending", { token: string; shopId: number }> = { a: { token: "", shopId: 0 }, b: { token: "", shopId: 0 }, pending: { token: "", shopId: 0 } };
  let categoryId = 0;
  let productA = { id: 0, slug: "" };
  let productB = { id: 0, slug: "" };
  let orderId = 0;
  let createdCategoryId = 0;
  let settingsBackup: Array<{ key: string; value: string }> = [];

  const registerVendor = async (label: string) => {
    const { ctx, cookies } = makeContext();
    const res = await appRouter.createCaller(ctx).auth.registerVendor({
      firstName: "Test", lastName: label, email: `${label}_${suffix}@elegancedeco.test`, phone: "+216 50 111 222", city: "Sousse",
      shopName: `Atelier ${label} ${suffix}`, whatsapp: "+216 50 111 222", password, passwordConfirm: password, acceptTerms: true,
    });
    return { token: cookies[COOKIE_NAME], shopId: res.shop.id };
  };

  const uploadImage = async (token: string) => {
    const res = await fetch(`${base}/api/uploads?kind=image&name=photo.png`, { method: "POST", headers: { "Content-Type": "image/png", cookie: `${COOKIE_NAME}=${token}` }, body: PNG });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: number; url: string };
  };

  const productInput = (name: string, imageId: number, overrides: Partial<ProductInput> = {}): ProductInput => ({
    name, description: "Pièce décorative réalisée à la main, finition soignée, idéale pour un salon.",
    priceTnd: 200, promoPriceTnd: null, availability: "in_stock", stock: 10, sku: "",
    variants: { dimensions: [], colors: [], materials: [], models: [] }, delivery: "Livraison 3 à 5 jours", preparationTime: "", extraInfo: "",
    images: [{ mediaId: imageId, isPrimary: true }], videoMediaId: null, videoUrl: null, action: "publish", ...overrides,
  });

  const cleanup = async () => {
    const db = await getDb();
    if (!db) return;
    const testUsers = await db.select({ id: users.id }).from(users).where(like(users.email, `%_${suffix}@elegancedeco.test`));
    const userIds = testUsers.map((u) => u.id);
    if (createdCategoryId) await db.delete(categories).where(eq(categories.id, createdCategoryId));
    await db.delete(categories).where(like(categories.slug, `%${suffix}%`));
    if (!userIds.length) return;
    const testShops = (await db.select({ id: shops.id }).from(shops).where(inArray(shops.userId, userIds))).map((s) => s.id);
    const files = await db.select({ id: media.id, storageKey: media.storageKey }).from(media).where(inArray(media.ownerUserId, userIds));
    files.forEach((f) => { const p = resolveStoragePath(f.storageKey); if (p) fs.rmSync(p, { force: true }); });
    if (files.length) await db.delete(media).where(inArray(media.id, files.map((f) => f.id)));
    const testOrders = (await db.select({ id: orders.id }).from(orders).where(inArray(orders.userId, userIds))).map((o) => o.id);
    if (testOrders.length) {
      await db.delete(reviews).where(inArray(reviews.orderId, testOrders));
      await db.delete(orderStatusHistory).where(inArray(orderStatusHistory.orderId, testOrders));
      await db.delete(orderItems).where(inArray(orderItems.orderId, testOrders));
      await db.delete(commissions).where(inArray(commissions.orderId, testOrders));
      await db.delete(orders).where(inArray(orders.id, testOrders));
    }
    if (testShops.length) {
      await db.delete(products).where(inArray(products.shopId, testShops));
      await db.delete(categories).where(inArray(categories.proposedByShopId, testShops));
      await db.delete(shops).where(inArray(shops.id, testShops));
    }
    await db.delete(addresses).where(inArray(addresses.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  };

  beforeAll(async () => {
    await ensureDatabaseConnection();
    const db = (await getDb())!;
    settingsBackup = (await db.select({ key: marketplaceSettings.key, value: marketplaceSettings.value }).from(marketplaceSettings));
    const app = express();
    registerMediaRoutes(app);
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    await createOrUpdateAdminUser({ email: `admin_${suffix}@elegancedeco.test`, password, name: "Admin Test" });
    const adminLogin = makeContext();
    await appRouter.createCaller(adminLogin.ctx).auth.login({ email: `admin_${suffix}@elegancedeco.test`, password });
    adminToken = adminLogin.cookies[COOKIE_NAME];

    vendors.a = await registerVendor("vendeura");
    vendors.b = await registerVendor("vendeurb");
    vendors.pending = await registerVendor("vendeurc");

    const client = makeContext();
    const reg = await appRouter.createCaller(client.ctx).auth.registerCustomer({
      firstName: "Leila", lastName: `Client${suffix}`, email: `client_${suffix}@elegancedeco.test`, phone: "+216 20 123 456",
      city: "Tunis", address: "Rue du Lac 12", password, passwordConfirm: password,
    });
    clientToken = client.cookies[COOKIE_NAME];
    clientId = reg.user.id;

    categoryId = (await anonymous().catalog.categories()).find((c) => c.slug === "decoration-murale")!.id;
  });

  afterAll(async () => {
    await cleanup();
    // Restauration exacte des paramètres du marketplace
    const db = await getDb();
    if (db) {
      await db.delete(marketplaceSettings);
      if (settingsBackup.length) await db.insert(marketplaceSettings).values(settingsBackup);
    }
    clearSettingsCache();
    await new Promise((resolve) => server?.close(resolve));
  });

  it("bloque toute la console admin pour les visiteurs, clients et vendeurs", async () => {
    const clientCaller = await caller(clientToken);
    const vendorCaller = await caller(vendors.a.token);
    for (const c of [anonymous(), clientCaller, vendorCaller]) {
      await expect(c.admin.overview()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.admin.clients({})).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.admin.updateShopStatus({ shopId: vendors.a.shopId, status: "active" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.admin.updateSettings({ commissionRate: 0 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("un vendeur ne peut ni s'approuver ni changer son rôle ; un vendeur en attente ne peut pas vendre", async () => {
    const pending = await caller(vendors.pending.token);
    await pending.vendor.updateShop({ name: `Atelier vendeurc ${suffix}`, status: "active" } as never);
    const db = (await getDb())!;
    const shop = (await db.select({ status: shops.status }).from(shops).where(eq(shops.id, vendors.pending.shopId)))[0];
    expect(shop.status).toBe("pending");
    await pending.account.updateProfile({ firstName: "Test", role: "admin" } as never).catch(() => undefined);
    const me = await pending.auth.me();
    expect(me?.role).toBe("vendor");
    const upload = await fetch(`${base}/api/uploads?kind=image`, { method: "POST", headers: { "Content-Type": "image/png", cookie: `${COOKIE_NAME}=${vendors.pending.token}` }, body: PNG });
    expect(upload.status).toBe(403);
  });

  it("l'admin voit les vendeurs en attente et les approuve ; les compteurs sont réels", async () => {
    const admin = await caller(adminToken);
    const pendingList = await admin.admin.vendors({ status: "pending", search: suffix });
    expect(pendingList.items.map((v) => v.id).sort()).toEqual([vendors.a.shopId, vendors.b.shopId, vendors.pending.shopId].sort());
    expect(pendingList.items.every((v) => v.termsAccepted === 1 && v.whatsapp)).toBe(true);
    await admin.admin.updateShopStatus({ shopId: vendors.a.shopId, status: "active" });
    await admin.admin.updateShopStatus({ shopId: vendors.b.shopId, status: "active" });
    await expect(admin.admin.updateShopStatus({ shopId: vendors.pending.shopId, status: "rejected" })).rejects.toThrow("motif");
    // Les compteurs globaux correspondent à la base (d'autres tests peuvent créer des vendeurs en parallèle)
    // Encadrement : nombre réel lu juste avant et juste après le compteur (d'autres fichiers de tests
    // créent / activent / suppriment des boutiques en parallèle) ; tolérance d'une boutique au-delà.
    const db = (await getDb())!;
    const activeInDb = async () => (await db.select({ id: shops.id }).from(shops).where(eq(shops.status, "active"))).length;
    const before = await activeInDb();
    const overview = await admin.admin.overview();
    const after = await activeInDb();
    expect(overview.stats.activeShops).toBeGreaterThanOrEqual(Math.min(before, after) - 1);
    expect(overview.stats.activeShops).toBeLessThanOrEqual(Math.max(before, after) + 1);
    expect((await admin.admin.vendors({ status: "active", search: suffix })).items).toHaveLength(2);
    expect((await admin.admin.vendors({ status: "pending", search: suffix })).items.map((v) => v.id)).toEqual([vendors.pending.shopId]);
    const detail = await admin.admin.vendor({ shopId: vendors.a.shopId });
    expect(detail.shop.status).toBe("active");
    expect(JSON.stringify(detail)).not.toMatch(/passwordHash|openId/);
  });

  it("recherche de clients sans exposer de mot de passe", async () => {
    const admin = await caller(adminToken);
    const res = await admin.admin.clients({ search: `client_${suffix}` });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].id).toBe(clientId);
    expect(JSON.stringify(res)).not.toMatch(/passwordHash|openId|\$2[aby]\$/);
    const detail = await admin.admin.client({ userId: clientId });
    expect(detail.user.email).toBe(`client_${suffix}@elegancedeco.test`);
    expect(JSON.stringify(detail)).not.toMatch(/passwordHash|openId|\$2[aby]\$/);
  });

  it("publication avec validation admin activée : en attente, invisible, puis approuvée", async () => {
    const admin = await caller(adminToken);
    await admin.admin.updateSettings({ requireProductApproval: true });
    const vendorA = await caller(vendors.a.token);
    const img = await uploadImage(vendors.a.token);
    const saved = await vendorA.vendor.saveProduct(productInput(`Applique murale ${suffix}`, img.id));
    expect(saved.status).toBe("pending");
    productA = { id: saved.id!, slug: saved.slug! };
    expect((await anonymous().catalog.list({ search: suffix })).some((p) => p.slug === productA.slug)).toBe(false);
    expect((await admin.admin.products({ status: "pending", search: suffix })).items.map((p) => p.id)).toContain(productA.id);

    await expect(admin.admin.setProductStatus({ productId: productA.id, action: "reject" })).rejects.toThrow();
    await admin.admin.setProductStatus({ productId: productA.id, action: "reject", reason: "Photo trop sombre" });
    const rejected = (await vendorA.vendor.dashboard()).products.find((p) => p.id === productA.id)!;
    expect(rejected.status).toBe("rejected");
    expect(rejected.moderationNote).toBe("Photo trop sombre");

    await admin.admin.setProductStatus({ productId: productA.id, action: "publish" });
    expect((await anonymous().catalog.list({ search: suffix })).some((p) => p.slug === productA.slug)).toBe(true);
    await admin.admin.updateSettings({ requireProductApproval: false });

    const vendorB = await caller(vendors.b.token);
    const imgB = await uploadImage(vendors.b.token);
    const savedB = await vendorB.vendor.saveProduct(productInput(`Néon prénom ${suffix}`, imgB.id, { priceTnd: 100, promoPriceTnd: 80, stock: 3 }));
    expect(savedB.status).toBe("published");
    productB = { id: savedB.id!, slug: savedB.slug! };

    // Un vendeur ne peut pas modifier le produit d'un autre vendeur
    await expect(vendorB.vendor.saveProduct({ ...productInput("Piratage", imgB.id), productId: productA.id })).rejects.toThrow();
    await expect(vendorB.vendor.setProductStatus({ productId: productA.id, status: "draft" })).rejects.toThrow();
  });

  it("page d'accueil et panier : données réelles et prix recalculés par le serveur", async () => {
    // Indépendant des autres données (vrais produits, autres fichiers de tests en parallèle) :
    // l'accueil ne montre que des produits publiés, au plus 8, du plus récent au plus ancien
    const home = await anonymous().catalog.home();
    const published = new Map((await anonymous().catalog.list()).map((p) => [p.slug, p]));
    expect(home.newest.length).toBeLessThanOrEqual(8);
    expect(home.newest.every((p) => published.has(p.slug))).toBe(true);
    expect(home.promotions.every((p) => p.promoPriceTnd !== null && published.has(p.slug))).toBe(true);
    // Les deux produits du test sont publiés et visibles ; B est en promotion (80 DT au lieu de 100)
    const mine = await anonymous().catalog.list({ search: suffix });
    expect(mine.map((p) => p.slug)).toEqual(expect.arrayContaining([productA.slug, productB.slug]));
    expect(mine.find((p) => p.slug === productB.slug)).toMatchObject({ promoPriceTnd: 80, priceTnd: 80 });
    const quote = await anonymous().catalog.quoteCart({ lines: [{ productSlug: productB.slug, quantity: 2 }, { productSlug: "produit-inexistant", quantity: 1 }] });
    expect(quote.lines[0]).toMatchObject({ available: true, unitPriceTnd: 80 });
    expect(quote.lines[1].available).toBe(false);
    expect(quote.subtotalTnd).toBe(160);
    const tooMany = await anonymous().catalog.quoteCart({ lines: [{ productSlug: productB.slug, quantity: 5 }] });
    expect(tooMany.hasProblems).toBe(true);
  });

  it("commande multi-boutiques : prix serveur, commission paramétrée, statut séparé par vendeur", async () => {
    const admin = await caller(adminToken);
    await admin.admin.updateSettings({ commissionRate: 15 });
    const client = await caller(clientToken);
    const res = await client.checkout.createOrder({
      shippingName: "Leila Test", shippingPhone: "+216 20 123 456", shippingAddress: "Rue du Lac 12", shippingCity: "Tunis",
      items: [
        { productSlug: productA.slug, productName: "x", shopSlug: "x", shopName: "x", quantity: 1, unitPriceTnd: 1 },
        { productSlug: productB.slug, productName: "x", shopSlug: "x", shopName: "x", quantity: 2, unitPriceTnd: 1 },
      ],
    });
    orderId = res.orderId!;
    expect(res.totalTnd).toBe(200 + 2 * 80);
    const db = (await getDb())!;
    const comms = await db.select().from(commissions).where(eq(commissions.orderId, orderId));
    expect(comms.map((c) => Number(c.commissionTnd)).sort((a, b) => a - b)).toEqual([24, 30]);
    await admin.admin.updateSettings({ commissionRate: 10 });

    const vendorA = await caller(vendors.a.token);
    await vendorA.vendor.updateOrderStatus({ orderId, status: "shipped" });
    const items = await db.select({ shopId: orderItems.shopId, s: orderItems.fulfillmentStatus }).from(orderItems).where(eq(orderItems.orderId, orderId));
    expect(items.find((i) => i.shopId === vendors.a.shopId)?.s).toBe("shipped");
    expect(items.find((i) => i.shopId === vendors.b.shopId)?.s).toBe("pending");
    const detail = await admin.admin.order({ orderId });
    expect(detail.order.status).toBe("processing");
    expect(detail.history.some((h) => h.changedByRole === "vendor" && h.toStatus === "shipped")).toBe(true);
    expect(detail.items.every((i) => i.unitPriceTnd > 0)).toBe(true);

    // Le vendeur en attente n'a aucun article dans cette commande
    const pending = await caller(vendors.pending.token);
    await expect(pending.vendor.updateOrderStatus({ orderId, status: "delivered" })).rejects.toThrow();

    const vendorBView = (await (await caller(vendors.b.token)).vendor.dashboard()).orders;
    expect(vendorBView.every((o) => o.productSlug === productB.slug)).toBe(true);

    const list = await admin.admin.orders({ search: `ED-${String(orderId).padStart(6, "0")}` });
    expect(list.items.map((o) => o.id)).toEqual([orderId]);
    const byShop = await admin.admin.orders({ shopId: vendors.b.shopId });
    expect(byShop.items.map((o) => o.id)).toContain(orderId);
  });

  it("annulation par l'admin : stock réintégré, commissions annulées, réactivation impossible", async () => {
    const db = (await getDb())!;
    const stockBefore = (await db.select({ stock: products.stock }).from(products).where(eq(products.id, productB.id)))[0].stock!;
    const admin = await caller(adminToken);
    await admin.admin.updateOrderStatus({ orderId, status: "cancelled", note: "Demande du client" });
    const stockAfter = (await db.select({ stock: products.stock }).from(products).where(eq(products.id, productB.id)))[0].stock!;
    expect(stockAfter).toBe(stockBefore + 2);
    const comms = await db.select({ status: commissions.status }).from(commissions).where(eq(commissions.orderId, orderId));
    expect(comms.every((c) => c.status === "refunded")).toBe(true);
    await expect(admin.admin.updateOrderStatus({ orderId, status: "pending" })).rejects.toThrow("annulée");
  });

  it("avis : visible seulement après publication par l'admin, suppression possible", async () => {
    const client = await caller(clientToken);
    const admin = await caller(adminToken);
    const res = await client.checkout.createOrder({
      shippingName: "Leila Test", shippingPhone: "+216 20 123 456", shippingAddress: "Rue du Lac 12", shippingCity: "Tunis",
      items: [{ productSlug: productA.slug, productName: "x", shopSlug: "x", shopName: "x", quantity: 1, unitPriceTnd: 1 }],
    });
    await admin.admin.updateOrderStatus({ orderId: res.orderId!, status: "delivered" });
    await client.reviews.submit({ productSlug: productA.slug, rating: 5, body: "Très belle pièce, conforme aux photos." });
    expect(await anonymous().reviews.list({ productSlug: productA.slug })).toHaveLength(0);
    const pending = await admin.admin.reviews({ status: "pending", search: suffix });
    const review = pending.items.find((r) => r.productSlug === productA.slug)!;
    await admin.admin.updateReviewStatus({ reviewId: review.id, status: "published" });
    expect(await anonymous().reviews.list({ productSlug: productA.slug })).toHaveLength(1);
    await admin.admin.deleteReview({ reviewId: review.id });
    expect(await anonymous().reviews.list({ productSlug: productA.slug })).toHaveLength(0);
    const stats = await admin.admin.stats({ period: "30d" });
    expect(stats.topProducts.some((p) => p.productSlug === productA.slug)).toBe(true);
  });

  it("catégories : pas de doublon, désactivation, suppression avec réaffectation obligatoire", async () => {
    const admin = await caller(adminToken);
    await expect(admin.admin.saveCategory({ name: "Décoration murale" })).rejects.toThrow("existe déjà");
    const created = await admin.admin.saveCategory({ name: `Luminaires ${suffix}`, description: "Lampes et suspensions" });
    createdCategoryId = created.id;
    expect((await anonymous().catalog.categories()).some((c) => c.id === created.id)).toBe(true);
    await admin.admin.setCategoryActive({ categoryId: created.id, active: false });
    expect((await anonymous().catalog.categories()).some((c) => c.id === created.id)).toBe(false);
    await admin.admin.setCategoryActive({ categoryId: created.id, active: true });

    const db = (await getDb())!;
    await db.update(products).set({ categoryId: created.id, category: `Luminaires ${suffix}` }).where(eq(products.id, productB.id));
    await expect(admin.admin.deleteCategory({ categoryId: created.id })).rejects.toThrow("remplacement");
    await admin.admin.deleteCategory({ categoryId: created.id, reassignToCategoryId: categoryId });
    createdCategoryId = 0;
    const moved = (await db.select({ categoryId: products.categoryId }).from(products).where(eq(products.id, productB.id)))[0];
    expect(moved.categoryId).toBe(categoryId);
  });

  it("suppression d'un produit par l'admin : l'historique des commandes est conservé", async () => {
    const admin = await caller(adminToken);
    await admin.admin.deleteProduct({ productId: productB.id });
    const db = (await getDb())!;
    const kept = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    const line = kept.find((i) => i.productSlug === productB.slug)!;
    expect(line.productId).toBeNull();
    expect(line.productName).toContain("Néon prénom");
    expect(Number(line.unitPriceTnd)).toBe(80);
    expect((await anonymous().catalog.list({ search: suffix })).some((p) => p.slug === productB.slug)).toBe(false);
  });
});
