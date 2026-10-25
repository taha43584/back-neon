import { describe, expect, it } from "vitest";
import { assertReviewStatusChange, clientVisibleReviews, isClientModerationVisible, isReviewVisibleOnProductPage, onlyPublishedReviews } from "./reviews";

describe("review moderation visibility", () => {
  const reviews = [
    { id: 1, status: "pending" as const, body: "En attente" },
    { id: 2, status: "published" as const, body: "Publié" },
    { id: 3, status: "rejected" as const, body: "Rejeté" },
  ];

  it("exposes only published reviews to the public product page", () => {
    expect(onlyPublishedReviews(reviews)).toEqual([{ id: 2, status: "published", body: "Publié" }]);
    expect(reviews.filter(isReviewVisibleOnProductPage)).toHaveLength(1);
    expect(reviews.filter(isReviewVisibleOnProductPage)[0]?.id).toBe(2);
  });

  it("keeps pending and published reviews visible to the authenticated client dashboard", () => {
    expect(reviews.filter(isClientModerationVisible).map((review) => review.id)).toEqual([1, 2]);
    expect(clientVisibleReviews(reviews).map((review) => review.id)).toEqual([1, 2]);
    expect(isClientModerationVisible(reviews[2]!)).toBe(false);
  });

  it("requires an effective status transition", () => {
    expect(assertReviewStatusChange("pending", "published")).toBe("published");
    expect(() => assertReviewStatusChange("published", "published")).toThrow("déjà");
  });
});
