import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import zlib from "zlib";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { appRouter } from "./routers";
import { ensureDatabaseConnection } from "./dbConnection";
import { createOrUpdateAdminUser, getDb, updateShopStatus } from "./db";
import { createMediaRecord } from "./vendorCatalog";
import { registerMediaRoutes } from "./mediaRoutes";
import { sdk } from "./_core/sdk";
import { COOKIE_NAME } from "../shared/const";
import { NEON_PRODUCT_SLUG, type NeonOffer } from "../shared/neon";
import { orderItems } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

/**
 * Étape 5 — néon personnalisé (base de test) : offres des ateliers, prix recalculé par le serveur,
 * refus (texte, police, couleur, taille, support, arabe), ligne de commande figée, devis avec logo.
 * Comptes @elegancedeco.test supprimés par le nettoyage global.
 */

const S = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, "x");
const password = "MotDePasse2026";

const OFFER_A: NeonOffer = {
  enabled: true,
  sizes: [{ code: "S", widthCm: 50, priceTnd: 150 }, { code: "M", widthCm: 75, priceTnd: 220 }],
  includedLetters: 6, extraLetterPriceTnd: 8.5,
  colors: ["pink", "warm_white"],
  supports: [{ code: "cut", surchargeTnd: 30 }, { code: "none", surchargeTnd: 0 }],
  outdoorEnabled: true, outdoorSurchargeType: "percent", outdoorSurchargeValue: 20,
  arabicEnabled: false, productionDaysMin: 5, productionDaysMax: 7,
};
const OFFER_B: NeonOffer = { ...OFFER_A, sizes: [{ code: "M", widthCm: 75, priceTnd: 260 }], arabicEnabled: true, colors: ["pink", "ice_blue"] };

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

/** PNG réel (couleur unie) généré sans bibliothèque. */
function png(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 180)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

