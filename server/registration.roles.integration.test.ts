import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { appRouter } from "./routers";
import { ensureDatabaseConnection } from "./dbConnection";
import { createOrUpdateAdminUser, getDb } from "./db";
import { describeDatabaseError } from "./_core/trpc";
import { sdk } from "./_core/sdk";
import { COOKIE_NAME } from "../shared/const";
import { addresses, commissions, orderItems, orders, products, shops, users } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

/**
 * Scénarios réels contre MySQL : inscription Client/Vendeur, sessions, rôles,
 * validation vendeur par l'admin, commande Client. Toutes les données créées
 * utilisent le domaine @elegancedeco.test et sont supprimées à la fin.
 */

const suffix = nanoid(6).toLowerCase();
const customerEmail = `client_${suffix}@elegancedeco.test`;
const vendorEmail = `vendeur_${suffix}@elegancedeco.test`;
const adminEmail = `admin_${suffix}@elegancedeco.test`;
const password = "MotDePasse2026";

function makeContext(cookieHeader = "") {
  const cookies: Record<string, string> = {};
  const ctx: TrpcContext = {
    user: null,
    req: { protocol: "http", headers: { cookie: cookieHeader } } as unknown as TrpcContext["req"],
    res: {
      cookie: (name: string, value: string) => { cookies[name] = value; },
      clearCookie: (name: string) => { cookies[name] = ""; },
    } as unknown as TrpcContext["res"],
  };
  return { ctx, cookies };
}

/** Rejoue une requête comme le ferait le navigateur : cookie de session → utilisateur. */
async function callerFromToken(token: string) {
  const { ctx } = makeContext(`${COOKIE_NAME}=${token}`);
  ctx.user = await sdk.authenticateRequest(ctx.req);
  return appRouter.createCaller(ctx);
}

