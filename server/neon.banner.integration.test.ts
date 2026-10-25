import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { appRouter } from "./routers";
import { ensureDatabaseConnection } from "./dbConnection";
import { createOrUpdateAdminUser, updateShopStatus } from "./db";
import { createMediaRecord } from "./vendorCatalog";
import { clearSettingsCache } from "./settings";
import { showNeonBanner } from "./neon";
import { sdk } from "./_core/sdk";
import { COOKIE_NAME } from "../shared/const";
import { categorySlug } from "../shared/categoryKey";
import type { NeonOffer } from "../shared/neon";
import type { TrpcContext } from "./_core/context";

/**
 * Bannière « Créer mon néon » (étapes 4 et 5, base de test) : uniquement sur la catégorie choisie par l'admin,
 * automatique dès qu'une boutique active propose le néon, masquable manuellement par l'admin.
 * Les données de test sont supprimées par le nettoyage global (comptes @elegancedeco.test).
 */

const S = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, "x");
const password = "MotDePasse2026";
const NEON = `Neon perso ${S}`;
const MIROIRS = `Miroirs ${S}`;

const OFFER: NeonOffer = {
  enabled: true, sizes: [{ code: "M", widthCm: 75, priceTnd: 250 }], includedLetters: 8, extraLetterPriceTnd: 10,
  colors: ["pink"], supports: [{ code: "rect", surchargeTnd: 0 }], outdoorEnabled: false, outdoorSurchargeType: "percent", outdoorSurchargeValue: 0,
  arabicEnabled: false, productionDaysMin: 5, productionDaysMax: 7,
};

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

describe("Bannière néon de la page catégorie (base de test)", () => {
  let vendorToken = "";
  let adminToken = "";
  let shopId = 0;
  const banner = async (name: string) => (await anonymous().catalog.categoryPage({ slug: categorySlug(name) })).neonBanner;
  const admin = async () => caller(adminToken);
  const vendor = async () => caller(vendorToken);

  beforeAll(async () => {
    await ensureDatabaseConnection();
    const { ctx, cookies } = makeContext();
    const res = await appRouter.createCaller(ctx).auth.registerVendor({
      firstName: "Test", lastName: "Neon", email: `vendeur_${S}@elegancedeco.test`, phone: "+216 50 111 222", city: "Tunis",
      shopName: `Atelier Neon ${S}`, whatsapp: "+216 50 111 222", password, passwordConfirm: password, acceptTerms: true,
    });
    shopId = res.shop.id;
    await updateShopStatus(shopId, "active");
    vendorToken = cookies[COOKIE_NAME];
    const v = await vendor();
    for (const name of [NEON, MIROIRS]) {
      const shopCategoryId = (await v.vendor.shopCategories.create({ name })).id;
      const mediaId = (await createMediaRecord({ ownerUserId: res.user.id, shopId, kind: "image", storageKey: `${nanoid(24).toLowerCase().replace(/[^a-z0-9]/g, "a").slice(0, 24)}.png`, mimeType: "image/png", sizeBytes: 100 })).id;
      await v.vendor.saveProduct({
        name: `Création ${name}`, description: "Création artisanale réalisée à la main dans notre atelier.", priceTnd: 100, promoPriceTnd: null,
        availability: "made_to_order", stock: null, sku: "", variants: { dimensions: [], colors: [], materials: [], models: [] },
        delivery: "", preparationTime: "", extraInfo: "", images: [{ mediaId, isPrimary: true }], videoMediaId: null, videoUrl: null,
        action: "publish", shopCategoryId,
      });
    }
    await createOrUpdateAdminUser({ email: `admin_${S}@elegancedeco.test`, password, name: "Admin Test" });
    const a = makeContext();
    await appRouter.createCaller(a.ctx).auth.login({ email: `admin_${S}@elegancedeco.test`, password });
    adminToken = a.cookies[COOKIE_NAME];
    await (await admin()).admin.updateSettings({ neonCategorySlug: "", neonBannerHidden: false });
  });

  afterAll(async () => {
    // Réglages remis par défaut ; comptes, boutique et offre supprimés par le nettoyage global
    await (await admin()).admin.updateSettings({ neonCategorySlug: "", neonBannerHidden: false });
    clearSettingsCache();
  });

  it("aucune catégorie choisie : aucune bannière", async () => {
    expect(await banner(NEON)).toBe(false);
  });

  it("catégorie choisie mais aucune boutique ne propose le néon : aucune bannière", async () => {
    await (await admin()).admin.updateSettings({ neonCategorySlug: categorySlug(NEON) });
    expect(await banner(NEON)).toBe(false);
  });

  it("dès qu'une boutique active propose le néon : bannière automatique, seulement sur cette catégorie", async () => {
    await (await vendor()).vendor.neon.saveOffer(OFFER);
    expect(await banner(NEON)).toBe(true);
    expect(await banner(MIROIRS)).toBe(false);
  });

  it("« Masquer la bannière » (admin) la cache ; désactivé, elle revient", async () => {
    await (await admin()).admin.updateSettings({ neonBannerHidden: true });
    expect(await banner(NEON)).toBe(false);
    await (await admin()).admin.updateSettings({ neonBannerHidden: false });
    expect(await banner(NEON)).toBe(true);
  });

  it("offre désactivée ou boutique suspendue : plus de bannière", async () => {
    await (await vendor()).vendor.neon.saveOffer({ ...OFFER, enabled: false });
    expect(await banner(NEON)).toBe(false);
    await (await vendor()).vendor.neon.saveOffer(OFFER);
    await updateShopStatus(shopId, "suspended");
    try {
      // Boutique suspendue : la règle refuse la bannière (et la page de la catégorie n'existe plus)
      expect(await showNeonBanner(categorySlug(NEON))).toBe(false);
      await expect(banner(NEON)).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await updateShopStatus(shopId, "active");
    }
    expect(await banner(NEON)).toBe(true);
  });

  it("la catégorie est celle choisie par l'admin, pas déduite du nom", async () => {
    await (await admin()).admin.updateSettings({ neonCategorySlug: categorySlug(MIROIRS) });
    expect(await banner(MIROIRS)).toBe(true);
    expect(await banner(NEON)).toBe(false);
  });

  it("seul l'admin règle la bannière ; une catégorie inexistante ou mal formée est refusée", async () => {
    await expect((await vendor()).admin.updateSettings({ neonBannerHidden: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(anonymous().admin.updateSettings({ neonBannerHidden: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await admin()).admin.updateSettings({ neonCategorySlug: `inexistante-${S}` })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect((await admin()).admin.updateSettings({ neonCategorySlug: "Pas Un Slug !" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("accueil : la catégorie du configurateur a exactement la même forme que les autres (aucun bouton spécial)", async () => {
    const list = await anonymous().catalog.siteCategories();
    const neon = list.find((c) => c.slug === categorySlug(NEON));
    const other = list.find((c) => c.slug === categorySlug(MIROIRS));
    expect(neon && other).toBeTruthy();
    expect(Object.keys(neon!).sort()).toEqual(Object.keys(other!).sort());
  });
});
