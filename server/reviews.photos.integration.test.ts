import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import fs from "fs";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { appRouter } from "./routers";
import { ensureDatabaseConnection } from "./dbConnection";
import { createOrUpdateAdminUser, getDb, updateShopStatus } from "./db";
import { registerMediaRoutes } from "./mediaRoutes";
import { registerReviewPhotoRoutes } from "./reviewPhotoRoutes";
import { resolveStoragePath } from "./mediaStorage";
import { cleanupPendingReviewPhotos } from "./customerReviews";
import { sdk } from "./_core/sdk";
import { COOKIE_NAME } from "../shared/const";
import { reviewPhotos, reviews } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import type { ProductInput } from "../shared/productValidation";

/**
 * A-10c — avis clients avec photos, sur la base de TEST (comptes @elegancedeco.test supprimés à la fin) :
 * ligne livrée obligatoire, une fois par ligne, photos validées et privées avant publication, anonymat,
 * moyennes / répartition / critères calculés sur les avis publiés, avis et photos masqués exclus,
 * « Utile » (un vote par compte), signalements, réponse unique du vendeur sur ses seuls avis, nettoyage après 24 h.
 */

const S = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, "x");
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

describe("Avis clients avec photos (A-10c, base de test)", () => {
  let server: Server;
  let base = "";
  let adminToken = "";
  const vendors: Record<"a" | "b", { token: string; shopId: number; shopSlug: string }> = { a: { token: "", shopId: 0, shopSlug: "" }, b: { token: "", shopId: 0, shopSlug: "" } };
  const clients: Record<"sarra" | "karim", string> = { sarra: "", karim: "" };
  const slugs = { fixed: "", custom: "", other: "" };
  const lines = { fixed: 0, custom: 0, other: 0 };
  const reviewIds = { fixed: 0, custom: 0 };
  let photoId = 0;
  let photoUrl = "";

  const registerVendor = async (label: string) => {
    const { ctx, cookies } = makeContext();
    const res = await appRouter.createCaller(ctx).auth.registerVendor({
      firstName: "Test", lastName: label, email: `avis_${label}_${S}@elegancedeco.test`, phone: "+216 50 111 222", city: "Sfax",
      shopName: `Atelier avis ${label} ${S}`, whatsapp: "+216 50 111 222", password, passwordConfirm: password, acceptTerms: true,
    });
    await updateShopStatus(res.shop.id, "active");
    const shop = (await (await caller(cookies[COOKIE_NAME])).vendor.dashboard()).shop!;
    return { token: cookies[COOKIE_NAME], shopId: res.shop.id, shopSlug: shop.slug };
  };
  const registerClient = async (first: string, last: string) => {
    const { ctx, cookies } = makeContext();
    await appRouter.createCaller(ctx).auth.registerCustomer({
      firstName: first, lastName: last, email: `avis_${first.toLowerCase()}_${S}@elegancedeco.test`, phone: "+216 20 123 456",
      city: "Sousse", address: "Rue de la Plage 4", password, passwordConfirm: password,
    });
    return cookies[COOKIE_NAME];
  };
  const upload = (token: string | null, body: Buffer, path = "/api/review-uploads") =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/octet-stream", ...(token ? { cookie: `${COOKIE_NAME}=${token}` } : {}) }, body });
  const productImage = async (token: string) => {
    const res = await fetch(`${base}/api/uploads?kind=image&name=p.png`, { method: "POST", headers: { "Content-Type": "image/png", cookie: `${COOKIE_NAME}=${token}` }, body: PNG });
    return ((await res.json()) as { id: number }).id;
  };
  const productInput = (name: string, imageId: number, extra: Partial<ProductInput> = {}): ProductInput => ({
    name, description: "Pièce décorative réalisée à la main, finition soignée.", priceTnd: 120, promoPriceTnd: null, availability: "in_stock", stock: 10, sku: "",
    variants: { dimensions: [], colors: [], materials: [], models: [] }, delivery: "", preparationTime: "", extraInfo: "",
    images: [{ mediaId: imageId, isPrimary: true }], videoMediaId: null, videoUrl: null, action: "publish", ...extra,
  });
  const order = async (token: string, items: Array<{ productSlug: string; widthCm?: number; heightCm?: number }>) =>
    (await (await caller(token)).checkout.createOrder({
      shippingName: "Sarra Ben Ali", shippingPhone: "+216 20 123 456", shippingAddress: "Rue de la Plage 4", shippingCity: "Hammam Sousse, Sousse",
      items: items.map((i) => ({ ...i, productName: "x", shopSlug: "x", shopName: "x", quantity: 1, unitPriceTnd: 1 })),
    })).orderId!;
  const lineOf = async (token: string, slug: string) => (await (await caller(token)).reviews.reviewableLines()).find((l) => l.productSlug === slug);

  beforeAll(async () => {
    await ensureDatabaseConnection();
    const app = express();
    registerMediaRoutes(app);
    registerReviewPhotoRoutes(app);
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    await createOrUpdateAdminUser({ email: `avis_admin_${S}@elegancedeco.test`, password, name: "Admin Avis" });
    const adminLogin = makeContext();
    await appRouter.createCaller(adminLogin.ctx).auth.login({ email: `avis_admin_${S}@elegancedeco.test`, password });
    adminToken = adminLogin.cookies[COOKIE_NAME];

    vendors.a = await registerVendor("alpha");
    vendors.b = await registerVendor("beta");
    clients.sarra = await registerClient("Sarra", "Ben Ali");
    clients.karim = await registerClient("Karim", "Trabelsi");

    const va = await caller(vendors.a.token);
    slugs.fixed = (await va.vendor.saveProduct(productInput(`Miroir avis ${S}`, await productImage(vendors.a.token)))).slug!;
    slugs.custom = (await va.vendor.saveProduct(productInput(`Enseigne avis ${S}`, await productImage(vendors.a.token), {
      availability: "made_to_order", stock: null, pricingMode: "per_m2", unitPriceTnd: 400, minWidthCm: 30, maxWidthCm: 200, minHeightCm: 20, maxHeightCm: 200, minBillableArea: 0.25,
    } as Partial<ProductInput>))).slug!;
    slugs.other = (await (await caller(vendors.b.token)).vendor.saveProduct(productInput(`Vase avis ${S}`, await productImage(vendors.b.token)))).slug!;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("aucun avis possible tant que la ligne n'est pas livrée", async () => {
    const orderId = await order(clients.sarra, [{ productSlug: slugs.fixed }, { productSlug: slugs.custom, widthCm: 80, heightCm: 150 }]);
    expect(await lineOf(clients.sarra, slugs.fixed)).toBeUndefined();
    const db = (await getDb())!;
    const { orderItems } = await import("../drizzle/schema");
    const rows = await db.select({ id: orderItems.id, slug: orderItems.productSlug }).from(orderItems).where(eq(orderItems.orderId, orderId));
    lines.fixed = rows.find((r) => r.slug === slugs.fixed)!.id;
    lines.custom = rows.find((r) => r.slug === slugs.custom)!.id;
    const sarra = await caller(clients.sarra);
    await expect(sarra.reviews.submitForLine({ orderItemId: lines.fixed, rating: 5, qualityRating: 5, conformityRating: 5, deliveryRating: 5, body: "Superbe miroir, très bien emballé.", photoIds: [], anonymous: false }))
      .rejects.toThrow("une fois cet article livré");
    await (await caller(vendors.a.token)).vendor.updateOrderStatus({ orderId, status: "delivered" });
  });

  it("ligne livrée : variante copiée, aperçu du nom public « Sarra B. · Sousse »", async () => {
    const custom = await lineOf(clients.sarra, slugs.custom);
    expect(custom).toMatchObject({ orderItemId: lines.custom, purchasedVariant: "80 × 150 cm", publicName: "Sarra B.", publicGovernorate: "Sousse" });
    expect((await lineOf(clients.sarra, slugs.fixed))?.purchasedVariant).toBeNull();
  });

  it("photos : client connecté uniquement, vraie image, privée avant publication", async () => {
    expect((await upload(null, PNG)).status).toBe(401);
    expect((await upload(vendors.a.token, PNG)).status).toBe(403);
    expect((await upload(clients.sarra, Buffer.from("ceci n'est pas une image, juste du texte"))).status).toBe(415);
    const res = await upload(clients.sarra, PNG);
    expect(res.status).toBe(201);
    ({ id: photoId, url: photoUrl } = (await res.json()) as { id: number; url: string });
    expect((await fetch(`${base}${photoUrl}`)).status).toBe(404);
    expect((await fetch(`${base}${photoUrl}`, { headers: { cookie: `${COOKIE_NAME}=${clients.sarra}` } })).status).toBe(200);
  });

  it("envoi refusé : ligne d'un autre client, photo d'un autre compte, plus de 3 photos", async () => {
    const base = { orderItemId: lines.fixed, rating: 5, qualityRating: 5, conformityRating: 5, deliveryRating: 4, body: "Superbe miroir, très bien emballé.", anonymous: false };
    await expect((await caller(clients.karim)).reviews.submitForLine({ ...base, photoIds: [] })).rejects.toThrow("introuvable");
    const karimPhoto = (await (await upload(clients.karim, PNG)).json()) as { id: number };
    await expect((await caller(clients.sarra)).reviews.submitForLine({ ...base, photoIds: [karimPhoto.id] })).rejects.toThrow("Une photo est introuvable");
    await expect((await caller(clients.sarra)).reviews.submitForLine({ ...base, photoIds: [1, 2, 3, 4] })).rejects.toThrow();
  });

  it("un avis par ligne ; anonyme = ni nom ni gouvernorat enregistrés", async () => {
    const sarra = await caller(clients.sarra);
    const fixed = await sarra.reviews.submitForLine({ orderItemId: lines.fixed, rating: 5, qualityRating: 5, conformityRating: 5, deliveryRating: 4, body: "Superbe miroir, très bien emballé.", photoIds: [photoId], anonymous: false });
    reviewIds.fixed = fixed.id;
    expect(fixed.status).toBe("pending");
    await expect(sarra.reviews.submitForLine({ orderItemId: lines.fixed, rating: 1, qualityRating: 1, conformityRating: 1, deliveryRating: 1, body: "Deuxième avis sur la même ligne.", photoIds: [], anonymous: false }))
      .rejects.toThrow("déjà donné votre avis");
    reviewIds.custom = (await sarra.reviews.submitForLine({ orderItemId: lines.custom, rating: 2, qualityRating: 2, conformityRating: 1, deliveryRating: 3, body: "Couleur un peu différente de la photo.", photoIds: [], anonymous: true })).id;
    const db = (await getDb())!;
    const [stored] = await db.select().from(reviews).where(eq(reviews.id, reviewIds.custom));
    expect(stored).toMatchObject({ authorDisplayName: null, authorGovernorate: null, purchasedVariant: "80 × 150 cm", isCustom: 1, orderItemId: lines.custom });
    const [named] = await db.select().from(reviews).where(eq(reviews.id, reviewIds.fixed));
    expect(named).toMatchObject({ authorDisplayName: "Sarra B.", authorGovernorate: "Sousse" });
    expect(await sarra.reviews.reviewableLines()).toEqual([]);
  });

  it("moyenne, répartition et critères : avis publiés seulement, avis masqué exclu", async () => {
    const pub = anonymous();
    expect((await pub.reviews.overview({ productSlug: slugs.fixed })).product.count).toBe(0);
    const admin = await caller(adminToken);
    await admin.admin.updateReviewStatus({ reviewId: reviewIds.fixed, status: "published" });
    await admin.admin.updateReviewStatus({ reviewId: reviewIds.custom, status: "published" });

    const overview = await pub.reviews.overview({ productSlug: slugs.fixed });
    expect(overview.product).toMatchObject({ count: 1, average: 5, withPhotos: 1 });
    expect(overview.shop).toMatchObject({ count: 2, average: 3.5, criteria: { qualityRating: 3.5, conformityRating: 3, deliveryRating: 3.5 } });
    expect(overview.shop.distribution).toEqual([{ stars: 5, count: 1 }, { stars: 4, count: 0 }, { stars: 3, count: 0 }, { stars: 2, count: 1 }, { stars: 1, count: 0 }]);
    expect((await fetch(`${base}${photoUrl}`)).status).toBe(200);

    await admin.admin.updateReviewStatus({ reviewId: reviewIds.custom, status: "rejected" });
    expect((await pub.reviews.overview({ productSlug: slugs.fixed })).shop).toMatchObject({ count: 1, average: 5 });
    expect((await pub.reviews.page({ scope: "shop", slug: vendors.a.shopSlug })).total).toBe(1);
    await admin.admin.updateReviewStatus({ reviewId: reviewIds.custom, status: "published" });
  });

  it("filtres, tri et affichage : achat vérifié, anonyme « Client vérifié »", async () => {
    const pub = anonymous();
    const scope = { scope: "shop" as const, slug: vendors.a.shopSlug };
    expect((await pub.reviews.page({ ...scope, filter: "photos" })).items.map((r) => r.id)).toEqual([reviewIds.fixed]);
    expect((await pub.reviews.page({ ...scope, filter: "five" })).items.map((r) => r.id)).toEqual([reviewIds.fixed]);
    expect((await pub.reviews.page({ ...scope, filter: "custom" })).items.map((r) => r.id)).toEqual([reviewIds.custom]);
    const low = await pub.reviews.page({ ...scope, sort: "rating_low" });
    expect(low.items[0]).toMatchObject({ id: reviewIds.custom, author: "Client vérifié", anonymous: true, authorGovernorate: null, verifiedPurchase: true, purchasedVariant: "80 × 150 cm" });
    expect(low.items[1]).toMatchObject({ author: "Sarra B.", authorGovernorate: "Sousse", verifiedPurchase: true });
    expect(low.items[1].photos).toHaveLength(1);
  });

  it("photo masquée par l'admin : retirée de la fiche et du fichier public", async () => {
    const admin = await caller(adminToken);
    await admin.admin.setReviewPhotoHidden({ photoId, hidden: true });
    expect(await anonymous().reviews.photos({ scope: "product", slug: slugs.fixed })).toEqual([]);
    expect((await fetch(`${base}${photoUrl}`)).status).toBe(404);
    expect((await admin.admin.reviewDetail({ reviewId: reviewIds.fixed })).photos).toEqual([expect.objectContaining({ id: photoId, hidden: true })]);
    await admin.admin.setReviewPhotoHidden({ photoId, hidden: false });
    expect(await anonymous().reviews.photos({ scope: "product", slug: slugs.fixed })).toHaveLength(1);
  });

  it("« Utile » : un vote par compte (second clic = retrait), pas sur son propre avis", async () => {
    const karim = await caller(clients.karim);
    expect(await karim.reviews.toggleHelpful({ reviewId: reviewIds.fixed })).toEqual({ voted: true, helpfulCount: 1 });
    expect(await karim.reviews.toggleHelpful({ reviewId: reviewIds.fixed })).toEqual({ voted: false, helpfulCount: 0 });
    await karim.reviews.toggleHelpful({ reviewId: reviewIds.fixed });
    await expect((await caller(clients.sarra)).reviews.toggleHelpful({ reviewId: reviewIds.fixed })).rejects.toThrow("propre avis");
    const sorted = await (await caller(clients.karim)).reviews.page({ scope: "shop", slug: vendors.a.shopSlug, sort: "helpful" });
    expect(sorted.items[0]).toMatchObject({ id: reviewIds.fixed, helpfulCount: 1, votedByMe: true });
  });

  it("« Signaler » : une fois par compte, visible et traitable dans l'admin", async () => {
    const karim = await caller(clients.karim);
    await karim.reviews.report({ reviewId: reviewIds.custom, reason: "Contenu hors sujet" });
    await expect(karim.reviews.report({ reviewId: reviewIds.custom, reason: "Encore une fois" })).rejects.toThrow("déjà signalé");
    const admin = await caller(adminToken);
    const open = await admin.admin.reviewReports({ status: "open" });
    const report = open.items.find((r) => r.reviewId === reviewIds.custom)!;
    expect(report).toMatchObject({ reason: "Contenu hors sujet", status: "open" });
    await admin.admin.resolveReviewReport({ reportId: report.id });
    await expect(admin.admin.resolveReviewReport({ reportId: report.id })).rejects.toThrow("déjà traité");
  });

  it("vendeur : répond à SES avis, une seule fois, sans pouvoir modifier l'avis", async () => {
    await expect((await caller(vendors.b.token)).vendor.replyToReview({ reviewId: reviewIds.fixed, body: "Merci !" })).rejects.toThrow("Avis introuvable");
    const va = await caller(vendors.a.token);
    expect(await va.vendor.replyToReview({ reviewId: reviewIds.fixed, body: "Merci Sarra pour votre confiance !" })).toEqual({ replied: true });
    await expect(va.vendor.replyToReview({ reviewId: reviewIds.fixed, body: "Je modifie ma réponse" })).rejects.toThrow("déjà répondu");
    const mine = (await va.vendor.customerReviews()).find((r) => r.id === reviewIds.fixed)!;
    expect(mine).toMatchObject({ vendorReply: "Merci Sarra pour votre confiance !", canReply: false, body: "Superbe miroir, très bien emballé." });
    expect((await anonymous().reviews.page({ scope: "product", slug: slugs.fixed })).items[0].vendorReply).toBe("Merci Sarra pour votre confiance !");
  });

  it("ancien avis (procédure reviews.submit du site React) : la ligne n'est plus évaluable", async () => {
    const orderId = await order(clients.sarra, [{ productSlug: slugs.other }]);
    await (await caller(vendors.b.token)).vendor.updateOrderStatus({ orderId, status: "delivered" });
    lines.other = (await lineOf(clients.sarra, slugs.other))!.orderItemId;
    const sarra = await caller(clients.sarra);
    await sarra.reviews.submit({ productSlug: slugs.other, rating: 4, body: "Joli vase, avis envoyé depuis le site React." });
    expect(await lineOf(clients.sarra, slugs.other)).toBeUndefined();
    await expect(sarra.reviews.submitForLine({ orderItemId: lines.other, rating: 4, qualityRating: 4, conformityRating: 4, deliveryRating: 4, body: "Deuxième avis sur le même vase.", photoIds: [], anonymous: false }))
      .rejects.toThrow("déjà donné votre avis");
  });

  it("photo jamais rattachée à un avis : supprimée après 24 h (ligne et fichier)", async () => {
    const res = await upload(clients.karim, PNG);
    const { id } = (await res.json()) as { id: number };
    const db = (await getDb())!;
    const [row] = await db.select().from(reviewPhotos).where(eq(reviewPhotos.id, id));
    const file = resolveStoragePath(row.storageKey)!;
    expect(fs.existsSync(file)).toBe(true);
    await cleanupPendingReviewPhotos();
    expect((await db.select().from(reviewPhotos).where(eq(reviewPhotos.id, id))).length).toBe(1);
    await db.update(reviewPhotos).set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }).where(eq(reviewPhotos.id, id));
    expect(await cleanupPendingReviewPhotos()).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(reviewPhotos).where(eq(reviewPhotos.id, id))).length).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });
});
