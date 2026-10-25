import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq, inArray, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { appRouter } from "./routers";
import { ensureDatabaseConnection } from "./dbConnection";
import { createOrUpdateAdminUser, getDb, updateShopStatus } from "./db";
import { sdk } from "./_core/sdk";
import { COOKIE_NAME } from "../shared/const";
import { addresses, media, products, shopCategories, shops, users } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import type { ProductInput } from "../shared/productValidation";

/**
 * Catégories propres à chaque boutique, sur la vraie base MySQL :
 * isolation entre vendeurs, vendeur non approuvé refusé, unicité par boutique (casse et accents ignorés),
 * produit rattaché à une catégorie d'autrui refusé, suppression sans perte de produits,
 * onglets publics, catégorie globale attribuée par l'admin.
 * Comptes de test en @elegancedeco.test, supprimés à la fin.
 */

const suffix = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, "x");
const password = "MotDePasse2026";

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

async function registerVendor(label: string) {
  const { ctx, cookies } = makeContext();
  const res = await appRouter.createCaller(ctx).auth.registerVendor({
    firstName: "Test", lastName: label, email: `${label}_${suffix}@elegancedeco.test`, phone: "+216 50 111 222", city: "Sfax",
    shopName: `Atelier ${label} ${suffix}`, whatsapp: "+216 50 111 222", password, passwordConfirm: password, acceptTerms: true,
  });
  return { token: cookies[COOKIE_NAME], shopId: res.shop.id, shopSlug: res.shop.slug as string };
}

const productInput = (name: string, overrides: Partial<ProductInput> = {}): ProductInput => ({
  name, description: "Pièce décorative réalisée à la main, finition soignée, idéale pour un salon.",
  priceTnd: 150, promoPriceTnd: null, availability: "made_to_order", stock: null, sku: "",
  variants: { dimensions: [], colors: [], materials: [], models: [] }, delivery: "", preparationTime: "", extraInfo: "",
  images: [], videoMediaId: null, videoUrl: null, action: "draft", ...overrides,
});

