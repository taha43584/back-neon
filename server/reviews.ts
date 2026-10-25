export type ReviewModerationState = "pending" | "published" | "rejected";

export type ReviewWithModerationState = {
  status: ReviewModerationState;
  [key: string]: unknown;
};

export function onlyPublishedReviews<T extends ReviewWithModerationState>(reviews: T[]) {
  return reviews.filter((review) => review.status === "published");
}

export function isPublicReview(review: ReviewWithModerationState) {
  return review.status === "published";
}

export function isClientModerationVisible(review: ReviewWithModerationState) {
  return review.status === "pending" || review.status === "published";
}

export function isReviewVisibleOnProductPage(review: ReviewWithModerationState) {
  return isPublicReview(review);
}

export function clientVisibleReviews<T extends ReviewWithModerationState>(reviews: T[]) {
  return reviews.filter((review) => isClientModerationVisible(review));
}

export function assertReviewStatusChange(currentStatus: ReviewModerationState, nextStatus: ReviewModerationState) {
  if (currentStatus === nextStatus) throw new Error("Le statut de cet avis est déjà celui demandé");
  return nextStatus;
}
