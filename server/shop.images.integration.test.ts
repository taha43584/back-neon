import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { eq, inArray, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { appRouter } from "./routers";
import { ensureDatabaseConnection } from "./dbConnection";
import { getDb, updateShopStatus } from "./db";
import { registerMediaRoutes } from "./mediaRoutes";
import { resolveStoragePath, UPLOAD_ROOT } from "./mediaStorage";
import { readImageDimensions, storageKeyFromUrl } from "./shopImages";
import { sdk } from "./_core/sdk";
import { COOKIE_NAME } from "../shared/const";
import { normalizeFacebookUrl, normalizeInstagramUrl } from "../shared/shopValidation";
import { addresses, shops, users } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

/**
 * Logo, couverture et réseaux sociaux des boutiques, de bout en bout :
 * vrai serveur HTTP (Express), vrai disque, vraie base MySQL.
 * Comptes de test en @elegancedeco.test et fichiers de test supprimés à la fin.
 */

const suffix = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, "x");
const password = "MotDePasse2026";

/** PNG réel (couleur unie) généré sans bibliothèque. */
function png(width: number, height: number, rgb: [number, number, number] = [200, 160, 120]) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 bits, RVB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => rgb[i % 3])]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** En-tête WEBP étendu (VP8X) aux dimensions voulues. */
function webpVp8x(width: number, height: number) {
  const b = Buffer.alloc(64);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(56, 4); b.write("WEBP", 8, "ascii"); b.write("VP8X", 12, "ascii");
  b.writeUInt32LE(10, 16); b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3);
  return b;
}

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
    firstName: "Test", lastName: label, email: `${label}_${suffix}@elegancedeco.test`, phone: "+216 50 111 222", city: "Sousse",
    shopName: `Atelier ${label} ${suffix}`, whatsapp: "+216 50 111 222", password, passwordConfirm: password, acceptTerms: true,
  });
  return { token: cookies[COOKIE_NAME], shopId: res.shop.id, slug: res.shop.slug };
}

