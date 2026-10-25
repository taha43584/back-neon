import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { calculateCommission } from "./db";

// In-memory state for testing complete workflow
let mockShops: any[] = [];
let mockProducts: any[] = [];
let mockUsers: any[] = [];
let nextShopId = 1;
let nextProductId = 1;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    applyForVendorShop: vi.fn(async (userId: number, input: any) => {
      const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      const existing = mockShops.find((s) => s.userId === userId);
      if (existing) {
        Object.assign(existing, input, { status: "pending", updatedAt: new Date() });
        return { id: existing.id, slug: existing.slug, status: "pending" };
      }
      const newShop = {
        id: nextShopId++,
        userId,
        name: input.name,
        slug,
        tagline: input.tagline || "",
        about: input.about || "",
        phone: input.phone || "",
        city: input.city || "",
        address: input.address || "",
        socialInstagram: input.socialInstagram || "",
        socialFacebook: input.socialFacebook || "",
        socialWebsite: input.socialWebsite || "",
        openingHours: input.openingHours || "",
        status: "pending",
        rating: "5.0",
        reviewCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockShops.push(newShop);
      return { id: newShop.id, slug: newShop.slug, status: newShop.status };
    }),
    createVendorShop: vi.fn(async (userId: number, input: any) => {
      const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      const newShop = {
        id: nextShopId++,
        userId,
        name: input.name,
        slug,
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockShops.push(newShop);
      return { id: newShop.id, slug: newShop.slug, status: newShop.status };
    }),
    getShopByUserId: vi.fn(async (userId: number) => {
      return mockShops.find((s) => s.userId === userId) || null;
    }),
    updateVendorShop: vi.fn(async (userId: number, input: any) => {
      const shop = mockShops.find((s) => s.userId === userId);
      if (!shop) throw new Error("Boutique introuvable");
      Object.assign(shop, input, { updatedAt: new Date() });
      return shop;
    }),
    createVendorProduct: vi.fn(async (userId: number, input: any) => {
      const shop = mockShops.find((s) => s.userId === userId);
      if (!shop) throw new Error("Vous devez d'abord créer une boutique.");
      if (shop.status !== "active") {
        throw new Error("Votre boutique doit être validée par l'administrateur avant de pouvoir publier des produits.");
      }
      const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      const newProduct = {
        id: nextProductId++,
        shopId: shop.id,
        name: input.name,
        slug,
        category: input.category,
        priceTnd: String(input.priceTnd),
        imageUrl: input.imageUrl,
        description: input.description || "",
        material: input.material || "",
        dimensions: input.dimensions || "",
        stock: input.stock ?? 1,
        customization: input.customization || "",
        status: input.status || "published",
        isFeatured: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockProducts.push(newProduct);
      return { success: true, slug, product: newProduct };
    }),
    updateVendorProduct: vi.fn(async (userId: number, productId: number, input: any) => {
      const shop = mockShops.find((s) => s.userId === userId);
      if (!shop) throw new Error("Boutique introuvable.");
      const product = mockProducts.find((p) => p.id === productId);
      if (!product) throw new Error("Produit introuvable.");
      if (product.shopId !== shop.id) {
        throw new Error("Ce produit n'appartient pas à votre boutique, vous n'avez pas l'autorisation de le modifier.");
      }
      Object.assign(product, input, { updatedAt: new Date() });
      return { success: true, product };
    }),
    toggleVendorProductStatus: vi.fn(async (userId: number, productId: number) => {
      const shop = mockShops.find((s) => s.userId === userId);
      if (!shop) throw new Error("Boutique introuvable.");
      const product = mockProducts.find((p) => p.id === productId);
      if (!product) throw new Error("Produit introuvable.");
      if (product.shopId !== shop.id) {
        throw new Error("Ce produit n'appartient pas à votre boutique.");
      }
      product.status = product.status === "published" ? "draft" : "published";
      product.updatedAt = new Date();
      return { success: true, status: product.status };
    }),
    deleteVendorProduct: vi.fn(async (userId: number, productId: number) => {
      const shop = mockShops.find((s) => s.userId === userId);
      if (!shop) throw new Error("Boutique introuvable.");
      const index = mockProducts.findIndex((p) => p.id === productId);
      if (index === -1) throw new Error("Produit introuvable.");
      if (mockProducts[index].shopId !== shop.id) {
        throw new Error("Ce produit n'appartient pas à votre boutique.");
      }
      mockProducts.splice(index, 1);
      return { success: true };
    }),
    getVendorDashboardData: vi.fn(async (userId: number) => {
      const shop = mockShops.find((s) => s.userId === userId) || null;
      const products = shop ? mockProducts.filter((p) => p.shopId === shop.id) : [];
      return {
        shop,
        stats: {
          totalRevenue: 0,
          netRevenue: 0,
          platformCommission: 0,
          orderCount: 0,
          productCount: products.length,
        },
        products,
        orders: [],
        reviews: [],
        messages: [],
      };
    }),
    getAdminDashboardData: vi.fn(async () => {
      return {
        stats: {
          totalShops: mockShops.length,
          pendingShops: mockShops.filter((s) => s.status === "pending").length,
          activeShops: mockShops.filter((s) => s.status === "active").length,
          totalProducts: mockProducts.length,
          totalUsers: mockUsers.length,
          totalOrders: 0,
          grossGmv: 0,
          platformRevenue: 0,
        },
        shops: [...mockShops],
        products: [...mockProducts],
        users: [...mockUsers],
        orders: [],
        reviews: [],
        commissions: [],
      };
    }),
    updateShopStatus: vi.fn(async (shopId: number, status: any) => {
      const shop = mockShops.find((s) => s.id === shopId);
      if (!shop) return false;
      shop.status = status;
      return true;
    }),
    adminModerateProduct: vi.fn(async (productId: number, input: any) => {
      const product = mockProducts.find((p) => p.id === productId);
      if (!product) throw new Error("Produit introuvable.");
      const status = typeof input === "object" && input.status ? input.status : (typeof input === "string" ? input : "draft");
      product.status = status;
      return { success: true, productId, status };
    }),
    adminUpdateOrderStatus: vi.fn(async (orderId: number, status: string) => {
      return { success: true, orderId, status };
    }),
  };
});

