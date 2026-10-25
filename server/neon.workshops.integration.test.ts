import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { appRouter } from "./routers";
import { ensureDatabaseConnection } from "./dbConnection";
import { getDb, updateShopStatus } from "./db";
import { sdk } from "./_core/sdk";
import { COOKIE_NAME } from "../shared/const";
import { NEON_PRODUCT_SLUG, type NeonOffer } from "../shared/neon";
import { neonOffers, orderItems, reviews } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

/**
 * Un configurateur néon PAR ATELIER (base de test) : une carte par atelier visible, /neon/<slug> verrouillé
 * sur l'offre de CET atelier, ligne de commande rattachée à cet atelier, options d'un autre atelier refusées,
 * et état « visible sur /neon » expliqué au vendeur. Comptes @elegancedeco.test supprimés par le nettoyage global.
 */

const S = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, "x");
const password = "MotDePasse2026";

const OFFER_A: NeonOffer = {
  enabled: true,
  sizes: [{ code: "S", widthCm: 50, priceTnd: 140 }, { code: "M", widthCm: 75, priceTnd: 210 }],
  includedLetters: 8, extraLetterPriceTnd: 5,
  colors: ["pink", "warm_white"],
  supports: [{ code: "rect", surchargeTnd: 15 }, { code: "none", surchargeTnd: 0 }],
  outdoorEnabled: false, outdoorSurchargeType: "percent", outdoorSurchargeValue: 0,
  arabicEnabled: false, productionDaysMin: 4, productionDaysMax: 6,
};
// B : autres tailles, couleur et support que A ne propose pas, arabe accepté
const OFFER_B: NeonOffer = {
  ...OFFER_A,
  sizes: [{ code: "L", widthCm: 100, priceTnd: 300 }, { code: "XL", widthCm: 130, priceTnd: 390 }],
  colors: ["ice_blue", "pink"],
  supports: [{ code: "cut", surchargeTnd: 25 }],
  arabicEnabled: true, productionDaysMin: 8, productionDaysMax: 12,
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

describe("Configurateur néon par atelier (base de test)", () => {
  const vendors: Record<"A" | "B" | "C", { token: string; userId: number; shopId: number; slug: string; name: string }> = {} as never;
  let clientToken = "";
  let clientId = 0;
  const shipping = { shippingName: "Client Atelier", shippingPhone: "+216 20 123 456", shippingAddress: "3 rue des Ateliers", shippingCity: "Tunis" };
  const line = (page: "A" | "B", neon: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    productSlug: NEON_PRODUCT_SLUG, productName: "Néon personnalisé", shopSlug: vendors[page].slug, shopName: vendors[page].name, quantity: 1, unitPriceTnd: 1,
    neon: { shopSlug: vendors[page].slug, text: "Hello", font: "pacifico", color: "pink", size: "S", support: "none", outdoor: false, ...neon }, ...extra,
  });
  const order = async (items: unknown[]) => (await caller(clientToken)).checkout.createOrder({ ...shipping, totalTnd: 1, items: items as never });
  const visibleSlugs = async () => (await anonymous().catalog.neonOffers()).map((o) => o.shopSlug).filter((s) => s.includes(S)).sort();

  beforeAll(async () => {
    await ensureDatabaseConnection();
    for (const key of ["A", "B", "C"] as const) {
      const { ctx, cookies } = makeContext();
      const name = `Atelier ${key} ${S}`;
      const res = await appRouter.createCaller(ctx).auth.registerVendor({
        firstName: "Atelier", lastName: key === "A" ? "Alpha" : key === "B" ? "Beta" : "Gamma", email: `atelier${key.toLowerCase()}_${S}@elegancedeco.test`, phone: "+216 50 111 222", city: "Sfax",
        shopName: name, whatsapp: "+216 50 111 222", password, passwordConfirm: password, acceptTerms: true,
      });
      await updateShopStatus(res.shop.id, "active");
      vendors[key] = { token: cookies[COOKIE_NAME], userId: res.user.id, shopId: res.shop.id, slug: res.shop.slug, name };
    }
    await (await caller(vendors.A.token)).vendor.neon.saveOffer(OFFER_A);
    await (await caller(vendors.B.token)).vendor.neon.saveOffer(OFFER_B);
    const c = makeContext();
    const reg = await appRouter.createCaller(c.ctx).auth.register({ name: "Client Atelier", email: `client_atelier_${S}@elegancedeco.test`, password });
    clientToken = c.cookies[COOKIE_NAME];
    clientId = reg.user.id;
  });

  afterAll(async () => {
    // Offres désactivées : les autres fichiers de test ne doivent pas voir d'atelier néon actif
    for (const key of ["A", "B"] as const) await (await caller(vendors[key].token)).vendor.neon.saveOffer({ ...OFFER_A, enabled: false }).catch(() => {});
  });

  it("2 ateliers visibles → 2 cartes : prix de départ, délai, note seulement s'il y a des avis publiés", async () => {
    const db = (await getDb())!;
    await db.insert(reviews).values({ userId: clientId, orderId: 0, productSlug: `avis-${S}`, productName: "Néon", shopSlug: vendors.A.slug, rating: 5, body: "Superbe", status: "published" });
    await db.insert(reviews).values({ userId: clientId, orderId: 0, productSlug: `avis2-${S}`, productName: "Néon", shopSlug: vendors.A.slug, rating: 4, body: "Très bien", status: "published" });
    await db.insert(reviews).values({ userId: clientId, orderId: 0, productSlug: `avis3-${S}`, productName: "Néon", shopSlug: vendors.B.slug, rating: 1, body: "En attente", status: "pending" });

    const cards = (await anonymous().catalog.neonOffers()).filter((o) => o.shopSlug.includes(S));
    expect(cards.map((c) => c.shopSlug).sort()).toEqual([vendors.A.slug, vendors.B.slug].sort());
    const a = cards.find((c) => c.shopSlug === vendors.A.slug)!;
    const b = cards.find((c) => c.shopSlug === vendors.B.slug)!;
    expect(a).toMatchObject({ shopName: vendors.A.name, fromPriceTnd: 140, rating: 4.5, reviewCount: 2, offer: { productionDaysMin: 4, productionDaysMax: 6 } });
    expect(a).toHaveProperty("shopCoverUrl");
    // Avis non publié : aucune note affichée
    expect(b).toMatchObject({ fromPriceTnd: 300, rating: null, reviewCount: 0 });
    // L'atelier C n'a jamais enregistré d'offre : pas de carte
    expect(cards.some((c) => c.shopSlug === vendors.C.slug)).toBe(false);
  });

  it("/neon/<A> : uniquement les tailles, couleurs, supports et règles de A ; slug inconnu → indisponible", async () => {
    const a = await anonymous().catalog.neonWorkshop({ shopSlug: vendors.A.slug });
    expect(a?.shopSlug).toBe(vendors.A.slug);
    expect(a?.offer.sizes.map((s) => s.code)).toEqual(["S", "M"]);
    expect(a?.offer.colors).toEqual(["pink", "warm_white"]);
    expect(a?.offer.supports.map((s) => s.code)).toEqual(["rect", "none"]);
    expect(a?.offer.arabicEnabled).toBe(false);
    const b = await anonymous().catalog.neonWorkshop({ shopSlug: vendors.B.slug });
    expect(b?.offer.sizes.map((s) => s.code)).toEqual(["L", "XL"]);
    expect(await anonymous().catalog.neonWorkshop({ shopSlug: `atelier-inexistant-${S}` })).toBeNull();
    expect(await anonymous().catalog.neonWorkshop({ shopSlug: vendors.C.slug })).toBeNull();
  });

  it("commande depuis /neon/<A> : la ligne est chez A (prix de A), jamais chez B", async () => {
    const created = await order([line("A", { text: "Hello", size: "M", support: "rect" })]);
    const db = (await getDb())!;
    const [row] = await db.select().from(orderItems).where(eq(orderItems.orderId, created.orderId));
    expect(row).toMatchObject({ shopId: vendors.A.shopId, shopSlug: vendors.A.slug, shopName: vendors.A.name, neonSize: "M", neonSupport: "rect" });
    expect(Number(row.unitPriceTnd)).toBe(225); // 210 (M chez A) + 15 (plaque chez A)
  });

  it("options de B envoyées sur /neon/<A> : refusées ; ligne annoncée chez B avec l'atelier A : refusée", async () => {
    // Taille, couleur, support et arabe que seul B propose
    await expect(order([line("A", { size: "L" })])).rejects.toThrow(/taille/i);
    await expect(order([line("A", { color: "ice_blue" })])).rejects.toThrow(/couleur/i);
    await expect(order([line("A", { support: "cut" })])).rejects.toThrow(/support/i);
    await expect(order([line("A", { text: "مرحبا", font: "reem-kufi" })])).rejects.toThrow(/arabe/i);
    // Panier : même refus, sans prix
    const quote = await anonymous().catalog.quoteCart({ lines: [{ productSlug: NEON_PRODUCT_SLUG, quantity: 1, neon: { shopSlug: vendors.A.slug, text: "Hello", font: "pacifico", color: "ice_blue", size: "L", support: "cut", outdoor: false } }] });
    expect(quote.lines[0]).toMatchObject({ available: false, unitPriceTnd: 0 });
    // Ligne « chez B » mais configurée sur la page de A : incohérente, refusée (pas de tarif croisé)
    await expect(order([line("A", {}, { shopSlug: vendors.B.slug, shopName: vendors.B.name })])).rejects.toThrow(/ne correspond pas à l'atelier/);
  });

  it("offre de A désactivée → carte et page de A disparaissent, commande refusée ; réactivée → de retour", async () => {
    await (await caller(vendors.A.token)).vendor.neon.saveOffer({ ...OFFER_A, enabled: false });
    expect(await visibleSlugs()).toEqual([vendors.B.slug]);
    expect(await anonymous().catalog.neonWorkshop({ shopSlug: vendors.A.slug })).toBeNull();
    await expect(order([line("A", {})])).rejects.toThrow(/ne propose plus/);
    await (await caller(vendors.A.token)).vendor.neon.saveOffer(OFFER_A);
    expect(await visibleSlugs()).toEqual([vendors.A.slug, vendors.B.slug].sort());
    // Boutique suspendue : même effet
    await updateShopStatus(vendors.A.shopId, "suspended");
    try {
      expect(await anonymous().catalog.neonWorkshop({ shopSlug: vendors.A.slug })).toBeNull();
      expect(await visibleSlugs()).toEqual([vendors.B.slug]);
    } finally {
      await updateShopStatus(vendors.A.shopId, "active");
    }
  });

  it("vendeur : nom de SA boutique + « visible sur /neon » ou la liste de ce qui manque", async () => {
    const a = await caller(vendors.A.token);
    expect(await a.vendor.neon.offer()).toMatchObject({ shopName: vendors.A.name, shopSlug: vendors.A.slug, visibility: { visible: true, missing: [] } });
    // Jamais enregistrée
    const c = await (await caller(vendors.C.token)).vendor.neon.offer();
    expect(c).toMatchObject({ shopName: vendors.C.name, offer: null, visibility: { visible: false } });
    expect(c.visibility.missing.join(" ")).toMatch(/Enregistrez votre offre/);
    // Désactivée
    await a.vendor.neon.saveOffer({ ...OFFER_A, enabled: false });
    expect((await a.vendor.neon.offer()).visibility.missing.join(" ")).toMatch(/Activez l'offre/);
    // Offre devenue incomplète en base (aucune couleur, aucun support) : toutes les raisons, et absente de /neon
    await a.vendor.neon.saveOffer(OFFER_A);
    const db = (await getDb())!;
    await db.update(neonOffers).set({ colorsJson: "[]", supportsJson: "[]" }).where(eq(neonOffers.shopId, vendors.A.shopId));
    const broken = (await a.vendor.neon.offer()).visibility;
    expect(broken.visible).toBe(false);
    expect(broken.missing).toEqual(expect.arrayContaining(["Proposez au moins une couleur", "Proposez au moins un support"]));
    expect(await visibleSlugs()).toEqual([vendors.B.slug]);
    // Boutique suspendue : raison explicite
    await a.vendor.neon.saveOffer(OFFER_A);
    await updateShopStatus(vendors.A.shopId, "suspended");
    try {
      expect((await a.vendor.neon.offer()).visibility.missing.join(" ")).toMatch(/boutique doit être validée/);
    } finally {
      await updateShopStatus(vendors.A.shopId, "active");
    }
    // Le formulaire refuse un enregistrement incomplet avec TOUTES les erreurs (pas seulement la première)
    await expect(a.vendor.neon.saveOffer({ ...OFFER_A, colors: [], supports: [] })).rejects.toThrow(/couleur[\s\S]*support|support[\s\S]*couleur/);
  });
});
