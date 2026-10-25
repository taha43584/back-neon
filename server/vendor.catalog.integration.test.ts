import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import fs from "fs";
import { eq, inArray, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { appRouter } from "./routers";
import { ensureDatabaseConnection } from "./dbConnection";
import { getDb, updateShopStatus } from "./db";
import { registerMediaRoutes } from "./mediaRoutes";
import { resolveStoragePath } from "./mediaStorage";
import { sdk } from "./_core/sdk";
import { COOKIE_NAME } from "../shared/const";
import { addresses, categories, commissions, media, orderItems, orders, products, shops, users } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import type { ProductInput } from "../shared/productValidation";

/**
 * Espace vendeur de bout en bout : envoi réel de fichiers via HTTP (Express + disque),
 * enregistrement / publication / dépublication des produits, catégories, contrôles d'accès,
 * stock et promotion à la commande. Données de test en @elegancedeco.test, supprimées à la fin.
 */

const suffix = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, "x");
const password = "MotDePasse2026";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
// En-tête ISO BMFF minimal (« ftyp isom ») suivi de données : suffisant pour la détection de signature MP4
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "ascii"), Buffer.alloc(2048, 1)]);

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

const publicCaller = () => appRouter.createCaller(makeContext().ctx);

async function registerVendor(label: string) {
  const { ctx, cookies } = makeContext();
  const res = await appRouter.createCaller(ctx).auth.registerVendor({
    firstName: "Test", lastName: label, email: `${label}_${suffix}@elegancedeco.test`, phone: "+216 50 111 222", city: "Tunis",
    shopName: `Boutique ${label} ${suffix}`, whatsapp: "+216 50 111 222", password, passwordConfirm: password, acceptTerms: true,
  });
  return { token: cookies[COOKIE_NAME], shopId: res.shop.id };
}

