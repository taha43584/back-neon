import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { appRouter } from "./routers";
import { ensureDatabaseConnection } from "./dbConnection";
import { createOrUpdateAdminUser, getDb, updateShopStatus } from "./db";
import { createMediaRecord } from "./vendorCatalog";
import { sdk } from "./_core/sdk";
import { COOKIE_NAME } from "../shared/const";
import { categorySlug } from "../shared/categoryKey";
import { addresses, favoriteProducts, hiddenSiteCategories, media, productOptions, products, shopCategories, shops, users } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

/**
 * Nouvel accueil (étape 2) : dernières créations filtrées, exemple sur mesure, catégories des boutiques,
 * filtre « Sur mesure » du catalogue et favoris (cœurs des cartes), sur la vraie base MySQL.
 * Comptes de test en @elegancedeco.test, supprimés à la fin.
 */

const S = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, "x");
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

async function login(email: string) {
  const c = makeContext();
  await appRouter.createCaller(c.ctx).auth.login({ email, password });
  return c.cookies[COOKIE_NAME];
}

describe("Nouvel accueil (MySQL réel)", () => {
  let vendor = { token: "", userId: 0, shopId: 0 };
  const slugs: Record<string, string> = {};
  const ids: Record<string, number> = {};
  const clients: string[] = [];

  const mediaFor = async () => (await createMediaRecord({ ownerUserId: vendor.userId, shopId: vendor.shopId, kind: "image", storageKey: `${nanoid(24).toLowerCase().replace(/[^a-z0-9]/g, "a").slice(0, 24)}.png`, mimeType: "image/png", sizeBytes: 100 })).id;
  const product = async (key: string, shopCategoryId: number, extra: Record<string, unknown> = {}) => {
    const saved = await (await caller(vendor.token)).vendor.saveProduct({
      name: `${key} ${S}`, description: "Création artisanale réalisée à la main dans notre atelier.", priceTnd: 100, promoPriceTnd: null,
      availability: "made_to_order", stock: null, sku: "", variants: { dimensions: [], colors: [], materials: [], models: [] },
      delivery: "", preparationTime: "", extraInfo: "", images: [{ mediaId: await mediaFor(), isPrimary: true }], videoMediaId: null, videoUrl: null,
      action: "publish", shopCategoryId, ...extra,
    });
    slugs[key] = saved.slug!;
    ids[key] = saved.id!;
  };

  const cleanup = async () => {
    const db = await getDb();
    if (!db) return;
    await db.delete(hiddenSiteCategories).where(like(hiddenSiteCategories.slug, `%${S}%`));
    const userIds = (await db.select({ id: users.id }).from(users).where(like(users.email, `%_${S}@elegancedeco.test`))).map((u) => u.id);
    if (!userIds.length) return;
    await db.delete(favoriteProducts).where(inArray(favoriteProducts.userId, userIds));
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
    const { ctx, cookies } = makeContext();
    const res = await appRouter.createCaller(ctx).auth.registerVendor({
      firstName: "Test", lastName: "Accueil", email: `vendeur_${S}@elegancedeco.test`, phone: "+216 50 111 222", city: "Sousse",
      shopName: `Atelier Accueil ${S}`, whatsapp: "+216 50 111 222", password, passwordConfirm: password, acceptTerms: true,
    });
    await updateShopStatus(res.shop.id, "active");
    vendor = { token: cookies[COOKIE_NAME], userId: res.user.id, shopId: res.shop.id };
    const v = await caller(vendor.token);
    const miroirs = (await v.vendor.shopCategories.create({ name: `Miroirs ${S}` })).id;
    const masquee = (await v.vendor.shopCategories.create({ name: `Masquee ${S}` })).id;
    await product("Fixe", miroirs, { priceTnd: 150 });
    await product("Promo", miroirs, { priceTnd: 100, promoPriceTnd: 80 });
    await product("Mesure", masquee, { pricingMode: "per_m2", unitPriceTnd: 120, minWidthCm: 20, maxWidthCm: 300, minHeightCm: 20, maxHeightCm: 300 });
    for (const label of ["clienta", "clientb"]) {
      await anonymous().auth.register({ name: `Client ${label}`, email: `${label}_${S}@elegancedeco.test`, password });
      clients.push(await login(`${label}_${S}@elegancedeco.test`));
    }
  });

  afterAll(async () => { await cleanup(); });

  it("dernières créations : chaque filtre ne contient que les bons produits", async () => {
    const home = await anonymous().catalog.home();
    const mine = (list: Array<{ slug: string }>) => list.map((p) => p.slug).filter((s) => Object.values(slugs).includes(s));
    expect(mine(home.latest.all).sort()).toEqual([slugs.Fixe, slugs.Promo, slugs.Mesure].sort());
    expect(mine(home.latest.custom)).toEqual([slugs.Mesure]);
    expect(mine(home.latest.promo)).toEqual([slugs.Promo]);
    expect(home.latest.custom.every((p) => p.pricingMode !== "fixed")).toBe(true);
    expect(home.latest.promo.every((p) => p.promoPriceTnd !== null)).toBe(true);
    // Carte : logo et identifiant de la boutique fournis par le serveur
    expect(home.latest.all.find((p) => p.slug === slugs.Fixe)).toMatchObject({ id: ids.Fixe, shopSlug: expect.any(String) });
  });

  it("exemple sur mesure du hero = création sur mesure réelle la plus récente ; compteurs réels", async () => {
    const home = await anonymous().catalog.home();
    expect(home.customExample?.slug).toBe(slugs.Mesure);
    expect(home.customExample?.pricingMode).toBe("per_m2");
    expect(home.totals.customProducts).toBeGreaterThanOrEqual(1);
    expect(home.totals.activeShops).toBe(home.allShops.length);
  });

  it("catégories d'une boutique : réelles, sans les catégories masquées par l'admin", async () => {
    const shopOf = async () => (await anonymous().catalog.home()).shops.find((s) => s.id === vendor.shopId);
    expect((await shopOf())?.categories.map((c) => c.slug).sort()).toEqual([categorySlug(`Masquee ${S}`), categorySlug(`Miroirs ${S}`)].sort());
    await createOrUpdateAdminUser({ email: `admin_${S}@elegancedeco.test`, password, name: "Admin Test" });
    const admin = await caller(await login(`admin_${S}@elegancedeco.test`));
    await admin.admin.setSiteCategoryHidden({ slug: categorySlug(`Masquee ${S}`), hidden: true, reason: "Test" });
    expect((await shopOf())?.categories.map((c) => c.slug)).toEqual([categorySlug(`Miroirs ${S}`)]);
  });

  it("catalogue : le filtre « Sur mesure » ne renvoie que des créations sur mesure", async () => {
    const list = await anonymous().catalog.list({ custom: true });
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((p) => p.pricingMode !== "fixed")).toBe(true);
    expect(list.map((p) => p.slug)).toContain(slugs.Mesure);
    expect(list.map((p) => p.slug)).not.toContain(slugs.Fixe);
  });

  it("favoris : chaque client ne voit que les siens ; anonyme refusé", async () => {
    const [a, b] = await Promise.all(clients.map(caller));
    await a.account.toggleFavorite({ productId: ids.Fixe, productSlug: slugs.Fixe, productName: "x", imageUrl: "/media/x.png", priceTnd: "150.00" });
    expect(await a.account.favoriteSlugs()).toEqual([slugs.Fixe]);
    expect(await b.account.favoriteSlugs()).toEqual([]);
    await a.account.toggleFavorite({ productId: ids.Fixe, productSlug: slugs.Fixe, productName: "x", imageUrl: "/media/x.png", priceTnd: "150.00" });
    expect(await a.account.favoriteSlugs()).toEqual([]);
    await expect(anonymous().account.favoriteSlugs()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
