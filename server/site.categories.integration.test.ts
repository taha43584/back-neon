import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { appRouter } from "./routers";
import { ensureDatabaseConnection } from "./dbConnection";
import { createOrUpdateAdminUser, getDb, updateShopStatus } from "./db";
import { createMediaRecord } from "./vendorCatalog";
import { listSiteCategories } from "./siteCategories";
import { sdk } from "./_core/sdk";
import { COOKIE_NAME } from "../shared/const";
import { categorySlug } from "../shared/categoryKey";
import { addresses, hiddenSiteCategories, media, productOptions, products, shopCategories, shops, users } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

/**
 * Catégories du site (vendeurs + globales regroupées), page /categorie/<slug> et masquage par l'admin,
 * sur la vraie base MySQL. Comptes de test en @elegancedeco.test, supprimés à la fin.
 */

const S = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, "x");
const password = "MotDePasse2026";
const MIROIRS = `Miroirs ${S}`;
const SLUG = categorySlug(MIROIRS);

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

type Vendor = { token: string; userId: number; shopId: number };
async function registerVendor(label: string): Promise<Vendor> {
  const { ctx, cookies } = makeContext();
  const res = await appRouter.createCaller(ctx).auth.registerVendor({
    firstName: "Test", lastName: label, email: `${label}_${S}@elegancedeco.test`, phone: "+216 50 111 222", city: "Tunis",
    shopName: `Atelier ${label} ${S}`, whatsapp: "+216 50 111 222", password, passwordConfirm: password, acceptTerms: true,
  });
  await updateShopStatus(res.shop.id, "active");
  return { token: cookies[COOKIE_NAME], userId: res.user.id, shopId: res.shop.id };
}

