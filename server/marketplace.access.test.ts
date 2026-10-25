import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { calculateCommission } from "./db";
import { selectCatalogCandidates } from "./aiCatalog";
import { catalogProducts } from "./catalog";
import type { TrpcContext } from "./_core/context";

function createUnauthenticatedContext(): TrpcContext {
  return {
    user: undefined,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("marketplace commission", () => {
  it("keeps a precise 10% platform commission and vendor payout", () => {
    expect(calculateCommission(129.9)).toEqual({
      grossTnd: 129.9,
      commissionTnd: 12.99,
      vendorPayoutTnd: 116.91,
    });
  });
});

describe("assistant catalog selection", () => {
  it("returns only real catalog products within the selected budget", () => {
    const candidates = selectCatalogCandidates(catalogProducts, { style: "Contemporain", budget: "100 à 300 TND" });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((product) => catalogProducts.some((catalogProduct) => catalogProduct.slug === product.slug))).toBe(true);
    expect(candidates.every((product) => Number(product.price.replace(/[^0-9.,]/g, "").replace(",", ".")) >= 100 && Number(product.price.replace(/[^0-9.,]/g, "").replace(",", ".")) <= 300)).toBe(true);
  });
});

describe("protected marketplace routes", () => {
  it("rejects the client dashboard without a session", async () => {
    const caller = appRouter.createCaller(createUnauthenticatedContext());
    await expect(caller.account.dashboard()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects vendor and checkout mutations without a session", async () => {
    const caller = appRouter.createCaller(createUnauthenticatedContext());
    await expect(caller.vendor.createShop({ name: "Boutique test" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.vendor.createProduct({ name: "Produit test", category: "Miroirs", priceTnd: "100", imageUrl: "https://example.com/product.jpg" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.vendor.deleteProduct({ productId: 1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.checkout.createOrder({
      totalTnd: 100,
      shippingName: "Client Test",
      shippingPhone: "+216 20 000 000",
      shippingAddress: "Rue Test",
      shippingCity: "Tunis",
      items: [{ productSlug: "test", productName: "Produit test", shopSlug: "boutique-test", shopName: "Boutique test", quantity: 1, unitPriceTnd: 100 }],
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects admin moderation without a session", async () => {
    const caller = appRouter.createCaller(createUnauthenticatedContext());
    await expect(caller.admin.updateShopStatus({ shopId: 1, status: "active" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.admin.updateReviewStatus({ reviewId: 1, status: "published" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects favorite and followed-shop mutations without a session", async () => {
    const caller = appRouter.createCaller(createUnauthenticatedContext());
    await expect(caller.account.toggleFavorite({ productSlug: "miroir-led-ondule", productName: "Miroir LED ondulé", imageUrl: "/manus-storage/neon-beauty.jpg", priceTnd: "289 TND" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.account.toggleFollowShop({ shopSlug: "nova-decor", shopName: "Nova Decor" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("protects addresses and review submission while keeping the public review query readable", async () => {
    const caller = appRouter.createCaller(createUnauthenticatedContext());
    await expect(caller.account.addAddress({ label: "Maison", recipientName: "Client Test", phone: "+216 20 000 000", addressLine: "Rue Test", city: "Tunis" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.account.deleteAddress({ addressId: 1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.reviews.submit({ productSlug: "miroir-led-ondule", rating: 5, body: "Un avis de test suffisamment long." })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const publishedReviews = await caller.reviews.list({ productSlug: "miroir-led-ondule" });
    expect(Array.isArray(publishedReviews)).toBe(true);
  });
});


describe("protected messaging routes", () => {
  it("rejects conversation reads and writes without a session", async () => {
    const caller = appRouter.createCaller(createUnauthenticatedContext());
    await expect(caller.messages.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.messages.get({ conversationId: 1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.messages.start({ shopSlug: "nova-decor", body: "Bonjour, je souhaite un conseil." })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.messages.send({ conversationId: 1, body: "Bonjour" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.messages.markRead({ conversationId: 1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
