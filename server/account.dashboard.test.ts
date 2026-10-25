import { describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const mocks = vi.hoisted(() => ({
  getClientDashboardData: vi.fn(),
}));

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return { ...actual, getClientDashboardData: mocks.getClientDashboardData };
});

import { appRouter } from "./routers";

function createContext(): TrpcContext {
  return {
    user: {
      id: 7,
      openId: "dashboard-test-user",
      name: "Client test",
      email: "client@example.com",
      loginMethod: "manus",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("account.dashboard", () => {
  it("returns pending reviews to the authenticated client dashboard", async () => {
    mocks.getClientDashboardData.mockResolvedValueOnce({
      stats: { orderCount: 1, favoriteCount: 0, followedShopCount: 0 },
      orders: [],
      favorites: [],
      followedShops: [],
      addresses: [],
      reviews: [{ id: 12, orderId: 44, productName: "Miroir Aura", productSlug: "miroir-aura", rating: 5, body: "En attente de modération", status: "pending", createdAt: new Date() }],
      reviewableProducts: [],
    });

    const result = await appRouter.createCaller(createContext()).account.dashboard();

    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0]).toMatchObject({ status: "pending", productSlug: "miroir-aura" });
    expect(mocks.getClientDashboardData).toHaveBeenCalledWith(7);
  });
});
