import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { appRouter } from "./routers";
import { ensureDatabaseConnection } from "./dbConnection";
import { createOrUpdateAdminUser, getDb, updateShopStatus } from "./db";
import { createMediaRecord } from "./vendorCatalog";
import { sdk } from "./_core/sdk";
import { COOKIE_NAME } from "../shared/const";
import { addresses, commissions, media, orderItems, orderStatusHistory, orders, productOptions, products, shops, users } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

/**
 * Prix selon les dimensions, de bout en bout sur la vraie base MySQL :
 * devis du panier, commande (prix du navigateur ignoré), instantané figé, produits à prix fixe inchangés.
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

const baseProduct = (name: string, mediaId: number) => ({
  name, description: "Création réalisée sur mesure dans notre atelier, finitions soignées.", priceTnd: 1, promoPriceTnd: null,
  availability: "made_to_order" as const, stock: null, sku: "", variants: { dimensions: [], colors: [], materials: [], models: [] },
  delivery: "", preparationTime: "", extraInfo: "", images: [{ mediaId, isPrimary: true }], videoMediaId: null, videoUrl: null, action: "publish" as const,
});

describe("Prix sur mesure (MySQL réel)", () => {
  let vendorToken = "";
  let vendorUserId = 0;
  let shopId = 0;
  let clientToken = "";
  let adminToken = "";
  const slugs: Record<string, string> = {};
  let cadreId = 0;
  let poseId = 0;
  let orderId = 0;

  const shipping = { shippingName: "Client Test", shippingPhone: "+216 20 123 456", shippingAddress: "Rue du Lac 12", shippingCity: "Tunis" };
  const line = (slug: string, extra: Record<string, unknown> = {}) => ({ productSlug: slug, productName: "x", shopSlug: "x", shopName: "x", quantity: 1, unitPriceTnd: 1, ...extra });
  const mediaFor = async () => (await createMediaRecord({ ownerUserId: vendorUserId, shopId, kind: "image", storageKey: `${nanoid(24).toLowerCase().replace(/[^a-z0-9]/g, "a").slice(0, 24)}.png`, mimeType: "image/png", sizeBytes: 100 })).id;

  const cleanup = async () => {
    const db = await getDb();
    if (!db) return;
    const userIds = (await db.select({ id: users.id }).from(users).where(like(users.email, `%_${suffix}@elegancedeco.test`))).map((u) => u.id);
    if (!userIds.length) return;
    const orderIds = (await db.select({ id: orders.id }).from(orders).where(inArray(orders.userId, userIds))).map((o) => o.id);
    if (orderIds.length) {
      await db.delete(orderStatusHistory).where(inArray(orderStatusHistory.orderId, orderIds));
      await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
      await db.delete(commissions).where(inArray(commissions.orderId, orderIds));
      await db.delete(orders).where(inArray(orders.id, orderIds));
    }
    const shopIds = (await db.select({ id: shops.id }).from(shops).where(inArray(shops.userId, userIds))).map((s) => s.id);
    await db.delete(media).where(inArray(media.ownerUserId, userIds));
    if (shopIds.length) {
      const productIds = (await db.select({ id: products.id }).from(products).where(inArray(products.shopId, shopIds))).map((p) => p.id);
      if (productIds.length) await db.delete(productOptions).where(inArray(productOptions.productId, productIds));
      await db.delete(products).where(inArray(products.shopId, shopIds));
      await db.delete(shops).where(inArray(shops.id, shopIds));
    }
    await db.delete(addresses).where(inArray(addresses.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  };

  beforeAll(async () => {
    await ensureDatabaseConnection();
    const v = makeContext();
    const reg = await appRouter.createCaller(v.ctx).auth.registerVendor({
      firstName: "Test", lastName: "Mesure", email: `vendeur_${suffix}@elegancedeco.test`, phone: "+216 50 111 222", city: "Tunis",
      shopName: `Atelier Mesure ${suffix}`, whatsapp: "+216 50 111 222", password, passwordConfirm: password, acceptTerms: true,
    });
    vendorToken = v.cookies[COOKIE_NAME];
    vendorUserId = reg.user.id;
    shopId = reg.shop.id;
    await updateShopStatus(shopId, "active");
    const c = makeContext();
    await appRouter.createCaller(c.ctx).auth.registerCustomer({
      firstName: "Client", lastName: "Mesure", email: `client_${suffix}@elegancedeco.test`, phone: "+216 20 123 456",
      city: "Tunis", address: "Rue du Lac 12", password, passwordConfirm: password,
    });
    clientToken = c.cookies[COOKIE_NAME];
    await createOrUpdateAdminUser({ email: `admin_${suffix}@elegancedeco.test`, password, name: "Admin Test" });
    const a = makeContext();
    await appRouter.createCaller(a.ctx).auth.login({ email: `admin_${suffix}@elegancedeco.test`, password });
    adminToken = a.cookies[COOKIE_NAME];
  });

  afterAll(async () => { await cleanup(); });

  it("le vendeur crée des produits au m², au mètre linéaire et à prix fixe ; validation stricte", async () => {
    const vendor = await caller(vendorToken);
    // Sur mesure sans prix unitaire / avec min > max : refusé
    await expect(vendor.vendor.saveProduct({ ...baseProduct(`Tableau ${suffix}`, await mediaFor()), pricingMode: "per_m2", minWidthCm: 20, maxWidthCm: 300, minHeightCm: 20, maxHeightCm: 300 })).rejects.toThrow("prix unitaire");
    await expect(vendor.vendor.saveProduct({ ...baseProduct(`Tableau ${suffix}`, await mediaFor()), pricingMode: "per_m2", unitPriceTnd: 120, minWidthCm: 300, maxWidthCm: 20, minHeightCm: 20, maxHeightCm: 300 })).rejects.toThrow("maximum");

    const m2 = await vendor.vendor.saveProduct({
      ...baseProduct(`Toile sur mesure ${suffix}`, await mediaFor()), pricingMode: "per_m2", unitPriceTnd: 120,
      minWidthCm: 20, maxWidthCm: 300, minHeightCm: 20, maxHeightCm: 300, minBillableArea: 0.5,
      options: [{ name: "Cadre doré", surchargeType: "per_m2", amountTnd: 30 }, { name: "Pose murale", surchargeType: "fixed", amountTnd: 25.5 }],
    });
    slugs.m2 = m2.slug!;
    const detail = await vendor.vendor.product({ productId: m2.id! });
    expect(detail).toMatchObject({ pricingMode: "per_m2", unitPriceTnd: 120, priceTnd: 120, minBillableArea: 0.5 });
    cadreId = detail.options.find((o) => o.name === "Cadre doré")!.id;
    poseId = detail.options.find((o) => o.name === "Pose murale")!.id;

    slugs.linear = (await vendor.vendor.saveProduct({ ...baseProduct(`Frise LED ${suffix}`, await mediaFor()), pricingMode: "per_linear_m", unitPriceTnd: 45, minWidthCm: 50, maxWidthCm: 600, minBillableArea: 1 })).slug!;
    slugs.promo = (await vendor.vendor.saveProduct({ ...baseProduct(`Miroir promo ${suffix}`, await mediaFor()), pricingMode: "per_m2", unitPriceTnd: 120, minWidthCm: 20, maxWidthCm: 300, minHeightCm: 20, maxHeightCm: 300, promoPercent: 10 })).slug!;
    slugs.min = (await vendor.vendor.saveProduct({ ...baseProduct(`Plaque min ${suffix}`, await mediaFor()), pricingMode: "per_m2", unitPriceTnd: 120, minWidthCm: 10, maxWidthCm: 300, minHeightCm: 10, maxHeightCm: 300, minPriceTnd: 90 })).slug!;
    slugs.fixed = (await vendor.vendor.saveProduct({ ...baseProduct(`Vase fixe ${suffix}`, await mediaFor()), priceTnd: 50, promoPriceTnd: 40 })).slug!;

    // Fiche publique : configuration + options (sans rien d'autre que le nécessaire)
    const page = await anonymous().vendor.publicProduct({ productSlug: slugs.m2 });
    expect(page?.product).toMatchObject({ pricingMode: "per_m2", minWidthCm: 20, maxHeightCm: 300 });
    expect(page?.product.options.map((o) => o.name)).toEqual(["Cadre doré", "Pose murale"]);
  });

  it("devis du panier : calcul serveur (m², minimum, options, prix minimum, remise, linéaire)", async () => {
    const quote = await anonymous().catalog.quoteCart({ lines: [
      { productSlug: slugs.m2, quantity: 1, widthCm: 80, heightCm: 150 },
      { productSlug: slugs.m2, quantity: 1, widthCm: 30, heightCm: 30 },
      { productSlug: slugs.m2, quantity: 1, widthCm: 80, heightCm: 150, optionIds: [cadreId, poseId] },
      { productSlug: slugs.min, quantity: 1, widthCm: 40, heightCm: 50 },
      { productSlug: slugs.promo, quantity: 1, widthCm: 80, heightCm: 150 },
      { productSlug: slugs.linear, quantity: 2, widthCm: 250 },
      { productSlug: slugs.fixed, quantity: 1 },
    ] });
    expect(quote.lines.map((l) => l.unitPriceTnd)).toEqual([144, 60, 205.5, 90, 129.6, 112.5, 40]);
    expect(quote.lines[1].custom).toMatchObject({ areaM2: 0.09, billedAreaM2: 0.5 });
    expect(quote.lines[4].regularPriceTnd).toBe(144);
    expect(quote.subtotalTnd).toBe(144 + 60 + 205.5 + 90 + 129.6 + 225 + 40);
    expect(quote.lines[6].custom).toBeNull();
  });

  it("mesures hors limites, négatives, nulles ou non numériques refusées par le serveur", async () => {
    const quote = await anonymous().catalog.quoteCart({ lines: [
      { productSlug: slugs.m2, quantity: 1, widthCm: 10, heightCm: 100 },
      { productSlug: slugs.m2, quantity: 1, widthCm: 80, heightCm: 400 },
      { productSlug: slugs.m2, quantity: 1, widthCm: -80, heightCm: 100 },
      { productSlug: slugs.m2, quantity: 1, widthCm: 0, heightCm: 100 },
      { productSlug: slugs.m2, quantity: 1, widthCm: "abc", heightCm: 100 },
      { productSlug: slugs.m2, quantity: 1 },
    ] });
    expect(quote.lines.every((l) => !l.available)).toBe(true);
    expect(quote.lines.map((l) => l.problem)).toEqual([
      "La largeur doit être comprise entre 20 et 300 cm.",
      "La hauteur doit être comprise entre 20 et 300 cm.",
      "La largeur doit être supérieure à 0 cm.",
      "La largeur doit être supérieure à 0 cm.",
      "La largeur doit être un nombre.",
      "Indiquez la largeur en centimètres.",
    ]);
    expect(quote.subtotalTnd).toBe(0);
    const client = await caller(clientToken);
    await expect(client.checkout.createOrder({ ...shipping, items: [line(slugs.m2, { widthCm: 500, heightCm: 100 })] })).rejects.toThrow("La largeur doit être comprise entre 20 et 300 cm.");
    await expect(client.checkout.createOrder({ ...shipping, items: [line(slugs.m2)] })).rejects.toThrow("Indiquez la largeur");
    // Option d'un autre produit : refusée
    await expect(client.checkout.createOrder({ ...shipping, items: [line(slugs.promo, { widthCm: 80, heightCm: 150, optionIds: [cadreId] })] })).rejects.toThrow("Option invalide");
  });

  it("commande : prix envoyé par le client ignoré et recalculé ; mesures différentes = lignes séparées ; instantané figé", async () => {
    const client = await caller(clientToken);
    const created = await client.checkout.createOrder({
      ...shipping,
      totalTnd: 1,
      items: [
        line(slugs.m2, { widthCm: 80, heightCm: 150, optionIds: [cadreId], unitPriceTnd: 0.01 }),
        line(slugs.m2, { widthCm: 30, heightCm: 30, unitPriceTnd: 0.01, quantity: 2 }),
        line(slugs.fixed, { unitPriceTnd: 0.01, widthCm: 80, heightCm: 80 }),
      ],
    });
    orderId = created.orderId!;
    // 1,2 × (120 + 30) = 180 ; 2 × 60 = 120 ; prix fixe promo 40
    expect(created.totalTnd).toBe(340);
    const rows = await (await getDb())!.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ unitPriceTnd: "180.00", pricingMode: "per_m2", widthCm: 80, heightCm: 150, areaM2: "1.2000", billedAreaM2: "1.2000", appliedUnitPriceTnd: "120.000", lineTotalTnd: "180.00" });
    expect(JSON.parse(rows[0].optionsJson!)).toEqual([{ name: "Cadre doré", surchargeType: "per_m2", amountTnd: 30 }]);
    expect(rows[1]).toMatchObject({ unitPriceTnd: "60.00", quantity: 2, areaM2: "0.0900", billedAreaM2: "0.5000", lineTotalTnd: "120.00" });
    // Produit à prix fixe : comportement historique, mesures ignorées
    expect(rows[2]).toMatchObject({ unitPriceTnd: "40.00", pricingMode: null, widthCm: null, heightCm: null, optionsJson: null, lineTotalTnd: "40.00" });
  });

  it("changement des prix du vendeur après la commande : l'ancienne commande est inchangée", async () => {
    const vendor = await caller(vendorToken);
    const product = (await (await getDb())!.select({ id: products.id }).from(products).where(eq(products.slug, slugs.m2)))[0];
    const current = await vendor.vendor.product({ productId: product.id });
    await vendor.vendor.saveProduct({
      ...baseProduct(current.name, current.images[0].id), productId: product.id, pricingMode: "per_m2", unitPriceTnd: 200,
      minWidthCm: 20, maxWidthCm: 300, minHeightCm: 20, maxHeightCm: 300, minBillableArea: 1,
      options: [{ name: "Cadre argent", surchargeType: "fixed", amountTnd: 99 }],
    });
    expect((await anonymous().catalog.quoteCart({ lines: [{ productSlug: slugs.m2, quantity: 1, widthCm: 80, heightCm: 150 }] })).lines[0].unitPriceTnd).toBe(240);
    const detail = await (await caller(clientToken)).account.order({ orderId });
    expect(detail?.totalTnd).toBe("340.00");
    expect(detail?.items[0]).toMatchObject({ unitPriceTnd: "180.00", appliedUnitPriceTnd: "120.000", customSummary: "80 × 150 cm · 1,2 m² · Cadre doré" });
    expect(detail?.items[0].options).toEqual([{ name: "Cadre doré", surchargeType: "per_m2", amountTnd: 30 }]);
    expect(detail?.items[1].customSummary).toBe("30 × 30 cm · 0,09 m²");
    expect(detail?.items[2].customSummary).toBeNull();
  });

  it("le vendeur et l'administration voient les mesures pour fabriquer le produit", async () => {
    const dashboard = await (await caller(vendorToken)).vendor.dashboard();
    const summaries = dashboard.orders.filter((o) => o.orderId === orderId).map((o) => o.customSummary);
    expect(summaries).toContain("80 × 150 cm · 1,2 m² · Cadre doré");
    const adminDetail = await (await caller(adminToken)).admin.order({ orderId });
    expect(adminDetail.items.map((i) => i.customSummary)).toEqual(["80 × 150 cm · 1,2 m² · Cadre doré", "30 × 30 cm · 0,09 m²", null]);
    expect(adminDetail.items[1].lineTotalTnd).toBe(120);
  });
});
