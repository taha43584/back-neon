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
import { categorySlug, findSimilarCategories } from "../shared/categoryKey";
import { addresses, hiddenSiteCategories, media, productOptions, products, shopCategories, shops, users } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

/**
 * Catégories PARTAGÉES entre vendeurs (sur la vraie base MySQL) : une catégorie créée par un vendeur est proposée
 * à tous les autres (noms uniquement), anti-doublons, catégories masquées indisponibles, renommage et fusion admin
 * sans suppression de produit. Comptes de test en @elegancedeco.test, supprimés à la fin.
 */

const S = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, "x");
const password = "MotDePasse2026";
const MIROIRS = `Miroirs ${S}`;

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
async function registerVendor(label: string, active = true): Promise<Vendor> {
  const { ctx, cookies } = makeContext();
  const res = await appRouter.createCaller(ctx).auth.registerVendor({
    firstName: "Test", lastName: label, email: `${label}_${S}@elegancedeco.test`, phone: "+216 50 111 222", city: "Tunis",
    shopName: `Atelier ${label} ${S}`, whatsapp: "+216 50 111 222", password, passwordConfirm: password, acceptTerms: true,
  });
  if (active) await updateShopStatus(res.shop.id, "active");
  return { token: cookies[COOKIE_NAME], userId: res.user.id, shopId: res.shop.id };
}