describe("Inscriptions Client / Vendeur, rôles et validation admin (MySQL réel)", () => {
  let customerToken = "";
  let vendorToken = "";
  let adminToken = "";
  let shopId = 0;
  let productSlug = "";

  const cleanup = async () => {
    const db = await getDb();
    if (!db) return;
    const testUsers = await db.select({ id: users.id }).from(users).where(like(users.email, `%_${suffix}@elegancedeco.test`));
    const userIds = testUsers.map((u) => u.id);
    if (!userIds.length) return;
    const testShops = await db.select({ id: shops.id }).from(shops).where(inArray(shops.userId, userIds));
    const shopIds = testShops.map((s) => s.id);
    const testOrders = await db.select({ id: orders.id }).from(orders).where(inArray(orders.userId, userIds));
    const orderIds = testOrders.map((o) => o.id);
    if (orderIds.length) {
      await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
      await db.delete(commissions).where(inArray(commissions.orderId, orderIds));
      await db.delete(orders).where(inArray(orders.id, orderIds));
    }
    if (shopIds.length) {
      await db.delete(products).where(inArray(products.shopId, shopIds));
      await db.delete(shops).where(inArray(shops.id, shopIds));
    }
    await db.delete(addresses).where(inArray(addresses.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  };

  beforeAll(async () => {
    await ensureDatabaseConnection();
  });

  afterAll(cleanup);

  it("1. un visiteur consulte le catalogue sans compte", async () => {
    const caller = appRouter.createCaller(makeContext().ctx);
    expect(await caller.auth.me()).toBeNull();
    const catalog = await caller.catalog.list();
    // Accessible sans compte, et uniquement des produits réels (aucun produit de démonstration)
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog.every((p) => p.source === "db")).toBe(true);
    expect((await caller.catalog.categories()).length).toBeGreaterThan(0);
    const search = await caller.catalog.list({ search: "miroir" });
    expect(search.every((p) => `${p.name} ${p.shopName} ${p.category} ${p.description}`.toLowerCase().includes("miroir"))).toBe(true);
  });

  it("2. inscription Client : données enregistrées dans users + adresse par défaut, session ouverte", async () => {
    const { ctx, cookies } = makeContext();
    const res = await appRouter.createCaller(ctx).auth.registerCustomer({
      firstName: "Brahim",
      lastName: "Test",
      email: customerEmail.toUpperCase(),
      phone: "+216 20 123 456",
      city: "Sousse",
      address: "12 rue de la Corniche",
      password,
      passwordConfirm: password,
    });
    expect(res.user.role).toBe("user");
    expect(res.user.email).toBe(customerEmail);
    expect(res.user).not.toHaveProperty("passwordHash");
    customerToken = cookies[COOKIE_NAME];
    expect(customerToken).toBeTruthy();

    const db = (await getDb())!;
    const row = (await db.select().from(users).where(eq(users.email, customerEmail)))[0];
    expect(row).toMatchObject({ firstName: "Brahim", lastName: "Test", phone: "+216 20 123 456", city: "Sousse", address: "12 rue de la Corniche", role: "user" });
    expect(row.passwordHash?.startsWith("$2")).toBe(true);
    const addr = await db.select().from(addresses).where(eq(addresses.userId, row.id));
    expect(addr).toHaveLength(1);
    expect(addr[0]).toMatchObject({ isDefault: 1, city: "Sousse", phone: "+216 20 123 456" });
  });

  it("3. e-mail déjà utilisé (insensible à la casse) : message clair, pas d'erreur SQL", async () => {
    const caller = appRouter.createCaller(makeContext().ctx);
    await expect(caller.auth.registerCustomer({
      firstName: "Autre", lastName: "Personne", email: ` ${customerEmail.toUpperCase()} `, phone: "+216 20 000 000",
      city: "Tunis", address: "Rue quelconque 1", password, passwordConfirm: password,
    })).rejects.toThrow("Un compte avec cet email existe déjà");
  });

  it("4. validation des champs en français (mots de passe différents)", async () => {
    const caller = appRouter.createCaller(makeContext().ctx);
    await expect(caller.auth.registerCustomer({
      firstName: "Sami", lastName: "Ben Ali", email: `x_${suffix}@elegancedeco.test`, phone: "+216 20 000 000",
      city: "Tunis", address: "Rue quelconque 1", password, passwordConfirm: "Different2026",
    })).rejects.toThrow("Les mots de passe ne correspondent pas");
  });

  it("5. session persistante, déconnexion puis reconnexion du Client", async () => {
    const caller = await callerFromToken(customerToken);
    expect((await caller.auth.me())?.email).toBe(customerEmail);

    const { ctx: logoutCtx, cookies } = makeContext(`${COOKIE_NAME}=${customerToken}`);
    await appRouter.createCaller(logoutCtx).auth.logout();
    expect(cookies[COOKIE_NAME]).toBe("");

    const { ctx, cookies: loginCookies } = makeContext();
    const res = await appRouter.createCaller(ctx).auth.login({ email: customerEmail, password });
    expect(res.user.role).toBe("user");
    customerToken = loginCookies[COOKIE_NAME];
    expect((await (await callerFromToken(customerToken)).auth.me())?.firstName).toBe("Brahim");
  });

  it("6. inscription Vendeur refusée sans acceptation des conditions", async () => {
    const caller = appRouter.createCaller(makeContext().ctx);
    await expect(caller.auth.registerVendor({
      firstName: "Amira", lastName: "Vendeuse", email: vendorEmail, phone: "+216 50 111 222", city: "Nabeul",
      shopName: `Atelier ${suffix}`, whatsapp: "+216 50 111 222", password, passwordConfirm: password, acceptTerms: false,
    })).rejects.toThrow("conditions générales");
    const db = (await getDb())!;
    expect(await db.select().from(users).where(eq(users.email, vendorEmail))).toHaveLength(0);
  });

  it("7. inscription Vendeur : profil boutique distinct, statut pending, CGU enregistrées", async () => {
    const { ctx, cookies } = makeContext();
    const res = await appRouter.createCaller(ctx).auth.registerVendor({
      firstName: "Amira", lastName: "Vendeuse", email: vendorEmail, phone: "+216 50 111 222", city: "Nabeul",
      shopName: `Atelier ${suffix}`, whatsapp: "+216 50 333 444", password, passwordConfirm: password, acceptTerms: true,
    });
    vendorToken = cookies[COOKIE_NAME];
    expect(res.user.role).toBe("vendor");
    expect(res.shop.status).toBe("pending");
    shopId = res.shop.id;

    const db = (await getDb())!;
    const shop = (await db.select().from(shops).where(eq(shops.id, shopId)))[0];
    expect(shop).toMatchObject({ name: `Atelier ${suffix}`, whatsapp: "+216 50 333 444", city: "Nabeul", status: "pending", termsAccepted: 1, termsVersion: "v1.0-2026" });
    expect(shop.termsAcceptedAt).toBeInstanceOf(Date);
    const owner = (await db.select().from(users).where(eq(users.id, shop.userId)))[0];
    expect(owner).toMatchObject({ email: vendorEmail, firstName: "Amira", lastName: "Vendeuse", role: "vendor" });
  });

  it("8. vendeur en attente : ne peut ni publier ni s'auto-activer", async () => {
    const vendor = await callerFromToken(vendorToken);
    expect((await vendor.vendor.dashboard()).shop?.status).toBe("pending");
    await expect(vendor.vendor.createProduct({ name: "Vase test", category: "Vases", priceTnd: "120", imageUrl: "https://example.com/v.jpg" }))
      .rejects.toThrow("validée par l'administrateur");
    await expect(vendor.admin.updateShopStatus({ shopId, status: "active" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await vendor.vendor.applyShop({ name: `Atelier ${suffix}` });
    const db = (await getDb())!;
    expect((await db.select().from(shops).where(eq(shops.id, shopId)))[0].status).toBe("pending");
  });

  it("9. un Client ne peut accéder ni à l'espace vendeur ni à l'admin, même en forgeant la requête", async () => {
    const client = await callerFromToken(customerToken);
    await expect(client.vendor.dashboard()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(client.vendor.applyShop({ name: "Boutique pirate" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(client.vendor.createProduct({ name: "Produit pirate", category: "Vases", priceTnd: "1", imageUrl: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(client.admin.dashboard()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(client.admin.updateUser({ id: 1, role: "admin" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Un champ `role` injecté dans l'inscription est ignoré
    const { ctx } = makeContext();
    const res = await appRouter.createCaller(ctx).auth.register({ name: "Pirate", email: `pirate_${suffix}@elegancedeco.test`, password, role: "admin" } as never);
    expect(res.user.role).toBe("user");
  });

  it("10. l'admin approuve le vendeur (motif obligatoire pour un refus)", async () => {
    await createOrUpdateAdminUser({ email: adminEmail, password, name: "Admin Test" });
    const { ctx, cookies } = makeContext();
    await appRouter.createCaller(ctx).auth.login({ email: adminEmail, password });
    adminToken = cookies[COOKIE_NAME];
    const admin = await callerFromToken(adminToken);

    const dash = await admin.admin.dashboard();
    const app = dash.shops.find((s) => s.id === shopId);
    expect(app).toMatchObject({ status: "pending", userEmail: vendorEmail, userFirstName: "Amira", whatsapp: "+216 50 333 444", city: "Nabeul" });

    await expect(admin.admin.updateShopStatus({ shopId, status: "rejected" })).rejects.toThrow("motif");
    expect(await admin.admin.updateShopStatus({ shopId, status: "active" })).toBe(true);
  });

  it("11. vendeur approuvé : publie un produit visible publiquement", async () => {
    const vendor = await callerFromToken(vendorToken);
    expect((await vendor.vendor.dashboard()).shop?.status).toBe("active");
    const created = await vendor.vendor.createProduct({ name: `Miroir test ${suffix}`, category: "Miroirs", priceTnd: "150.00", imageUrl: "https://example.com/m.jpg", status: "published", stock: 5 });
    productSlug = created.slug;
    const publicCaller = appRouter.createCaller(makeContext().ctx);
    const catalog = await publicCaller.catalog.list({ search: suffix });
    expect(catalog.map((p) => p.slug)).toContain(productSlug);
    expect((await publicCaller.vendor.publicProduct({ productSlug }))?.product.shopId).toBe(shopId);
  });

  it("12. un vendeur ne peut pas passer commande ni accéder à l'admin", async () => {
    const vendor = await callerFromToken(vendorToken);
    await expect(vendor.admin.dashboard()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(vendor.checkout.createOrder({
      shippingName: "X Y", shippingPhone: "+216 20 123 456", shippingAddress: "Rue test 1", shippingCity: "Tunis",
      items: [{ productSlug, productName: "x", shopSlug: "x", shopName: "x", quantity: 1, unitPriceTnd: 1 }],
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("13. commande Client : prix recalculé côté serveur, liée au client et à la boutique du vendeur", async () => {
    const client = await callerFromToken(customerToken);
    const result = await client.checkout.createOrder({
      totalTnd: 1,
      shippingName: "Brahim Test",
      shippingPhone: "+216 20 123 456",
      shippingAddress: "12 rue de la Corniche",
      shippingCity: "Sousse",
      items: [{ productSlug, productName: "nom falsifié", shopSlug: "autre", shopName: "autre", quantity: 2, unitPriceTnd: 1 }],
    });
    expect(result.totalTnd).toBe(300);

    const db = (await getDb())!;
    const customer = (await db.select().from(users).where(eq(users.email, customerEmail)))[0];
    const order = (await db.select().from(orders).where(eq(orders.id, result.orderId!)))[0];
    expect(order).toMatchObject({ userId: customer.id, totalTnd: "300.00", shippingPhone: "+216 20 123 456", shippingCity: "Sousse", status: "pending" });
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    expect(items[0]).toMatchObject({ shopId, unitPriceTnd: "150.00", quantity: 2, productName: `Miroir test ${suffix}` });
    // Stock réservé : 5 - 2 = 3
    expect((await db.select({ stock: products.stock }).from(products).where(eq(products.slug, productSlug)))[0].stock).toBe(3);

    const detail = await client.account.order({ orderId: order.id });
    expect(detail?.items).toHaveLength(1);
    // Un autre compte ne voit pas cette commande
    expect(await (await callerFromToken(vendorToken)).account.order({ orderId: order.id })).toBeNull();
    // Le vendeur la voit dans son espace
    const vendorDash = await (await callerFromToken(vendorToken)).vendor.dashboard();
    expect(vendorDash.orders.some((o) => o.orderId === order.id)).toBe(true);
  });

  it("14. suspension : le vendeur est bloqué et ses produits disparaissent du catalogue", async () => {
    const admin = await callerFromToken(adminToken);
    await admin.admin.updateShopStatus({ shopId, status: "suspended", rejectionReason: "Contrôle qualité" });
    const db = (await getDb())!;
    expect((await db.select().from(shops).where(and(eq(shops.id, shopId))))[0]).toMatchObject({ status: "suspended", rejectionReason: "Contrôle qualité" });
    const vendor = await callerFromToken(vendorToken);
    await expect(vendor.vendor.createProduct({ name: "Bloqué", category: "Vases", priceTnd: "10", imageUrl: "x" })).rejects.toThrow("validée");
    await expect(vendor.vendor.applyShop({ name: "Réactivation" })).rejects.toThrow("déjà été examinée");
    const catalog = await appRouter.createCaller(makeContext().ctx).catalog.list({ search: suffix });
    expect(catalog.map((p) => p.slug)).not.toContain(productSlug);
  });

  it("15. un compte suspendu perd sa session", async () => {
    const admin = await callerFromToken(adminToken);
    const db = (await getDb())!;
    const customer = (await db.select().from(users).where(eq(users.email, customerEmail)))[0];
    await admin.admin.suspendUser({ id: customer.id });
    await expect(callerFromToken(customerToken)).rejects.toThrow();
    await expect(appRouter.createCaller(makeContext().ctx).auth.login({ email: customerEmail, password })).rejects.toThrow("suspendu");
  });

  it("16. l'erreur « Failed query » de Drizzle est traduite (cause journalisée, SQL masqué)", () => {
    const simulated = Object.assign(new Error("Failed query: select `id` from `users` where `users`.`email` = ? limit ?\nparams: brahim@gmail.com,1"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3306"), { code: "ECONNREFUSED" }),
    });
    const described = describeDatabaseError(simulated);
    expect(described?.message).toBe("La base de données est momentanément indisponible. Réessayez dans quelques instants.");
    expect(described?.message).not.toContain("select");
    expect(described?.cause).toContain("ECONNREFUSED");
  });
});