describe("Espace vendeur : médias, produits, catégories (HTTP + MySQL réels)", () => {
  let server: Server;
  let base = "";
  let vendorA = { token: "", shopId: 0 };
  let vendorB = { token: "", shopId: 0 };
  let pendingVendor = { token: "", shopId: 0 };
  let clientToken = "";
  let categoryId = 0;
  let subcategoryId = 0;
  let productId = 0;
  let productSlug = "";
  const uploaded: Record<string, { id: number; url: string }> = {};

  async function upload(token: string | null, kind: "image" | "video", body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}) {
    const res = await fetch(`${base}/api/uploads?kind=${kind}&name=test.${contentType.split("/")[1]}`, {
      method: "POST",
      headers: { "Content-Type": contentType, ...(token ? { cookie: `${COOKIE_NAME}=${token}` } : {}), ...extraHeaders },
      body,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as { id: number; url: string; error?: string } };
  }

  const get = (url: string, token?: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${url}`, { headers: { ...(token ? { cookie: `${COOKIE_NAME}=${token}` } : {}), ...headers } });

  const baseInput = (): ProductInput => ({
    name: `Miroir Soleil ${suffix}`,
    description: "Miroir mural doré façonné à la main, finition laiton brossé, idéal pour une entrée.",
    priceTnd: 320,
    promoPriceTnd: null,
    availability: "in_stock",
    stock: 4,
    sku: `MS-${suffix}`,
    variants: { dimensions: ["60 cm", "80 cm"], colors: ["Or", "Argent"], materials: ["Laiton"], models: [] },
    delivery: "Livraison partout en Tunisie sous 5 jours",
    preparationTime: "48 h",
    extraInfo: "Fixations murales fournies",
    images: [],
    videoMediaId: null,
    videoUrl: null,
    action: "draft",
  });

  const cleanup = async () => {
    const db = await getDb();
    if (!db) return;
    const testUsers = await db.select({ id: users.id }).from(users).where(like(users.email, `%_${suffix}@elegancedeco.test`));
    const userIds = testUsers.map((u) => u.id);
    if (!userIds.length) return;
    const testShops = (await db.select({ id: shops.id }).from(shops).where(inArray(shops.userId, userIds))).map((s) => s.id);
    const files = await db.select({ id: media.id, storageKey: media.storageKey }).from(media).where(inArray(media.ownerUserId, userIds));
    files.forEach((f) => { const p = resolveStoragePath(f.storageKey); if (p) fs.rmSync(p, { force: true }); });
    if (files.length) await db.delete(media).where(inArray(media.id, files.map((f) => f.id)));
    const testOrders = (await db.select({ id: orders.id }).from(orders).where(inArray(orders.userId, userIds))).map((o) => o.id);
    if (testOrders.length) {
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
    const app = express();
    registerMediaRoutes(app);
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    vendorA = await registerVendor("vendeura");
    vendorB = await registerVendor("vendeurb");
    pendingVendor = await registerVendor("vendeurc");
    await updateShopStatus(vendorA.shopId, "active");
    await updateShopStatus(vendorB.shopId, "active");

    const { ctx, cookies } = makeContext();
    await appRouter.createCaller(ctx).auth.registerCustomer({
      firstName: "Client", lastName: "Test", email: `client_${suffix}@elegancedeco.test`, phone: "+216 20 123 456",
      city: "Tunis", address: "Rue du Lac 12", password, passwordConfirm: password,
    });
    clientToken = cookies[COOKIE_NAME];

    const tree = await publicCaller().catalog.categories();
    const mirrors = tree.find((c) => c.slug === "miroirs")!;
    categoryId = mirrors.id;
    subcategoryId = mirrors.children.find((c) => c.slug === "miroirs-decoratifs")!.id;
  });

  afterAll(async () => {
    await cleanup();
    await new Promise((resolve) => server?.close(resolve));
  });

  it("refuse l'envoi aux visiteurs, clients et vendeurs non approuvés", async () => {
    expect((await upload(null, "image", PNG, "image/png")).status).toBe(401);
    expect((await upload(clientToken, "image", PNG, "image/png")).status).toBe(403);
    expect((await upload(pendingVendor.token, "image", PNG, "image/png")).status).toBe(403);
  });

  it("vérifie le type réel et la taille des fichiers côté serveur", async () => {
    const fake = await upload(vendorA.token, "image", Buffer.from("<script>alert(1)</script> pas une image"), "image/png");
    expect(fake.status).toBe(415);
    const videoAsImage = await upload(vendorA.token, "image", MP4, "image/jpeg");
    expect(videoAsImage.status).toBe(415);
    const tooBig = await upload(vendorA.token, "image", Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024 + 10)]), "image/png");
    expect(tooBig.status).toBe(413);
  });

  it("enregistre réellement les photos sur disque ; un fichier non publié reste privé", async () => {
    for (const [name, data, type] of [["p1", PNG, "image/png"], ["p2", WEBP, "image/webp"], ["p3", PNG, "image/png"]] as const) {
      const res = await upload(vendorA.token, "image", data, type);
      expect(res.status).toBe(201);
      uploaded[name] = res.body;
      const key = res.body.url.replace("/media/", "");
      expect(fs.existsSync(resolveStoragePath(key)!)).toBe(true);
    }
    expect((await get(uploaded.p1.url)).status).toBe(404);
    const owner = await get(uploaded.p1.url, vendorA.token);
    expect(owner.status).toBe(200);
    expect(owner.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await owner.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await get(uploaded.p1.url, vendorB.token)).status).toBe(404);
  });

  it("refuse la publication sans photo et accepte un brouillon", async () => {
    const vendor = await caller(vendorA.token);
    await expect(vendor.vendor.saveProduct({ ...baseInput(), action: "publish" })).rejects.toThrow("au moins une photo");
    const draft = await vendor.vendor.saveProduct({
      ...baseInput(),
      images: [{ mediaId: uploaded.p1.id, isPrimary: false }, { mediaId: uploaded.p2.id, isPrimary: true }, { mediaId: uploaded.p3.id, isPrimary: false }],
    });
    expect(draft.status).toBe("draft");
    productId = draft.id!;
    productSlug = draft.slug!;
    const catalog = await publicCaller().catalog.list({ search: suffix });
    expect(catalog.map((p) => p.slug)).not.toContain(productSlug);
    expect(await publicCaller().vendor.publicProduct({ productSlug })).toBeUndefined();
    const detail = await vendor.vendor.product({ productId });
    expect(detail.images.map((i) => i.id)).toEqual([uploaded.p1.id, uploaded.p2.id, uploaded.p3.id]);
    expect(detail.images.find((i) => i.isPrimary)?.id).toBe(uploaded.p2.id);
    expect(detail.imageUrl).toBe(uploaded.p2.url);
  });

  it("publie immédiatement (sans catégorie globale) : visible dans le catalogue et la recherche ; la catégorie parente après attribution", async () => {
    const vendor = await caller(vendorA.token);
    const published = await vendor.vendor.setProductStatus({ productId, status: "published" });
    expect(published.status).toBe("published");
    const bySearch = await publicCaller().catalog.list({ search: `Soleil ${suffix}` });
    const card = bySearch.find((p) => p.slug === productSlug);
    expect(card?.image).toBe(uploaded.p2.url);
    expect(card?.shopName).toBe(`Boutique vendeura ${suffix}`);
    // La catégorie globale est attribuée par l'administration (ici directement en base)
    expect((await publicCaller().catalog.list({ category: "Miroirs" })).map((p) => p.slug)).not.toContain(productSlug);
    const db = (await getDb())!;
    await db.update(products).set({ categoryId: subcategoryId, category: "Miroirs décoratifs" }).where(eq(products.id, productId));
    const byParentCategory = await publicCaller().catalog.list({ category: "Miroirs" });
    expect(byParentCategory.map((p) => p.slug)).toContain(productSlug);
    const page = await publicCaller().vendor.publicProduct({ productSlug });
    expect(page?.product.images[0].url).toBe(uploaded.p2.url);
    expect(page?.product.variants.colors).toEqual(["Or", "Argent"]);
    expect((await get(uploaded.p1.url)).status).toBe(200);
  });

  it("modifie prix, description, remplace une photo et en supprime une autre", async () => {
    const vendor = await caller(vendorA.token);
    const replacement = await upload(vendorA.token, "image", PNG, "image/png");
    expect(replacement.status).toBe(201);
    await vendor.vendor.saveProduct({
      ...baseInput(),
      productId,
      priceTnd: 350,
      promoPriceTnd: 299.9,
      description: "Nouvelle description détaillée du miroir soleil, laiton massif et verre biseauté.",
      images: [{ mediaId: replacement.body.id, isPrimary: true }, { mediaId: uploaded.p2.id, isPrimary: false }],
      action: "publish",
    });
    const page = await publicCaller().vendor.publicProduct({ productSlug });
    expect(page?.product).toMatchObject({ regularPriceTnd: 350, promoPriceTnd: 299.9, effectivePriceTnd: 299.9 });
    expect(page?.product.description).toContain("Nouvelle description");
    expect(page?.product.images.map((i) => i.url)).toEqual([replacement.body.url, uploaded.p2.url]);
    // Fichiers retirés : supprimés du disque et inaccessibles
    for (const old of [uploaded.p1, uploaded.p3]) {
      expect(fs.existsSync(resolveStoragePath(old.url.replace("/media/", ""))!)).toBe(false);
      expect((await get(old.url, vendorA.token)).status).toBe(404);
    }
    uploaded.p1 = replacement.body;
    // Suppression directe d'une photo
    await vendor.vendor.deleteMedia({ mediaId: uploaded.p2.id });
    expect((await vendor.vendor.product({ productId })).images).toHaveLength(1);
    // La dernière photo d'un produit publié ne peut pas être supprimée
    await expect(vendor.vendor.deleteMedia({ mediaId: uploaded.p1.id })).rejects.toThrow("au moins une photo");
  });

  it("vidéo : envoi, affichage public et lecture partielle (Range) ; lien YouTube sécurisé", async () => {
    const vendor = await caller(vendorA.token);
    const video = await upload(vendorA.token, "video", MP4, "video/mp4");
    expect(video.status).toBe(201);
    await vendor.vendor.saveProduct({ ...baseInput(), productId, images: [{ mediaId: uploaded.p1.id, isPrimary: true }], videoMediaId: video.body.id, action: "publish" });
    const page = await publicCaller().vendor.publicProduct({ productSlug });
    expect(page?.product.video).toEqual({ url: video.body.url, mimeType: "video/mp4" });
    const partial = await get(video.body.url, undefined, { Range: "bytes=0-99" });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-type")).toBe("video/mp4");

    await expect(vendor.vendor.saveProduct({ ...baseInput(), productId, images: [{ mediaId: uploaded.p1.id, isPrimary: true }], videoMediaId: video.body.id, videoUrl: "https://evil.example.com/video.mp4", action: "publish" }))
      .rejects.toThrow("YouTube ou Vimeo");
    await vendor.vendor.saveProduct({ ...baseInput(), productId, images: [{ mediaId: uploaded.p1.id, isPrimary: true }], videoMediaId: video.body.id, videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", action: "publish" });
    expect((await publicCaller().vendor.publicProduct({ productSlug }))?.product.videoUrl).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  });

  it("un autre vendeur ne peut ni modifier ni réutiliser les produits et fichiers d'autrui", async () => {
    const other = await caller(vendorB.token);
    await expect(other.vendor.saveProduct({ ...baseInput(), productId, images: [] })).rejects.toThrow("autorisation");
    await expect(other.vendor.setProductStatus({ productId, status: "draft" })).rejects.toThrow("autorisation");
    await expect(other.vendor.removeProduct({ productId })).rejects.toThrow("autorisation");
    await expect(other.vendor.product({ productId })).rejects.toThrow("autorisation");
    await expect(other.vendor.deleteMedia({ mediaId: uploaded.p1.id })).rejects.toThrow("introuvable");
    await expect(other.vendor.saveProduct({ ...baseInput(), images: [{ mediaId: uploaded.p1.id, isPrimary: true }] })).rejects.toThrow("ne vous appartient pas");
  });

  it("un client et un vendeur non approuvé ne peuvent pas créer ni publier de produit", async () => {
    const client = await caller(clientToken);
    await expect(client.vendor.saveProduct({ ...baseInput() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(client.vendor.setProductStatus({ productId, status: "published" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const pending = await caller(pendingVendor.token);
    await expect(pending.vendor.saveProduct({ ...baseInput() })).rejects.toThrow("validée par l'administrateur");
    await expect(pending.vendor.proposeCategory({ name: `Catégorie ${suffix}` })).rejects.toThrow("validée par l'administrateur");
  });

  it("propositions de catégories globales (API historique) : en attente, pas de doublon, suppression", async () => {
    const vendor = await caller(vendorA.token);
    await expect(vendor.vendor.proposeCategory({ name: "Miroirs" })).rejects.toThrow("existe déjà");
    const proposal = await vendor.vendor.proposeCategory({ name: `Luminaires ${suffix}` });
    expect(proposal.status).toBe("pending");
    expect((await publicCaller().catalog.categories()).some((c) => c.id === proposal.id)).toBe(false);
    expect((await vendor.vendor.categories()).find((c) => c.id === proposal.id)?.status).toBe("pending");
    await vendor.vendor.updateCategory({ categoryId: proposal.id, name: `Luminaires design ${suffix}` });
    const removed = await vendor.vendor.deleteCategory({ categoryId: proposal.id });
    expect(removed.reassigned).toBe(0);
    await expect(vendor.vendor.updateCategory({ categoryId, name: "Piratage" })).rejects.toThrow("non modifiable");
  });

  it("dépublication : le produit et ses fichiers ne sont plus publics", async () => {
    const vendor = await caller(vendorA.token);
    await vendor.vendor.setProductStatus({ productId, status: "draft" });
    expect((await publicCaller().catalog.list({ search: suffix })).map((p) => p.slug)).not.toContain(productSlug);
    expect(await publicCaller().vendor.publicProduct({ productSlug })).toBeUndefined();
    expect((await get(uploaded.p1.url)).status).toBe(404);
    expect((await get(uploaded.p1.url, vendorA.token)).status).toBe(200);
    await vendor.vendor.setProductStatus({ productId, status: "published" });
  });

  it("commande : prix promotionnel appliqué, stock décrémenté, rupture bloquée", async () => {
    const client = await caller(clientToken);
    const order = (qty: number) => client.checkout.createOrder({
      shippingName: "Client Test", shippingPhone: "+216 20 123 456", shippingAddress: "Rue du Lac 12", shippingCity: "Tunis",
      items: [{ productSlug, productName: "x", shopSlug: "x", shopName: "x", quantity: qty, unitPriceTnd: 1 }],
    });
    // Prix courant : 320 (promo retirée lors du dernier enregistrement), stock 4
    const vendor = await caller(vendorA.token);
    await vendor.vendor.saveProduct({ ...baseInput(), productId, promoPriceTnd: 280, stock: 3, images: [{ mediaId: uploaded.p1.id, isPrimary: true }], action: "publish" });
    const first = await order(2);
    expect(first.totalTnd).toBe(560);
    await expect(order(2)).rejects.toThrow("Stock insuffisant");
    await order(1);
    const db = (await getDb())!;
    expect((await db.select({ stock: products.stock }).from(products).where(eq(products.id, productId)))[0].stock).toBe(0);
    await expect(order(1)).rejects.toThrow("rupture de stock");
    const card = (await publicCaller().catalog.list({ search: suffix })).find((p) => p.slug === productSlug);
    expect(card?.availability).toBe("out_of_stock");
  });

  it("suppression : produit et fichiers effacés", async () => {
    const vendor = await caller(vendorA.token);
    const files = (await vendor.vendor.product({ productId })).images;
    await vendor.vendor.removeProduct({ productId });
    expect(await publicCaller().vendor.publicProduct({ productSlug })).toBeUndefined();
    for (const file of files) expect(fs.existsSync(resolveStoragePath(file.url.replace("/media/", ""))!)).toBe(false);
  });
});