describe("Catégories partagées entre vendeurs (MySQL réel)", () => {
  let A: Vendor;
  let B: Vendor;
  let C: Vendor;
  let P: Vendor;
  let adminToken = "";

  const mediaFor = async (v: Vendor) => (await createMediaRecord({ ownerUserId: v.userId, shopId: v.shopId, kind: "image", storageKey: `${nanoid(24).toLowerCase().replace(/[^a-z0-9]/g, "a").slice(0, 24)}.png`, mimeType: "image/png", sizeBytes: 100 })).id;
  const product = async (v: Vendor, name: string, shopCategoryId: number | null, action: "publish" | "draft" = "publish") => (await (await caller(v.token)).vendor.saveProduct({
    name: `${name} ${S}`, description: "Création artisanale réalisée à la main dans notre atelier.", priceTnd: 100, promoPriceTnd: null,
    availability: "made_to_order", stock: null, sku: "", variants: { dimensions: [], colors: [], materials: [], models: [] },
    delivery: "", preparationTime: "", extraInfo: "", images: [{ mediaId: await mediaFor(v), isPrimary: true }], videoMediaId: null, videoUrl: null,
    action, shopCategoryId,
  })).id!;
  const siteCategory = async (slug: string) => (await anonymous().catalog.siteCategories()).find((c) => c.slug === slug);
  const testProductCount = async () => (await (await getDb())!.select({ id: products.id }).from(products).where(inArray(products.shopId, [A.shopId, B.shopId, C.shopId]))).length;

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
    [A, B, C, P] = [await registerVendor("vendeura"), await registerVendor("vendeurb"), await registerVendor("vendeurc"), await registerVendor("vendeurp", false)];
    await createOrUpdateAdminUser({ email: `admin_${S}@elegancedeco.test`, password, name: "Admin Test" });
    const a = makeContext();
    await appRouter.createCaller(a.ctx).auth.login({ email: `admin_${S}@elegancedeco.test`, password });
    adminToken = a.cookies[COOKIE_NAME];
  });

  afterAll(async () => { await cleanup(); });

  it("A crée « Miroirs » → B la voit, l'ajoute et y met son produit → une seule catégorie avec les produits de A et B", async () => {
    const vendorA = await caller(A.token);
    const vendorB = await caller(B.token);
    const miroirsA = await vendorA.vendor.shopCategories.create({ name: MIROIRS });
    await product(A, "Miroir rond", miroirsA.id);

    const choicesB = await vendorB.vendor.shopCategories.choices();
    const offered = choicesB.others.find((c) => c.slug === categorySlug(MIROIRS));
    expect(offered).toEqual({ slug: categorySlug(MIROIRS), name: MIROIRS });

    const adopted = await vendorB.vendor.shopCategories.adopt({ slug: categorySlug(MIROIRS) });
    expect(adopted).toMatchObject({ name: MIROIRS, created: true });
    // Idempotent : la catégorie est déjà dans la boutique
    expect(await vendorB.vendor.shopCategories.adopt({ slug: categorySlug(MIROIRS) })).toMatchObject({ id: adopted.id, created: false });
    expect((await vendorB.vendor.shopCategories.choices()).others.some((c) => c.slug === categorySlug(MIROIRS))).toBe(false);
    await product(B, "Miroir doré", adopted.id);

    expect(await siteCategory(categorySlug(MIROIRS))).toMatchObject({ name: MIROIRS, productCount: 2, shopCount: 2 });
    // Un 3e vendeur qui tape le nom autrement reçoit le nom officiel (même slug → même catégorie)
    const created = await (await caller(C.token)).vendor.shopCategories.create({ name: `  MIROIRS   ${S.toUpperCase()}` });
    expect(created.name).toBe(MIROIRS);
    await expect(vendorB.vendor.shopCategories.create({ name: `miroirs ${S}` })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("« Miroir » propose « Miroirs » ; le vendeur peut quand même créer la sienne", async () => {
    const choices = await (await caller(C.token)).vendor.shopCategories.choices();
    const all = [...choices.own, ...choices.others];
    expect(findSimilarCategories(`Miroir ${S}`, all).map((c) => c.name)).toContain(MIROIRS);
    const own = await (await caller(C.token)).vendor.shopCategories.create({ name: `Miroir ${S}` });
    expect(own.name).toBe(`Miroir ${S}`);
  });

  it("sécurité : un vendeur ne voit que les NOMS des autres (ni produits non publiés, ni statistiques, ni boutiques non validées)", async () => {
    const draftCategory = await (await caller(A.token)).vendor.shopCategories.create({ name: `Brouillons ${S}` });
    await product(A, "Secret brouillon", draftCategory.id, "draft");
    await (await caller(P.token)).vendor.shopCategories.list().catch(() => null); // boutique en attente : accès refusé
    const db = (await getDb())!;
    await db.insert(shopCategories).values({ shopId: P.shopId, name: `Boutique en attente ${S}`, slug: `boutique-en-attente-${S}`, position: 0 });

    const choices = await (await caller(B.token)).vendor.shopCategories.choices();
    expect(choices.others.every((c) => Object.keys(c).sort().join(",") === "name,slug")).toBe(true);
    expect(choices.others.map((c) => c.name)).toContain(`Brouillons ${S}`);
    expect(choices.others.map((c) => c.name)).not.toContain(`Boutique en attente ${S}`);
    const serialized = JSON.stringify(choices);
    expect(serialized).not.toContain("Secret brouillon");
    expect(serialized).not.toMatch(/productCount|shopCount|shopId|image/);
    // La catégorie sans produit publié n'est toujours pas visible sur le site public
    expect(await siteCategory(categorySlug(`Brouillons ${S}`))).toBeUndefined();
    await expect((await caller(P.token)).vendor.shopCategories.choices()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("catégorie masquée : absente de la liste des vendeurs et impossible à recréer", async () => {
    const admin = await caller(adminToken);
    const lampes = await (await caller(A.token)).vendor.shopCategories.create({ name: `Lampes ${S}` });
    await product(A, "Lampe", lampes.id);
    const slug = categorySlug(`Lampes ${S}`);
    await admin.admin.setSiteCategoryHidden({ slug, hidden: true, reason: "Nom à revoir" });

    const vendorB = await caller(B.token);
    expect((await vendorB.vendor.shopCategories.choices()).others.some((c) => c.slug === slug)).toBe(false);
    await expect(vendorB.vendor.shopCategories.create({ name: `LAMPES ${S}` })).rejects.toThrow("Cette catégorie n'est pas disponible");
    await expect(vendorB.vendor.shopCategories.adopt({ slug })).rejects.toThrow("Cette catégorie n'est pas disponible");
    const own = await (await caller(A.token)).vendor.shopCategories.choices();
    expect(own.own.find((c) => c.slug === slug)).toMatchObject({ hidden: true });
    // Renommer une autre catégorie vers ce nom masqué : refusé aussi
    await expect((await caller(A.token)).vendor.shopCategories.rename({ categoryId: own.own.find((c) => c.slug === categorySlug(MIROIRS))!.id, name: `lampes ${S}` }))
      .rejects.toThrow("Cette catégorie n'est pas disponible");
  });

  it("admin : renomme le nom affiché chez toutes les boutiques ; un nom déjà existant impose la fusion", async () => {
    const admin = await caller(adminToken);
    const decoA = await (await caller(A.token)).vendor.shopCategories.create({ name: `deco murale ${S}` });
    const decoB = await (await caller(B.token)).vendor.shopCategories.adopt({ slug: categorySlug(`deco murale ${S}`) });
    await product(A, "Panneau", decoA.id);
    await product(B, "Applique", decoB.id);

    const renamed = await admin.admin.renameSiteCategory({ slug: categorySlug(`deco murale ${S}`), name: `Déco Murale ${S}` });
    expect(renamed).toMatchObject({ shops: 2, name: `Déco Murale ${S}` });
    const db = (await getDb())!;
    const names = (await db.select({ name: shopCategories.name }).from(shopCategories).where(inArray(shopCategories.id, [decoA.id, decoB.id]))).map((r) => r.name);
    expect(names).toEqual([`Déco Murale ${S}`, `Déco Murale ${S}`]);
    expect(await siteCategory(categorySlug(`deco murale ${S}`))).toMatchObject({ name: `Déco Murale ${S}`, productCount: 2 });
    await expect(admin.admin.renameSiteCategory({ slug: categorySlug(`deco murale ${S}`), name: MIROIRS })).rejects.toThrow("Fusionner");
    await expect((await caller(A.token)).admin.renameSiteCategory({ slug: categorySlug(`deco murale ${S}`), name: "X pirate" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("admin : fusion « Déco murale » → « Décoration murale » : tous les produits passent dans la cible, aucun supprimé", async () => {
    const admin = await caller(adminToken);
    const target = await (await caller(A.token)).vendor.shopCategories.create({ name: `Décoration murale ${S}` });
    await product(A, "Tableau", target.id);
    const before = await testProductCount();
    const sourceSlug = categorySlug(`deco murale ${S}`);
    const targetSlug = categorySlug(`Décoration murale ${S}`);
    expect(await siteCategory(sourceSlug)).toMatchObject({ productCount: 2, shopCount: 2 });

    const result = await admin.admin.mergeSiteCategories({ sourceSlug, targetSlug });
    expect(result).toMatchObject({ shops: 2, movedProducts: 2, targetName: `Décoration murale ${S}` });
    expect(await testProductCount()).toBe(before);
    expect(await siteCategory(sourceSlug)).toBeUndefined();
    expect(await siteCategory(targetSlug)).toMatchObject({ name: `Décoration murale ${S}`, productCount: 3, shopCount: 2 });
    // Chez A : la catégorie source (vidée) a disparu ; chez B : elle a pris le nom de la cible
    const listA = (await (await caller(A.token)).vendor.shopCategories.list()).categories.map((c) => c.name);
    expect(listA).not.toContain(`Déco Murale ${S}`);
    const listB = (await (await caller(B.token)).vendor.shopCategories.list()).categories;
    expect(listB.find((c) => c.name === `Décoration murale ${S}`)).toMatchObject({ productCount: 1 });
    await expect(admin.admin.mergeSiteCategories({ sourceSlug: targetSlug, targetSlug })).rejects.toThrow("différentes");
  });

  it("liste du sélecteur relue : une catégorie créée par B APRÈS le premier chargement de A apparaît au rechargement", async () => {
    const vendorA = await caller(A.token);
    const name = `Céramique berbère ${S}`;
    const before = await vendorA.vendor.shopCategories.choices();
    expect(before.others.some((c) => c.name === name)).toBe(false);
    await (await caller(B.token)).vendor.shopCategories.create({ name });
    // Le sélecteur rappelle cette procédure à chaque ouverture (CategoryCombobox : refetch à l'ouverture)
    const after = await vendorA.vendor.shopCategories.choices();
    expect(after.others.find((c) => c.name === name)).toBeTruthy();
  });
});