describe("Catégories du site (MySQL réel)", () => {
  let A: Vendor;
  let B: Vendor;
  let C: Vendor;
  let adminToken = "";
  const ids: Record<string, number> = {};
  const slugs: Record<string, string> = {};

  const mediaFor = async (v: Vendor) => (await createMediaRecord({ ownerUserId: v.userId, shopId: v.shopId, kind: "image", storageKey: `${nanoid(24).toLowerCase().replace(/[^a-z0-9]/g, "a").slice(0, 24)}.png`, mimeType: "image/png", sizeBytes: 100 })).id;
  const product = async (v: Vendor, name: string, shopCategoryId: number | null, extra: Record<string, unknown> = {}, action: "publish" | "draft" = "publish") => {
    const saved = await (await caller(v.token)).vendor.saveProduct({
      name: `${name} ${S}`, description: "Création artisanale réalisée à la main dans notre atelier.", priceTnd: 100, promoPriceTnd: null,
      availability: "made_to_order", stock: null, sku: "", variants: { dimensions: [], colors: [], materials: [], models: [] },
      delivery: "", preparationTime: "", extraInfo: "", images: [{ mediaId: await mediaFor(v), isPrimary: true }], videoMediaId: null, videoUrl: null,
      action, shopCategoryId, ...extra,
    });
    ids[name] = saved.id!;
    slugs[name] = saved.slug!;
    return saved;
  };
  const category = async (v: Vendor, name: string) => (await (await caller(v.token)).vendor.shopCategories.create({ name })).id;
  const visible = async () => (await anonymous().catalog.siteCategories()).filter((c) => c.slug.includes(S));

  const cleanup = async () => {
    const db = await getDb();
    if (!db) return;
    await db.delete(hiddenSiteCategories).where(like(hiddenSiteCategories.slug, `%${S}%`));
    const userIds = (await db.select({ id: users.id }).from(users).where(like(users.email, `%_${S}@elegancedeco.test`))).map((u) => u.id);
    if (!userIds.length) return;
    const shopIds = (await db.select({ id: shops.id }).from(shops).where(inArray(shops.userId, userIds))).map((s) => s.id);
    await db.delete(media).where(inArray(media.ownerUserId, userIds));
    if (shopIds.length) {
      const productIds = (await db.select({ id: products.id }).from(products).where(inArray(products.shopId, shopIds))).map((p) => p.id);
      if (productIds.length) await db.delete(productOptions).where(inArray(productOptions.productId, productIds));
      await db.delete(products).where(inArray(products.shopId, shopIds));
      await db.delete(shopCategories).where(inArray(shopCategories.shopId, shopIds));
      await db.delete(shops).where(inArray(shops.id, shopIds));
    }
    await db.delete(addresses).where(inArray(addresses.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  };

  beforeAll(async () => {
    await ensureDatabaseConnection();
    [A, B, C] = [await registerVendor("vendeura"), await registerVendor("vendeurb"), await registerVendor("vendeurc")];
    await createOrUpdateAdminUser({ email: `admin_${S}@elegancedeco.test`, password, name: "Admin Test" });
    const a = makeContext();
    await appRouter.createCaller(a.ctx).auth.login({ email: `admin_${S}@elegancedeco.test`, password });
    adminToken = a.cookies[COOKIE_NAME];

    // A : « Miroirs S » (2 produits : prix fixe en promo + sur mesure), « Vide S » (aucun produit), « Brouillon S » (brouillon seulement)
    const miroirsA = await category(A, MIROIRS);
    await product(A, "Miroir promo", miroirsA, { priceTnd: 100, promoPriceTnd: 80 });
    await product(A, "Miroir mesure", miroirsA, { pricingMode: "per_m2", unitPriceTnd: 120, minWidthCm: 20, maxWidthCm: 300, minHeightCm: 20, maxHeightCm: 300 });
    await category(A, `Vide ${S}`);
    await product(A, "Brouillon", await category(A, `Brouillon ${S}`), {}, "draft");
    // B : même catégorie écrite autrement (casse + accent + espaces)
    await product(B, "Miroir doré", await category(B, `  MÎROIRS   ${S.toUpperCase()} `), { priceTnd: 300 });
    // C : boutique qui sera suspendue
    await product(C, "Lampe", await category(C, `Lampes ${S}`));
  });

  afterAll(async () => { await cleanup(); });

  it("regroupe les doublons entre boutiques (casse, accents, espaces) et compte créations / boutiques", async () => {
    const list = await visible();
    const miroirs = list.find((c) => c.slug === SLUG);
    expect(miroirs).toMatchObject({ name: MIROIRS, productCount: 3, shopCount: 2 });
    expect(miroirs?.image).toMatch(/^\/media\//);
    expect(list.filter((c) => c.slug === SLUG)).toHaveLength(1);
  });

  it("une catégorie sans produit publié est absente (vide ou brouillons seulement)", async () => {
    const slugsVisible = (await visible()).map((c) => c.slug);
    expect(slugsVisible).not.toContain(categorySlug(`Vide ${S}`));
    expect(slugsVisible).not.toContain(categorySlug(`Brouillon ${S}`));
    expect(slugsVisible).toContain(categorySlug(`Lampes ${S}`));
  });

  it("une boutique inactive n'apporte aucune catégorie ni produit", async () => {
    await updateShopStatus(C.shopId, "suspended");
    expect((await visible()).map((c) => c.slug)).not.toContain(categorySlug(`Lampes ${S}`));
    await expect(anonymous().catalog.categoryPage({ slug: categorySlug(`Lampes ${S}`) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("une seule requête SQL pour les catégories agrégées", async () => {
    const db = (await getDb())!;
    const spy = vi.spyOn(db, "execute");
    await listSiteCategories();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("page /categorie/<slug> : toutes les boutiques, filtres et tri côté serveur", async () => {
    const page = await anonymous().catalog.categoryPage({ slug: SLUG });
    expect(page.category).toMatchObject({ name: MIROIRS, productCount: 3, shopCount: 2 });
    expect(page.products.map((p) => p.slug).sort()).toEqual([slugs["Miroir promo"], slugs["Miroir mesure"], slugs["Miroir doré"]].sort());
    expect(page.facets).toMatchObject({ customCount: 1, promoCount: 1, minPrice: 80, maxPrice: 300, total: 3 });
    expect(page.facets.shops.map((s) => s.count).sort()).toEqual([1, 2]);

    const q = (f: Record<string, unknown>) => anonymous().catalog.categoryPage({ slug: SLUG, ...f }).then((r) => r.products.map((p) => p.slug));
    expect(await q({ custom: true })).toEqual([slugs["Miroir mesure"]]);
    expect(await q({ promo: true })).toEqual([slugs["Miroir promo"]]);
    expect(await q({ minPrice: 90, maxPrice: 200 })).toEqual([slugs["Miroir mesure"]]);
    const shopB = (await (await getDb())!.select({ slug: shops.slug }).from(shops).where(eq(shops.id, B.shopId)))[0].slug;
    expect(await q({ shops: [shopB] })).toEqual([slugs["Miroir doré"]]);
    expect(await q({ sort: "price_asc" })).toEqual([slugs["Miroir promo"], slugs["Miroir mesure"], slugs["Miroir doré"]]);
    expect(await q({ sort: "price_desc" })).toEqual([slugs["Miroir doré"], slugs["Miroir mesure"], slugs["Miroir promo"]]);
    // Sur mesure : « à partir de » = prix unitaire
    const mesure = (await anonymous().catalog.categoryPage({ slug: SLUG, custom: true })).products[0];
    expect(mesure).toMatchObject({ pricingMode: "per_m2", priceTnd: 120 });
    await expect(anonymous().catalog.categoryPage({ slug: `inexistante-${S}` })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("les anciennes catégories globales comptent aussi", async () => {
    const admin = await caller(adminToken);
    const vases = (await anonymous().catalog.categories()).find((c) => c.slug === "vases")!;
    await admin.admin.setProductCategory({ productId: ids["Miroir doré"], categoryId: vases.id });
    const page = await anonymous().catalog.categoryPage({ slug: "vases" });
    expect(page.products.map((p) => p.slug)).toContain(slugs["Miroir doré"]);
    await admin.admin.setProductCategory({ productId: ids["Miroir doré"], categoryId: null });
  });

  it("admin : masque sans rien supprimer ; recréée par un vendeur avec le même nom, elle reste masquée ; réaffichable", async () => {
    const admin = await caller(adminToken);
    // Un vendeur ne peut pas masquer
    await expect((await caller(A.token)).admin.setSiteCategoryHidden({ slug: SLUG, hidden: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const db = (await getDb())!;
    const productsBefore = (await db.select({ id: products.id }).from(products).where(inArray(products.shopId, [A.shopId, B.shopId]))).length;

    await admin.admin.setSiteCategoryHidden({ slug: SLUG, hidden: true, reason: "Nom à revoir" });
    expect((await visible()).map((c) => c.slug)).not.toContain(SLUG);
    await expect(anonymous().catalog.categoryPage({ slug: SLUG })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const record = (await db.select().from(hiddenSiteCategories).where(eq(hiddenSiteCategories.slug, SLUG)))[0];
    expect(record).toMatchObject({ slug: SLUG, label: MIROIRS, hidden: 1, reason: "Nom à revoir" });
    expect(record.hiddenByUserId).toBeGreaterThan(0);
    expect(record.hiddenAt).toBeInstanceOf(Date);
    const adminList = await admin.admin.siteCategories();
    expect(adminList.find((c) => c.slug === SLUG)).toMatchObject({ hidden: true, reason: "Nom à revoir", productCount: 3 });
    // Rien n'est supprimé : produits et catégories des boutiques intacts
    expect((await db.select({ id: products.id }).from(products).where(inArray(products.shopId, [A.shopId, B.shopId]))).length).toBe(productsBefore);

    // Les vendeurs suppriment puis recréent la catégorie (autre casse) : toujours masquée
    const vendorA = await caller(A.token);
    const listA = await vendorA.vendor.shopCategories.list();
    await vendorA.vendor.shopCategories.delete({ categoryId: listA.categories.find((c) => categorySlug(c.name) === SLUG)!.id });
    const vendorB = await caller(B.token);
    const listB = await vendorB.vendor.shopCategories.list();
    await vendorB.vendor.shopCategories.delete({ categoryId: listB.categories.find((c) => categorySlug(c.name) === SLUG)!.id });
    // Catégorie masquée : impossible à recréer, même avec une autre casse (même slug)
    expect(categorySlug(`MIROIRS ${S}`)).toBe(SLUG);
    await expect(vendorA.vendor.shopCategories.create({ name: `MIROIRS ${S}` })).rejects.toThrow("Cette catégorie n'est pas disponible");
    expect((await visible()).map((c) => c.slug)).not.toContain(SLUG);
    await expect(anonymous().catalog.categoryPage({ slug: SLUG })).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Réaffichage : la catégorie peut de nouveau être créée et redevient visible (1 produit, 1 boutique désormais)
    await admin.admin.setSiteCategoryHidden({ slug: SLUG, hidden: false });
    const recreated = await vendorA.vendor.shopCategories.create({ name: `MIROIRS ${S}` });
    const current = await vendorA.vendor.product({ productId: ids["Miroir promo"] });
    await vendorA.vendor.saveProduct({
      productId: current.id, name: current.name, description: current.description ?? "", priceTnd: 100, promoPriceTnd: 80, availability: "made_to_order", stock: null, sku: "",
      variants: current.variants, delivery: "", preparationTime: "", extraInfo: "", images: current.images.map((i) => ({ mediaId: i.id, isPrimary: i.isPrimary })),
      videoMediaId: null, videoUrl: null, action: "publish", shopCategoryId: recreated.id,
    });
    expect((await visible()).find((c) => c.slug === SLUG)).toMatchObject({ productCount: 1, shopCount: 1 });
    expect((await db.select().from(hiddenSiteCategories).where(eq(hiddenSiteCategories.slug, SLUG)))[0].hidden).toBe(0);
  });
});