async function startServer() {
  const app = express();
  registerMediaRoutes(app);
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const address = server.address();
  return { server, base: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}` };
}

describe("Images et réseaux sociaux des boutiques (HTTP + disque + MySQL réels)", () => {
  let srv: { server: Server; base: string };
  type Vendor = Awaited<ReturnType<typeof registerVendor>>;
  let vendorA: Vendor;
  let vendorB: Vendor;
  let pendingVendor: Vendor;
  let clientToken = "";
  const createdKeys = new Set<string>();

  const shopRow = async (id: number) => (await (await getDb())!.select().from(shops).where(eq(shops.id, id)))[0];
  const upload = async (token: string | null, slot: string, body: Buffer, contentType = "image/png", query = "") => {
    const res = await fetch(`${srv.base}/api/vendor/shop/${slot}${query}`, {
      method: "POST",
      headers: { "Content-Type": contentType, ...(token ? { cookie: `${COOKIE_NAME}=${token}` } : {}) },
      body,
    });
    const json = await res.json().catch(() => ({})) as { url?: string; error?: string; width?: number; height?: number };
    const key = storageKeyFromUrl(json.url);
    if (key) createdKeys.add(key);
    return { status: res.status, ...json };
  };
  const get = (url: string, token?: string) => fetch(`${srv.base}${url}`, { headers: token ? { cookie: `${COOKIE_NAME}=${token}` } : {} });
  const fileOf = (url: string | null | undefined) => resolveStoragePath(storageKeyFromUrl(url) ?? "")!;

  const cleanup = async () => {
    const db = await getDb();
    if (!db) return;
    const userIds = (await db.select({ id: users.id }).from(users).where(like(users.email, `%_${suffix}@elegancedeco.test`))).map((u) => u.id);
    if (userIds.length) {
      const testShops = await db.select().from(shops).where(inArray(shops.userId, userIds));
      for (const s of testShops) for (const url of [s.logoUrl, s.coverUrl]) { const key = storageKeyFromUrl(url); if (key) createdKeys.add(key); }
      if (testShops.length) await db.delete(shops).where(inArray(shops.id, testShops.map((s) => s.id)));
      await db.delete(addresses).where(inArray(addresses.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    for (const key of createdKeys) fs.rmSync(resolveStoragePath(key)!, { force: true });
  };

  beforeAll(async () => {
    await ensureDatabaseConnection();
    srv = await startServer();
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
  });

  afterAll(async () => {
    await cleanup();
    await new Promise((resolve) => srv?.server.close(resolve));
    // Aucun fichier de test ne reste sur le disque
    for (const key of createdKeys) expect(fs.existsSync(resolveStoragePath(key)!)).toBe(false);
  });

  it("lit les dimensions réelles dans l'en-tête PNG, JPEG et WEBP", () => {
    expect(readImageDimensions(png(400, 400))).toEqual({ width: 400, height: 400 });
    expect(readImageDimensions(webpVp8x(1600, 500))).toEqual({ width: 1600, height: 500 });
    const vp8l = Buffer.alloc(32); vp8l.write("RIFF", 0, "ascii"); vp8l.write("WEBP", 8, "ascii"); vp8l.write("VP8L", 12, "ascii"); vp8l[20] = 0x2f; vp8l.writeUInt32LE((400 - 1) | ((400 - 1) << 14), 21);
    expect(readImageDimensions(vp8l)).toEqual({ width: 400, height: 400 });
    const vp8 = Buffer.alloc(32); vp8.write("RIFF", 0, "ascii"); vp8.write("WEBP", 8, "ascii"); vp8.write("VP8 ", 12, "ascii"); vp8.set([0x9d, 0x01, 0x2a], 23); vp8.writeUInt16LE(1600, 26); vp8.writeUInt16LE(500, 28);
    expect(readImageDimensions(vp8)).toEqual({ width: 1600, height: 500 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xf4, 0x06, 0x40, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(readImageDimensions(jpeg)).toEqual({ width: 1600, height: 500 });
    expect(readImageDimensions(Buffer.from("%PDF-1.7 pas une image"))).toBeNull();
  });

  it("refuse les visiteurs, les clients et un emplacement inconnu", async () => {
    expect((await upload(null, "logo", png(400, 400))).status).toBe(401);
    expect((await upload(clientToken, "logo", png(400, 400))).status).toBe(403);
    expect((await upload(vendorA.token, "banniere", png(400, 400))).status).toBe(404);
  });

  it("refuse un PDF renommé en .jpg, un fichier de plus de 5 Mo et des dimensions incorrectes", async () => {
    const pdf = await upload(vendorA.token, "logo", Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF"), "image/jpeg", "?name=logo.jpg");
    expect(pdf.status).toBe(415);
    expect(pdf.error).toContain("Format non autorisé");
    const big = await upload(vendorA.token, "logo", Buffer.concat([png(400, 400), Buffer.alloc(5 * 1024 * 1024 + 1)]));
    expect(big.status).toBe(413);
    expect(big.error).toContain("5 Mo");
    const wrong = await upload(vendorA.token, "logo", png(500, 500));
    expect(wrong.status).toBe(422);
    expect(wrong.error).toContain("400 × 400");
    const wrongCover = await upload(vendorA.token, "cover", png(400, 400));
    expect(wrongCover.status).toBe(422);
    expect((await shopRow(vendorA.shopId)).logoUrl).toBeNull();
    // Aucun fichier refusé ne reste dans le stockage
    expect(fs.readdirSync(UPLOAD_ROOT).filter((f) => !f.startsWith(".")).every((f) => !createdKeys.has(f))).toBe(true);
  });

  let logoA1 = "";
  it("enregistre le logo (400×400) et la couverture (1600×500) avec un nom aléatoire, servis publiquement", async () => {
    const logo = await upload(vendorA.token, "logo", png(400, 400), "image/png", "?name=mon-logo-perso.png");
    expect(logo.status).toBe(201);
    expect(logo).toMatchObject({ width: 400, height: 400 });
    expect(logo.url).toMatch(/^\/media\/[a-z0-9]{24}\.png$/);
    expect(logo.url).not.toContain("mon-logo");
    logoA1 = logo.url!;
    const cover = await upload(vendorA.token, "cover", webpVp8x(1600, 500), "image/webp");
    expect(cover.status).toBe(201);
    expect(cover.url).toMatch(/\.webp$/);
    const row = await shopRow(vendorA.shopId);
    expect(row).toMatchObject({ logoUrl: logoA1, coverUrl: cover.url });
    expect(fs.existsSync(fileOf(logoA1))).toBe(true);
    const served = await get(logoA1);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).equals(png(400, 400))).toBe(true);
    // Affiché sur la page publique de la boutique et sur la fiche produit (données publiques)
    expect((await anonymous().vendor.publicShop({ shopSlug: vendorA.slug }))?.shop).toMatchObject({ logoUrl: logoA1, coverUrl: cover.url });
  });

  it("remplacement : nouveau nom de fichier, l'ancien est supprimé du disque et n'est plus servi", async () => {
    const replaced = await upload(vendorA.token, "logo", png(400, 400, [40, 90, 160]));
    expect(replaced.status).toBe(201);
    expect(replaced.url).not.toBe(logoA1);
    expect(fs.existsSync(fileOf(logoA1))).toBe(false);
    expect((await get(logoA1)).status).toBe(404);
    expect((await get(replaced.url!)).status).toBe(200);
    expect((await shopRow(vendorA.shopId)).logoUrl).toBe(replaced.url);
    logoA1 = replaced.url!;
  });

  it("le vendeur B ne peut pas modifier le logo, la couverture ni les liens du vendeur A", async () => {
    const before = await shopRow(vendorA.shopId);
    // Même en indiquant l'identifiant de A dans la requête, seule la boutique de B (session) est modifiée
    const b = await upload(vendorB.token, "logo", png(400, 400, [10, 10, 10]), "image/png", `?shopId=${vendorA.shopId}`);
    expect(b.status).toBe(201);
    expect((await shopRow(vendorB.shopId)).logoUrl).toBe(b.url);
    const callerB = await caller(vendorB.token);
    await callerB.vendor.shop.removeLogo();
    await callerB.vendor.shop.removeCover();
    await callerB.vendor.shop.updateSocialLinks({ facebook: "https://www.facebook.com/pirate", instagram: "@pirate" });
    // updateShop n'accepte plus de logo / couverture en URL libre
    await callerB.vendor.updateShop({ logoUrl: before.logoUrl, coverUrl: "https://site-pirate.com/x.png" } as never);
    const after = await shopRow(vendorA.shopId);
    expect(after).toMatchObject({ logoUrl: before.logoUrl, coverUrl: before.coverUrl, socialFacebook: before.socialFacebook, socialInstagram: before.socialInstagram });
    expect(fs.existsSync(fileOf(before.logoUrl))).toBe(true);
    const rowB = await shopRow(vendorB.shopId);
    expect(rowB).toMatchObject({ logoUrl: null, coverUrl: null, socialFacebook: "https://www.facebook.com/pirate", socialInstagram: "https://www.instagram.com/pirate" });
    expect(fs.existsSync(fileOf(b.url))).toBe(false);
  });

  it("boutique en attente : envoi autorisé, image privée jusqu'à l'approbation ; boutique suspendue : refusée", async () => {
    const pending = await upload(pendingVendor.token, "cover", png(1600, 500));
    expect(pending.status).toBe(201);
    expect((await get(pending.url!)).status).toBe(404);
    expect((await get(pending.url!, clientToken)).status).toBe(404);
    expect((await get(pending.url!, pendingVendor.token)).status).toBe(200);
    expect(await anonymous().vendor.publicShop({ shopSlug: pendingVendor.slug })).toBeUndefined();
    await updateShopStatus(pendingVendor.shopId, "active");
    expect((await get(pending.url!)).status).toBe(200);
    await updateShopStatus(pendingVendor.shopId, "suspended");
    expect((await upload(pendingVendor.token, "logo", png(400, 400))).status).toBe(403);
    await expect((await caller(pendingVendor.token)).vendor.shop.removeCover()).rejects.toThrow();
  });

  it("suppression : retour à l'image par défaut, fichier effacé", async () => {
    const callerA = await caller(vendorA.token);
    const cover = (await shopRow(vendorA.shopId)).coverUrl!;
    await callerA.vendor.shop.removeCover();
    expect((await shopRow(vendorA.shopId)).coverUrl).toBeNull();
    expect(fs.existsSync(fileOf(cover))).toBe(false);
    expect((await get(cover)).status).toBe(404);
  });

  it("persistance : l'image est toujours servie après redémarrage du serveur", async () => {
    const bytes = Buffer.from(await (await get(logoA1)).arrayBuffer());
    await new Promise((resolve) => srv.server.close(resolve));
    srv = await startServer();
    const again = await get(logoA1);
    expect(again.status).toBe(200);
    expect(Buffer.from(await again.arrayBuffer()).equals(bytes)).toBe(true);
    // Stockée sur disque dans le dossier persistant, hors dossier temporaire et hors build
    expect(path.dirname(fileOf(logoA1))).toBe(UPLOAD_ROOT);
    expect(UPLOAD_ROOT).not.toContain(`${path.sep}dist`);
  });

  it("liens sociaux : normalisation et refus stricts", async () => {
    expect(normalizeInstagramUrl("@elegancedeco")).toEqual({ ok: true, value: "https://www.instagram.com/elegancedeco" });
    expect(normalizeFacebookUrl("facebook.com/maboutique")).toEqual({ ok: true, value: "https://facebook.com/maboutique" });
    expect(normalizeFacebookUrl("http://m.facebook.com/maboutique")).toEqual({ ok: true, value: "https://m.facebook.com/maboutique" });
    expect(normalizeFacebookUrl("https://fb.com/maboutique").ok).toBe(true);
    expect(normalizeInstagramUrl("www.instagram.com/elegance.deco").ok).toBe(true);
    for (const bad of ["https://site-pirate.com", "https://www.facebook.com.site-pirate.com/x", "javascript:alert(1)", "https://facebook.com", "https://user@facebook.com/x", "https://facebook.com:8080/x", `https://facebook.com/${"a".repeat(200)}`]) {
      expect(normalizeFacebookUrl(bad).ok, bad).toBe(false);
    }
    for (const bad of ["https://site-pirate.com/elegancedeco", "@nom invalide", "data:text/html,x", "https://instagram.com.evil.net/x"]) {
      expect(normalizeInstagramUrl(bad).ok, bad).toBe(false);
    }
    expect(normalizeFacebookUrl("   ")).toEqual({ ok: true, value: null });
  });

  it("liens sociaux via l'API : domaine pirate refusé, @nom converti, vide = supprimé", async () => {
    const a = await caller(vendorA.token);
    await expect(a.vendor.shop.updateSocialLinks({ facebook: "https://site-pirate.com" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(a.vendor.shop.updateSocialLinks({ instagram: "javascript:alert(1)" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const saved = await a.vendor.shop.updateSocialLinks({ facebook: "facebook.com/elegancedeco", instagram: "@elegancedeco" });
    expect(saved).toEqual({ facebook: "https://facebook.com/elegancedeco", instagram: "https://www.instagram.com/elegancedeco" });
    expect(await shopRow(vendorA.shopId)).toMatchObject({ socialFacebook: "https://facebook.com/elegancedeco", socialInstagram: "https://www.instagram.com/elegancedeco" });
    // Les formulaires de boutique appliquent la même validation (pas de contournement)
    await expect(a.vendor.updateShop({ socialFacebook: "https://site-pirate.com/x" })).rejects.toThrow("Facebook");
    await a.vendor.shop.updateSocialLinks({ facebook: "", instagram: "@elegancedeco" });
    expect((await shopRow(vendorA.shopId)).socialFacebook).toBeNull();
  });
});