describe("Néon personnalisé (base de test)", () => {
  const vendors: Record<"A" | "B", { token: string; userId: number; shopId: number; slug: string }> = {} as never;
  let clientToken = "";
  let otherClientToken = "";
  let otherClientId = 0;
  let clientId = 0;
  let adminToken = "";
  let srv: { server: Server; base: string };
  const shipping = { shippingName: "Client Néon", shippingPhone: "+216 20 123 456", shippingAddress: "12 rue de la Lumière", shippingCity: "Tunis" };
  const neonLine = (shop: "A" | "B", neon: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    productSlug: NEON_PRODUCT_SLUG, productName: "Néon pas cher", shopSlug: vendors[shop].slug, shopName: "Nom inventé", quantity: 1, unitPriceTnd: 1,
    neon: { shopSlug: vendors[shop].slug, text: "Coffee", font: "pacifico", color: "pink", size: "S", support: "none", outdoor: false, ...neon }, ...extra,
  });
  const order = async (items: unknown[]) => (await caller(clientToken)).checkout.createOrder({ ...shipping, totalTnd: 1, items: items as never });

  beforeAll(async () => {
    await ensureDatabaseConnection();
    for (const key of ["A", "B"] as const) {
      const { ctx, cookies } = makeContext();
      const res = await appRouter.createCaller(ctx).auth.registerVendor({
        firstName: "Atelier", lastName: key === "A" ? "Alpha" : "Beta", email: `vendeur${key.toLowerCase()}_${S}@elegancedeco.test`, phone: "+216 50 111 222", city: "Tunis",
        shopName: `Atelier Néon ${key} ${S}`, whatsapp: "+216 50 111 222", password, passwordConfirm: password, acceptTerms: true,
      });
      await updateShopStatus(res.shop.id, "active");
      vendors[key] = { token: cookies[COOKIE_NAME], userId: res.user.id, shopId: res.shop.id, slug: res.shop.slug };
    }
    for (const [label, set] of [["client", (t: string, id: number) => { clientToken = t; clientId = id; }], ["autreclient", (t: string, id: number) => { otherClientToken = t; otherClientId = id; }]] as const) {
      const c = makeContext();
      const r = await appRouter.createCaller(c.ctx).auth.register({ name: `Client ${label}`, email: `${label}_${S}@elegancedeco.test`, password });
      set(c.cookies[COOKIE_NAME], r.user.id);
    }
    await createOrUpdateAdminUser({ email: `admin_${S}@elegancedeco.test`, password, name: "Admin Test" });
    const a = makeContext();
    await appRouter.createCaller(a.ctx).auth.login({ email: `admin_${S}@elegancedeco.test`, password });
    adminToken = a.cookies[COOKIE_NAME];
    srv = await (async () => {
      const app = express();
      registerMediaRoutes(app);
      const server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
      const address = server.address();
      return { server, base: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}` };
    })();
  });

  afterAll(async () => {
    // Offres désactivées : les autres fichiers de test ne doivent pas voir d'atelier néon actif
    for (const key of ["A", "B"] as const) await (await caller(vendors[key].token)).vendor.neon.saveOffer({ ...OFFER_A, enabled: false }).catch(() => {});
    await new Promise((resolve) => srv?.server.close(resolve));
  });

  it("réglages de l'atelier : enregistrés pour SA boutique, invalides refusés, réservés aux vendeurs", async () => {
    const a = await caller(vendors.A.token);
    await expect(a.vendor.neon.saveOffer({ ...OFFER_A, sizes: [{ code: "S", widthCm: 50, priceTnd: 0 }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await a.vendor.neon.saveOffer(OFFER_A);
    await (await caller(vendors.B.token)).vendor.neon.saveOffer(OFFER_B);
    expect((await a.vendor.neon.offer()).offer).toMatchObject({ enabled: true, includedLetters: 6, colors: ["pink", "warm_white"] });
    await expect((await caller(clientToken)).vendor.neon.saveOffer(OFFER_A)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("liste publique : uniquement les ateliers actifs avec une offre activée", async () => {
    const mine = async () => (await anonymous().catalog.neonOffers()).map((o) => o.shopSlug).filter((s) => s.includes(S)).sort();
    expect(await mine()).toEqual([vendors.A.slug, vendors.B.slug].sort());
    await updateShopStatus(vendors.B.shopId, "suspended");
    expect(await mine()).toEqual([vendors.A.slug]);
    await updateShopStatus(vendors.B.shopId, "active");
    await (await caller(vendors.B.token)).vendor.neon.saveOffer({ ...OFFER_B, enabled: false });
    expect(await mine()).toEqual([vendors.A.slug]);
    await (await caller(vendors.B.token)).vendor.neon.saveOffer(OFFER_B);
  });

  it("panier : prix recalculé par le serveur depuis l'offre (aucun montant accepté du navigateur)", async () => {
    const quote = await anonymous().catalog.quoteCart({ lines: [
      { productSlug: NEON_PRODUCT_SLUG, quantity: 2, neon: { shopSlug: vendors.A.slug, text: "Bienvenue !", font: "pacifico", color: "pink", size: "M", support: "cut", outdoor: true } },
      { productSlug: NEON_PRODUCT_SLUG, quantity: 1, neon: { shopSlug: vendors.A.slug, text: "Coffee", font: "pacifico", color: "green", size: "S", support: "none", outdoor: false } },
    ] });
    expect(quote.lines[0]).toMatchObject({ available: true, unitPriceTnd: 330.6 });
    expect(quote.lines[1]).toMatchObject({ available: false, problem: "Cette couleur n'est pas proposée par l'atelier." });
    expect(quote.subtotalTnd).toBe(661.2);
  });

  it("commande : prix du navigateur ignoré, ligne FIGÉE (texte, police, couleur nom + code, taille, support, extérieur, prix)", async () => {
    const res = await order([neonLine("A", { text: "Bienvenue !", size: "M", support: "cut", outdoor: true })]);
    expect(res.totalTnd).toBe(330.6);
    const db = (await getDb())!;
    const line = (await db.select().from(orderItems).where(eq(orderItems.orderId, res.orderId!)))[0];
    expect(line).toMatchObject({
      productSlug: NEON_PRODUCT_SLUG, productName: "Néon personnalisé", shopId: vendors.A.shopId, shopSlug: vendors.A.slug,
      unitPriceTnd: "330.60", pricingMode: "neon", neonText: "Bienvenue !", neonScript: "latin", neonFont: "pacifico",
      neonColorName: "Rose", neonColorHex: "#FF4FA8", neonSize: "M", neonSupport: "cut", neonOutdoor: 1, widthCm: 75,
    });
    expect(JSON.parse(line.neonDetailsJson!)).toMatchObject({ letters: 9, extraLetters: 3, letterSurchargeTnd: 25.5, outdoorSurchargeTnd: 55.1, priceTnd: 330.6 });
  });

  it("refus : texte trop long, police / couleur / taille / support non proposés, extérieur indisponible", async () => {
    const refused = async (neon: Record<string, unknown>, message: RegExp) => {
      await expect(order([neonLine("A", neon)])).rejects.toMatchObject({ code: "BAD_REQUEST", message });
    };
    await refused({ text: "Un\nDeux\nTrois\nQuatre" }, /3 lignes/);
    await refused({ text: "Coffee 2026 et compagnie 1" }, /25 caractères/);
    await refused({ font: "yellowtail" }, /police/);
    await refused({ color: "green" }, /couleur/);
    await refused({ size: "XL" }, /taille/);
    await refused({ support: "rect" }, /support/);
    await refused({ text: "Love 😍" }, /non accepté/);
    await (await caller(vendors.A.token)).vendor.neon.saveOffer({ ...OFFER_A, outdoorEnabled: false });
    await refused({ outdoor: true }, /extérieur/);
    await (await caller(vendors.A.token)).vendor.neon.saveOffer(OFFER_A);
  });

  it("arabe : refusé chez un atelier qui ne l'accepte pas ; accepté avec une police arabe ; mélange refusé", async () => {
    await expect(order([neonLine("A", { text: "مرحبا", font: "reem-kufi" })])).rejects.toMatchObject({ message: /ne réalise pas de néons en arabe/ });
    await expect(order([neonLine("B", { text: "مرحبا", font: "pacifico", size: "M" })])).rejects.toMatchObject({ message: /Reem Kufi ou Aref Ruqaa/ });
    await expect(order([neonLine("B", { text: "Hello مرحبا", font: "reem-kufi", size: "M" })])).rejects.toMatchObject({ message: /Une seule écriture par néon/ });
    const res = await order([neonLine("B", { text: "مرحبا 2026", font: "aref-ruqaa", size: "M", color: "ice_blue" })]);
    const line = (await (await getDb())!.select().from(orderItems).where(eq(orderItems.orderId, res.orderId!)))[0];
    expect(line).toMatchObject({ neonText: "مرحبا 2026", neonScript: "arabic", neonFont: "aref-ruqaa", neonColorName: "Bleu glace", unitPriceTnd: "260.00" });
    expect(JSON.parse(line.neonDetailsJson!)).toMatchObject({ letters: 5, extraLetters: 0 });
  });

  it("tarifs modifiés après la commande : l'ancienne commande reste inchangée", async () => {
    const res = await order([neonLine("A", { text: "Coffee", size: "S" })]);
    await (await caller(vendors.A.token)).vendor.neon.saveOffer({ ...OFFER_A, sizes: [{ code: "S", widthCm: 60, priceTnd: 999 }], colors: ["warm_white"] });
    const detail = await (await caller(clientToken)).account.order({ orderId: res.orderId! });
    expect(detail?.items[0]).toMatchObject({ unitPriceTnd: "150.00", widthCm: 50, neon: { text: "Coffee", colorName: "Rose", colorHex: "#FF4FA8", size: "S", fontName: "Pacifico" } });
    // Une nouvelle commande utilise le nouveau tarif
    const quote = await anonymous().catalog.quoteCart({ lines: [{ productSlug: NEON_PRODUCT_SLUG, quantity: 1, neon: { shopSlug: vendors.A.slug, text: "Coffee", font: "pacifico", color: "warm_white", size: "S", support: "none", outdoor: false } }] });
    expect(quote.lines[0].unitPriceTnd).toBe(999);
    await (await caller(vendors.A.token)).vendor.neon.saveOffer(OFFER_A);
  });

  it("le vendeur, l'admin et le client voient l'aperçu et les infos de fabrication", async () => {
    const res = await order([neonLine("A", { text: "Salon\nde thé", font: "monoton", color: "warm_white" })]);
    const vendorLine = (await (await caller(vendors.A.token)).vendor.dashboard()).orders.find((o) => o.orderId === res.orderId);
    expect(vendorLine?.neon).toMatchObject({ text: "Salon\nde thé", script: "latin", fontKey: "monoton", colorName: "Blanc chaud", colorHex: "#FFE9C7", size: "S", supportName: "Sans support", outdoor: false });
    expect(vendorLine?.customSummary).toContain("« Salon / de thé »");
    // L'autre atelier ne voit pas cette commande
    expect((await (await caller(vendors.B.token)).vendor.dashboard()).orders.some((o) => o.orderId === res.orderId)).toBe(false);
    const adminDetail = await (await caller(adminToken)).admin.order({ orderId: res.orderId! });
    expect(adminDetail.items[0].neon).toMatchObject({ text: "Salon\nde thé", fontName: "Monoton" });
    const clientDetail = await (await caller(clientToken)).account.order({ orderId: res.orderId! });
    expect(clientDetail?.items[0].neon).toMatchObject({ text: "Salon\nde thé" });
  });

  it("devis logo : client connecté uniquement, SON logo, visible par l'atelier destinataire seulement", async () => {
    // Envoi du logo : même validation que les photos produits
    const upload = (token: string | null, body: Buffer, shop = vendors.A.slug) => fetch(`${srv.base}/api/neon/quote-logo?shop=${shop}&name=logo.png`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", ...(token ? { cookie: `${COOKIE_NAME}=${token}` } : {}) }, body,
    });
    expect((await upload(null, png(40, 40))).status).toBe(401);
    expect((await upload(vendors.B.token, png(40, 40))).status).toBe(403);
    expect((await upload(clientToken, Buffer.from("ceci n'est pas une image"))).status).toBe(415);
    const ok = await upload(clientToken, png(40, 40));
    expect(ok.status).toBe(201);
    const logo = (await ok.json()) as { id: number; url: string };

    await expect(anonymous().neon.requestQuote({ shopSlug: vendors.A.slug, mediaId: logo.id })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect((await caller(vendors.B.token)).neon.requestQuote({ shopSlug: vendors.A.slug, mediaId: logo.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Le logo d'un autre client est refusé
    await expect((await caller(otherClientToken)).neon.requestQuote({ shopSlug: vendors.A.slug, mediaId: logo.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const created = await (await caller(clientToken)).neon.requestQuote({ shopSlug: vendors.A.slug, mediaId: logo.id, message: "Logo pour mon café", sizeCode: "M", outdoor: true });
    expect(created.id).toBeGreaterThan(0);
    await expect((await caller(clientToken)).neon.requestQuote({ shopSlug: vendors.A.slug, mediaId: logo.id })).rejects.toMatchObject({ message: /déjà été envoyé/ });

    const quotesA = await (await caller(vendors.A.token)).vendor.neon.quotes();
    expect(quotesA.find((q) => q.id === created.id)).toMatchObject({ message: "Logo pour mon café", sizeCode: "M", outdoor: 1, status: "new" });
    expect((await (await caller(vendors.B.token)).vendor.neon.quotes()).some((q) => q.id === created.id)).toBe(false);
    await expect((await caller(vendors.B.token)).vendor.neon.setQuoteStatus({ id: created.id, status: "answered" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await (await caller(vendors.A.token)).vendor.neon.setQuoteStatus({ id: created.id, status: "answered" });
    expect((await (await caller(adminToken)).admin.neonQuotes()).find((q) => q.id === created.id)).toMatchObject({ status: "answered" });

    // Logo privé : visible par le client, l'atelier A et l'admin ; pas par l'atelier B ni un visiteur
    const view = (token: string | null) => fetch(`${srv.base}${logo.url}`, { headers: token ? { cookie: `${COOKIE_NAME}=${token}` } : {} }).then((r) => r.status);
    expect(await view(clientToken)).toBe(200);
    expect(await view(vendors.A.token)).toBe(200);
    expect(await view(adminToken)).toBe(200);
    expect(await view(vendors.B.token)).toBe(404);
    expect(await view(null)).toBe(404);
    expect(clientId && otherClientId).toBeTruthy();
  });
});