function createMockContext(user: any = null): TrpcContext {
  const req = { protocol: "https", headers: {} } as TrpcContext["req"];
  const res = {
    cookie: () => {},
    clearCookie: () => {},
  } as unknown as TrpcContext["res"];

  return { user, req, res };
}

describe("Seller & Admin Complete Workflow Tests", () => {
  const seller1User = { id: 201, openId: "seller_201", role: "vendor", email: "seller1@test.tn", name: "Artisan Nabeul" };
  const seller2User = { id: 202, openId: "seller_202", role: "vendor", email: "seller2@test.tn", name: "Miroir Luxe" };
  const adminUser = { id: 1, openId: "admin_1", role: "admin", email: "admin@elegance.tn", name: "Super Admin" };

  let seller1ShopId: number;
  let seller1ProductId: number;
  let seller2ProductId: number;

  it("1. Candidature Vendeur : Client soumet une demande d'ouverture de boutique (status 'pending')", async () => {
    const caller = appRouter.createCaller(createMockContext(seller1User));
    
    const applyRes = await caller.vendor.applyShop({
      name: "Atelier Céramique Nabeul",
      tagline: "Poteries d'exception",
      about: "Atelier artisanal créé avec passion",
      phone: "+216 50 123 456",
      city: "Nabeul",
      address: "10 Rue des Potiers",
      socialInstagram: "@ceramique_tn",
      socialWebsite: "https://ceramique.tn",
    });

    expect(applyRes).toBeDefined();
    expect(applyRes.status).toBe("pending");
    expect(applyRes.id).toBeGreaterThan(0);
    seller1ShopId = applyRes.id;
  });

  it("2. Vendeur en attente : Dashboard affiche l'état 'pending' et bloque la création de produits", async () => {
    const caller = appRouter.createCaller(createMockContext(seller1User));

    const dash = await caller.vendor.dashboard();
    expect(dash.shop).toBeDefined();
    expect(dash.shop?.status).toBe("pending");

    // Tentative de publication de produit rejetée tant que pending
    await expect(
      caller.vendor.createProduct({
        name: "Vase Bleu Nabeul",
        category: "Vases",
        priceTnd: "120.00",
        imageUrl: "https://images.unsplash.com/photo-vase.jpg",
        description: "Magnifique vase en faïence",
      })
    ).rejects.toThrow("Votre boutique doit être validée par l'administrateur");
  });

  it("3. Admin Dashboard : L'administrateur voit la demande vendeur en attente", async () => {
    const adminCaller = appRouter.createCaller(createMockContext(adminUser));

    const adminDash = await adminCaller.admin.dashboard();
    expect(adminDash.stats.pendingShops).toBeGreaterThanOrEqual(1);

    const pendingShop = adminDash.shops.find((s) => s.id === seller1ShopId);
    expect(pendingShop).toBeDefined();
    expect(pendingShop?.status).toBe("pending");
    expect(pendingShop?.name).toBe("Atelier Céramique Nabeul");
  });

  it("4. Validation Admin : L'administrateur approuve la boutique (status 'active')", async () => {
    const adminCaller = appRouter.createCaller(createMockContext(adminUser));

    const result = await adminCaller.admin.updateShopStatus({
      shopId: seller1ShopId,
      status: "active",
    });

    expect(result).toBe(true);

    const adminDash = await adminCaller.admin.dashboard();
    const approvedShop = adminDash.shops.find((s) => s.id === seller1ShopId);
    expect(approvedShop?.status).toBe("active");
  });

  it("5. Espace Vendeur Pro : Vendeur accède à son espace actif et modifie ses informations", async () => {
    const sellerCaller = appRouter.createCaller(createMockContext(seller1User));

    const dash = await sellerCaller.vendor.dashboard();
    expect(dash.shop?.status).toBe("active");

    const updated = await sellerCaller.vendor.updateShop({
      tagline: "Nouvelle signature artisanale",
      openingHours: "09h00 - 19h00",
      socialWebsite: "https://atelier-ceramique.tn",
    });

    expect(updated).toBeDefined();
    expect(updated.tagline).toBe("Nouvelle signature artisanale");
    expect(updated.openingHours).toBe("09h00 - 19h00");
  });

  it("6. Vendeur actif publie et gère son catalogue de produits", async () => {
    const sellerCaller = appRouter.createCaller(createMockContext(seller1User));

    const prodRes = await sellerCaller.vendor.createProduct({
      name: "Vase Céramique Fait Main",
      category: "Vases",
      priceTnd: "145.50",
      imageUrl: "https://images.unsplash.com/photo-vase.jpg",
      description: "Vase artisanal tourné à la main avec glaçure mate.",
      material: "Grès émaillé",
      dimensions: "H 28cm x L 16cm",
      stock: 5,
      customization: "Gravure disponible sur demande",
      status: "published",
    });

    expect(prodRes.success).toBe(true);
    expect(prodRes.slug).toBeDefined();

    const dash = await sellerCaller.vendor.dashboard();
    expect(dash.products.length).toBe(1);
    seller1ProductId = dash.products[0].id;

    // Modification du produit
    const updateRes = await sellerCaller.vendor.updateProduct({
      productId: seller1ProductId,
      priceTnd: "159.00",
      description: "Description enrichie après séance photo",
    });
    expect(updateRes.success).toBe(true);

    // Toggle status (published -> draft -> published)
    const toggleDraft = await sellerCaller.vendor.toggleProductStatus({ productId: seller1ProductId });
    expect(toggleDraft.status).toBe("draft");

    const togglePub = await sellerCaller.vendor.toggleProductStatus({ productId: seller1ProductId });
    expect(togglePub.status).toBe("published");
  });

  it("7. Isolation stricte : Un vendeur ne peut PAS modifier ni supprimer les produits d'un confrère", async () => {
    // Seller 2 applies and gets approved
    const seller2Caller = appRouter.createCaller(createMockContext(seller2User));
    const s2Shop = await seller2Caller.vendor.applyShop({ name: "Miroirs de Prestige" });
    const adminCaller = appRouter.createCaller(createMockContext(adminUser));
    await adminCaller.admin.updateShopStatus({ shopId: s2Shop.id, status: "active" });

    // Seller 2 creates product
    const s2Prod = await seller2Caller.vendor.createProduct({
      name: "Miroir Soleil Doré",
      category: "Miroirs",
      priceTnd: "320.00",
      imageUrl: "https://images.unsplash.com/photo-mirror.jpg",
    });
    const s2Dash = await seller2Caller.vendor.dashboard();
    seller2ProductId = s2Dash.products[0].id;

    // Seller 1 tries to update Seller 2's product
    const seller1Caller = appRouter.createCaller(createMockContext(seller1User));
    await expect(
      seller1Caller.vendor.updateProduct({
        productId: seller2ProductId,
        name: "Tentative de modification non autorisée",
      })
    ).rejects.toThrow("vous n'avez pas l'autorisation");

    // Seller 1 tries to delete Seller 2's product
    await expect(
      seller1Caller.vendor.deleteProduct({
        productId: seller2ProductId,
      })
    ).rejects.toThrow("Ce produit n'appartient pas à votre boutique");
  });

  it("8. Modération Admin : L'administrateur peut modérer tout produit du catalogue", async () => {
    const adminCaller = appRouter.createCaller(createMockContext(adminUser));

    const modDraft = await adminCaller.admin.moderateProduct({
      productId: seller1ProductId,
      status: "draft",
    });
    expect(modDraft.success).toBe(true);
    expect(modDraft.status).toBe("draft");

    const modPub = await adminCaller.admin.moderateProduct({
      productId: seller1ProductId,
      status: "published",
    });
    expect(modPub.status).toBe("published");
  });

  it("9. Suspension boutique : L'admin peut suspendre une boutique et bloquer la création de produits", async () => {
    const adminCaller = appRouter.createCaller(createMockContext(adminUser));

    const suspendRes = await adminCaller.admin.updateShopStatus({
      shopId: seller1ShopId,
      status: "suspended",
    });
    expect(suspendRes).toBe(true);

    const seller1Caller = appRouter.createCaller(createMockContext(seller1User));
    await expect(
      seller1Caller.vendor.createProduct({
        name: "Produit Bloqué Pendant Suspension",
        category: "Vases",
        priceTnd: "80.00",
        imageUrl: "https://images.unsplash.com/photo-block.jpg",
      })
    ).rejects.toThrow("Votre boutique doit être validée");
  });

  it("10. Grand livre des commissions : Modèle économique 10% plateforme / 90% vendeur garanti", () => {
    const sale1 = calculateCommission(100);
    expect(sale1).toEqual({
      grossTnd: 100,
      commissionTnd: 10,
      vendorPayoutTnd: 90,
    });

    const sale2 = calculateCommission(289.9);
    expect(sale2.grossTnd).toBe(289.9);
    expect(sale2.commissionTnd).toBe(28.99);
    expect(sale2.vendorPayoutTnd).toBe(260.91);
  });
});