describe("Catégories de boutique (MySQL réel)", () => {
  type Vendor = Awaited<ReturnType<typeof registerVendor>>;
  let vendorA: Vendor;
  let vendorB: Vendor;
  let pendingVendor: Vendor;
  let clientToken = "";
  let adminToken = "";
  const catA: Record<string, number> = {};
  const productsA: number[] = [];
  let productB = 0;

  const db = async () => (await getDb())!;
  const productCount = async (shopId: number) => Number((await (await db()).select({ value: count() }).from(products).where(eq(products.shopId, shopId)))[0].value);

  const cleanup = async () => {
    const conn = await getDb();
    if (!conn) return;
    const userIds = (await conn.select({ id: users.id }).from(users).where(like(users.email, `%_${suffix}@elegancedeco.test`))).map((u) => u.id);
    if (!userIds.length) return;
    const shopIds = (await conn.select({ id: shops.id }).from(shops).where(inArray(shops.userId, userIds))).map((s) => s.id);
    await conn.delete(media).where(inArray(media.ownerUserId, userIds));
    if (shopIds.length) {
      await conn.delete(products).where(inArray(products.shopId, shopIds));
      await conn.delete(shopCategories).where(inArray(shopCategories.shopId, shopIds));
      await conn.delete(shops).where(inArray(shops.id, shopIds));
    }
    await conn.delete(addresses).where(inArray(addresses.userId, userIds));
    await conn.delete(users).where(inArray(users.id, userIds));
  };

  beforeAll(async () => {
    await ensureDatabaseConnection();
    vendorA = await registerVendor("vendeura");
    vendorB = await registerVendor("vendeurb");
    pendingVendor = await registerVendor("vendeurc");
    await updateShopStatus(vendorA.shopId, "active");
    await updateShopStatus(vendorB.shopId, "active");

    const client = makeContext();
    await appRouter.createCaller(client.ctx).auth.registerCustomer({
      firstName: "Client", lastName: "Test", email: `client_${suffix}@elegancedeco.test`, phone: "+216 20 123 456",
      city: "Tunis", address: "Rue du Lac 12", password, passwordConfirm: password,
    });
    clientToken = client.cookies[COOKIE_NAME];

    await createOrUpdateAdminUser({ email: `admin_${suffix}@elegancedeco.test`, password, name: "Admin Test" });
    const adminLogin = makeContext();
    await appRouter.createCaller(adminLogin.ctx).auth.login({ email: `admin_${suffix}@elegancedeco.test`, password });
    adminToken = adminLogin.cookies[COOKIE_NAME];
  });

  afterAll(async () => {
    await cleanup();
  });

  it("refuse les vendeurs en attente, les clients et les visiteurs", async () => {
    const pending = await caller(pendingVendor.token);
    await expect(pending.vendor.shopCategories.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(pending.vendor.shopCategories.create({ name: "Miroirs" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const client = await caller(clientToken);
    await expect(client.vendor.shopCategories.create({ name: "Miroirs" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(anonymous().vendor.shopCategories.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect((await (await db()).select().from(shopCategories).where(eq(shopCategories.shopId, pendingVendor.shopId)))).toHaveLength(0);
  });

  it("crée des catégories libres ; doublon refusé dans la même boutique (casse et accents ignorés)", async () => {
    const a = await caller(vendorA.token);
    catA.miroirs = (await a.vendor.shopCategories.create({ name: "  Miroirs   muraux " })).id;
    catA.decor = (await a.vendor.shopCategories.create({ name: "Décor" })).id;
    catA.neon = (await a.vendor.shopCategories.create({ name: "Néons LED" })).id;
    const list = await a.vendor.shopCategories.list();
    expect(list.categories.map((c) => c.name)).toEqual(["Miroirs muraux", "Décor", "Néons LED"]);
    expect(list.categories.map((c) => c.slug)).toEqual(["miroirs-muraux", "decor", "neons-led"]);

    for (const name of ["MIROIRS MURAUX", "miroirs muraux", "decor", "DÉCOR", "Decor"]) {
      await expect(a.vendor.shopCategories.create({ name })).rejects.toMatchObject({ code: "CONFLICT" });
    }
    await expect(a.vendor.shopCategories.rename({ categoryId: catA.neon, name: "décor" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(a.vendor.shopCategories.create({ name: "x" })).rejects.toThrow("au moins 2");
    await expect(a.vendor.shopCategories.create({ name: "y".repeat(51) })).rejects.toThrow("50");
    expect((await a.vendor.shopCategories.list()).categories).toHaveLength(3);
  });

  it("le même nom est accepté dans une autre boutique", async () => {
    const b = await caller(vendorB.token);
    const created = await b.vendor.shopCategories.create({ name: "Miroirs muraux" });
    expect(created.id).not.toBe(catA.miroirs);
    expect((await b.vendor.shopCategories.list()).categories.map((c) => c.name)).toEqual(["Miroirs muraux"]);
  });

  it("le vendeur B ne peut ni voir, ni modifier, ni supprimer, ni réordonner les catégories du vendeur A", async () => {
    const b = await caller(vendorB.token);
    const listB = await b.vendor.shopCategories.list();
    expect(listB.categories.some((c) => Object.values(catA).includes(c.id))).toBe(false);
    await expect(b.vendor.shopCategories.rename({ categoryId: catA.decor, name: "Piratage" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.vendor.shopCategories.delete({ categoryId: catA.decor })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.vendor.shopCategories.reorder({ orderedIds: [listB.categories[0].id, catA.decor] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Les catégories de A sont intactes
    const rows = await (await db()).select().from(shopCategories).where(eq(shopCategories.shopId, vendorA.shopId));
    expect(rows.map((r) => r.name).sort()).toEqual(["Décor", "Miroirs muraux", "Néons LED"]);
  });

  it("produit : catégorie de sa boutique acceptée, catégorie d'une autre boutique refusée", async () => {
    const a = await caller(vendorA.token);
    const b = await caller(vendorB.token);
    for (const [name, shopCategoryId] of [[`Miroir rond ${suffix}`, catA.miroirs], [`Miroir ovale ${suffix}`, catA.miroirs], [`Lampe ${suffix}`, catA.neon]] as const) {
      const saved = await a.vendor.saveProduct(productInput(name, { shopCategoryId }));
      productsA.push(saved.id!);
    }
    const stored = await (await db()).select({ shopCategoryId: products.shopCategoryId, category: products.category, categoryId: products.categoryId }).from(products).where(eq(products.id, productsA[0]));
    expect(stored[0]).toEqual({ shopCategoryId: catA.miroirs, category: "", categoryId: null });

    // Création chez B avec une catégorie de A : refusée, aucun produit créé
    const before = await productCount(vendorB.shopId);
    await expect(b.vendor.saveProduct(productInput(`Intrus ${suffix}`, { shopCategoryId: catA.decor }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await productCount(vendorB.shopId)).toBe(before);
    // Modification d'un produit de B vers une catégorie de A : refusée, produit inchangé
    productB = (await b.vendor.saveProduct(productInput(`Produit B ${suffix}`))).id!;
    await expect(b.vendor.saveProduct({ ...productInput(`Produit B ${suffix}`, { shopCategoryId: catA.miroirs }), productId: productB })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await (await db()).select({ c: products.shopCategoryId }).from(products).where(eq(products.id, productB)))[0].c).toBeNull();
    // Retirer la catégorie (null) est permis
    await a.vendor.saveProduct({ ...productInput(`Lampe ${suffix}`, { shopCategoryId: null }), productId: productsA[2] });
    expect((await (await db()).select({ c: products.shopCategoryId }).from(products).where(eq(products.id, productsA[2])))[0].c).toBeNull();
    await a.vendor.saveProduct({ ...productInput(`Lampe ${suffix}`, { shopCategoryId: catA.neon }), productId: productsA[2] });
  });

  it("réordonne ses catégories ; renommer garde l'unicité", async () => {
    const a = await caller(vendorA.token);
    await a.vendor.shopCategories.reorder({ orderedIds: [catA.neon, catA.miroirs, catA.decor] });
    const reordered = await a.vendor.shopCategories.list();
    expect(reordered.categories.map((c) => c.id)).toEqual([catA.neon, catA.miroirs, catA.decor]);
    expect(reordered.categories.map((c) => c.productCount)).toEqual([1, 2, 0]);
    expect(reordered.uncategorized).toBe(0);
    await expect(a.vendor.shopCategories.reorder({ orderedIds: [catA.neon, catA.miroirs] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(a.vendor.shopCategories.reorder({ orderedIds: [catA.neon, catA.neon, catA.decor] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const renamed = await a.vendor.shopCategories.rename({ categoryId: catA.decor, name: "Décoration murale" });
    expect(renamed).toMatchObject({ name: "Décoration murale", slug: "decoration-murale" });
    // Renommer avec sa propre casse est permis
    await a.vendor.shopCategories.rename({ categoryId: catA.decor, name: "Décoration Murale" });
  });

  it("onglets publics : uniquement les catégories avec des produits publiés", async () => {
    const conn = await db();
    // Publication directe en base (la publication via l'API exige une photo, testée ailleurs)
    await conn.update(products).set({ status: "published", imageUrl: "/media/test.png" }).where(inArray(products.id, [productsA[0], productsA[2]]));
    const page = await anonymous().vendor.publicShop({ shopSlug: vendorA.shopSlug });
    expect(page?.categories.map((c) => ({ name: c.name, productCount: c.productCount }))).toEqual([
      { name: "Néons LED", productCount: 1 },
      { name: "Miroirs muraux", productCount: 1 },
    ]);
    expect(page?.products.find((p) => p.id === productsA[0])?.shopCategoryId).toBe(catA.miroirs);
    // La boutique B n'expose pas les catégories de A
    const pageB = await anonymous().vendor.publicShop({ shopSlug: vendorB.shopSlug });
    expect(pageB?.categories).toEqual([]);
  });

  it("admin : voit la catégorie du vendeur et attribue / retire une catégorie globale facultative", async () => {
    const admin = await caller(adminToken);
    const list = await admin.admin.products({ shopId: vendorA.shopId });
    expect(list.items.find((p) => p.id === productsA[0])?.shopCategoryName).toBe("Miroirs muraux");
    const global = (await anonymous().catalog.categories()).find((c) => c.slug === "miroirs")!;
    await admin.admin.setProductCategory({ productId: productsA[0], categoryId: global.id });
    const slug = (await (await db()).select({ slug: products.slug }).from(products).where(eq(products.id, productsA[0])))[0].slug;
    expect((await anonymous().catalog.list({ category: "Miroirs" })).map((p) => p.slug)).toContain(slug);
    // Le vendeur qui modifie son produit n'efface pas la catégorie globale attribuée par l'admin
    const a = await caller(vendorA.token);
    await a.vendor.saveProduct({ ...productInput(`Miroir rond ${suffix}`, { shopCategoryId: catA.miroirs }), productId: productsA[0] });
    expect((await (await db()).select({ categoryId: products.categoryId }).from(products).where(eq(products.id, productsA[0])))[0].categoryId).toBe(global.id);
    await admin.admin.setProductCategory({ productId: productsA[0], categoryId: null });
    const row = (await (await db()).select({ categoryId: products.categoryId, category: products.category }).from(products).where(eq(products.id, productsA[0])))[0];
    expect(row).toEqual({ categoryId: null, category: "" });
    // Un vendeur ne peut pas appeler la procédure admin
    await expect(a.admin.setProductCategory({ productId: productsA[0], categoryId: global.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("suppression d'une catégorie utilisée : aucun produit supprimé, produits « Sans catégorie »", async () => {
    const a = await caller(vendorA.token);
    const before = await productCount(vendorA.shopId);
    const result = await a.vendor.shopCategories.delete({ categoryId: catA.miroirs });
    expect(result.uncategorized).toBe(2);
    expect(await productCount(vendorA.shopId)).toBe(before);
    const rows = await (await db()).select({ id: products.id, c: products.shopCategoryId }).from(products).where(inArray(products.id, [productsA[0], productsA[1]]));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.c === null)).toBe(true);
    const list = await a.vendor.shopCategories.list();
    expect(list.categories.map((c) => c.id)).toEqual([catA.neon, catA.decor]);
    expect(list.uncategorized).toBe(2);
    // La catégorie homonyme de B n'est pas touchée
    expect((await (await db()).select().from(shopCategories).where(and(eq(shopCategories.shopId, vendorB.shopId), eq(shopCategories.name, "Miroirs muraux"))))).toHaveLength(1);
    // Une catégorie supprimée ne peut plus être utilisée
    await expect(a.vendor.saveProduct(productInput(`Après ${suffix}`, { shopCategoryId: catA.miroirs }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
