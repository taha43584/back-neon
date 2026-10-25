import { z } from "zod";
import { MEDIA_LIMITS } from "./productValidation";

/**
 * Avis clients avec photos (A-10c) : règles partagées navigateur / serveur.
 * Le serveur reste seul juge (droits, ligne livrée, une fois par ligne, photos, moyennes).
 */

/** Photos d'avis : MÊME validation que les photos produits (JPG, PNG ou WEBP, 8 Mo, signature du fichier) */
export const REVIEW_PHOTO_LIMITS = MEDIA_LIMITS.image;
export const MAX_REVIEW_PHOTOS = 3;
/** Fichiers envoyés mais pas encore rattachés à un avis : au plus 6 par compte, supprimés après 24 h */
export const MAX_PENDING_REVIEW_PHOTOS = 6;
export const PENDING_REVIEW_PHOTO_TTL_MS = 24 * 60 * 60 * 1000;

export const REVIEW_BODY_MIN = 10;
export const REVIEW_BODY_MAX = 2000;
export const REVIEW_REPLY_MAX = 1000;
export const REVIEW_REPORT_MAX = 500;
/** Avis par page sur la fiche produit (« Voir plus d'avis ») */
export const REVIEW_PAGE_SIZE = 5;

export const REVIEW_CRITERIA = [
  { key: "qualityRating", label: "Qualité" },
  { key: "conformityRating", label: "Conforme à la photo" },
  { key: "deliveryRating", label: "Livraison" },
] as const;
export type ReviewCriterionKey = (typeof REVIEW_CRITERIA)[number]["key"];

export const REVIEW_SORTS = ["recent", "helpful", "rating_high", "rating_low"] as const;
export const REVIEW_FILTERS = ["photos", "five", "custom"] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];
export type ReviewFilter = (typeof REVIEW_FILTERS)[number];

/** Nom affiché d'un avis anonyme (le badge « Achat vérifié » reste affiché) */
export const ANONYMOUS_AUTHOR = "Client vérifié";

const star = z.number().int().min(1, "Choisissez une note de 1 à 5").max(5, "Choisissez une note de 1 à 5");

/** Avis complet sur UNE ligne de commande livrée */
export const reviewSubmissionSchema = z.object({
  orderItemId: z.number().int().positive(),
  rating: star,
  qualityRating: star,
  conformityRating: star,
  deliveryRating: star,
  body: z.string().trim().min(REVIEW_BODY_MIN, `Votre avis doit contenir au moins ${REVIEW_BODY_MIN} caractères`).max(REVIEW_BODY_MAX),
  photoIds: z.array(z.number().int().positive()).max(MAX_REVIEW_PHOTOS, `${MAX_REVIEW_PHOTOS} photos au maximum`).default([]),
  /** Publier anonymement : ni nom ni gouvernorat ne sont enregistrés */
  anonymous: z.boolean().default(false),
});
export type ReviewSubmission = z.infer<typeof reviewSubmissionSchema>;

/** Prénom + initiale du nom : « Sarra Ben Ali » → « Sarra B. » (le nom commence au 2ᵉ mot) ; un seul mot → ce mot ; vide → null */
export function authorDisplayNameOf(fullName: string | null | undefined): string | null {
  const parts = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const first = parts[0].slice(0, 40);
  return parts.length > 1 ? `${first} ${parts[1].charAt(0).toUpperCase()}.` : first;
}

/** Champs d'une ligne de commande utiles au libellé de la variante achetée */
export interface PurchasedLine {
  pricingMode: string | null;
  widthCm: number | null;
  heightCm: number | null;
  selectedColor: string | null;
  neonText: string | null;
  neonColorName: string | null;
  neonSize: string | null;
}

/** Ligne sur mesure (m², mètre linéaire) ou néon personnalisé */
export function isCustomLine(line: Pick<PurchasedLine, "pricingMode">) {
  return Boolean(line.pricingMode && line.pricingMode !== "fixed");
}

/** Variante achetée, copiée de la ligne : « 80 × 150 cm · Doré », « Néon « Salma » · Rose · M », ou null */
export function purchasedVariantOf(line: PurchasedLine): string | null {
  const parts: string[] = [];
  if (line.pricingMode === "neon") {
    if (line.neonText) parts.push(`Néon « ${line.neonText} »`);
    if (line.neonColorName) parts.push(line.neonColorName);
    if (line.neonSize) parts.push(line.neonSize);
  } else if (line.widthCm) {
    parts.push(line.heightCm ? `${line.widthCm} × ${line.heightCm} cm` : `${line.widthCm} cm`);
  }
  if (line.selectedColor) parts.push(line.selectedColor);
  return parts.length ? parts.join(" · ").slice(0, 255) : null;
}
