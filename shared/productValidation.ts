import { z } from "zod";

/** Règles partagées navigateur / serveur pour les produits vendeurs et leurs médias. */

export const MEDIA_LIMITS = {
  image: { maxBytes: 8 * 1024 * 1024, mimeTypes: ["image/jpeg", "image/png", "image/webp"], label: "JPG, PNG ou WEBP, 8 Mo maximum" },
  video: { maxBytes: 60 * 1024 * 1024, mimeTypes: ["video/mp4", "video/webm"], label: "MP4 ou WEBM, 60 Mo maximum" },
} as const;

export const MAX_PRODUCT_IMAGES = 10;

export const AVAILABILITY_LABELS = {
  in_stock: "En stock",
  made_to_order: "Sur commande",
  out_of_stock: "Rupture de stock",
} as const;

export type Availability = keyof typeof AVAILABILITY_LABELS;

export const VARIANT_GROUPS = [
  { key: "dimensions", label: "Dimensions" },
  { key: "colors", label: "Couleurs" },
  { key: "materials", label: "Matériaux" },
  { key: "models", label: "Modèles" },
] as const;

export const SHOP_CATEGORY_NAME_RULE = { min: 2, max: 50 } as const;

export type ProductVariants = { dimensions: string[]; colors: string[]; materials: string[]; models: string[] };

export const EMPTY_VARIANTS: ProductVariants = { dimensions: [], colors: [], materials: [], models: [] };

export function parseVariants(raw: string | null | undefined): ProductVariants {
  if (!raw) return { ...EMPTY_VARIANTS };
  try {
    const value = JSON.parse(raw) as Partial<ProductVariants>;
    const clean = (list: unknown) => (Array.isArray(list) ? list.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : []);
    return { dimensions: clean(value.dimensions), colors: clean(value.colors), materials: clean(value.materials), models: clean(value.models) };
  } catch {
    return { ...EMPTY_VARIANTS };
  }
}

/**
 * Convertit une URL YouTube / Vimeo en URL d'intégration sûre. Toute autre URL est refusée.
 * Retourne null si l'URL n'est pas reconnue.
 */
export function toVideoEmbedUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^www\./, "").replace(/^m\./, "");
  const idPattern = /^[A-Za-z0-9_-]{6,20}$/;
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const id = url.pathname === "/watch" ? url.searchParams.get("v") : url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1];
    return id && idPattern.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (host === "youtu.be") {
    const id = url.pathname.slice(1);
    return idPattern.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = url.pathname.match(/(\d{6,12})/)?.[1];
    return id ? `https://player.vimeo.com/video/${id}` : null;
  }
  return null;
}

const variantList = z.array(z.string().trim().min(1).max(64, "Une variante ne peut pas dépasser 64 caractères")).max(20, "20 options maximum par variante");

const money = (label: string) =>
  z.number({ message: `${label} est requis` })
    .positive(`${label} doit être supérieur à 0`)
    .max(1_000_000, `${label} est trop élevé`)
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, `${label} : 2 décimales maximum`);

const cm = (label: string) => z.number({ message: `${label} est requise` }).int(`${label} : nombre entier de centimètres`).positive(`${label} doit être supérieure à 0`).max(100_000, `${label} est trop grande`);
const optionalMoney = (label: string) => z.number().nonnegative(`${label} ne peut pas être négatif`).max(1_000_000, `${label} est trop élevé`)
  .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6, `${label} : 3 décimales maximum`);

/** Option facultative d'un produit sur mesure (ex. « Cadre doré »), supplément au m² (ou au mètre) ou fixe. */
export const productOptionInputSchema = z.object({
  name: z.string().trim().min(1, "Donnez un nom à l'option").max(100, "Nom d'option trop long (100 caractères maximum)"),
  surchargeType: z.enum(["per_m2", "fixed"]),
  amountTnd: optionalMoney("Le supplément"),
});

export const MAX_PRODUCT_OPTIONS = 30;

export const productInputSchema = z.object({
  productId: z.number().int().positive().optional(),
  name: z.string().trim().min(3, "Le nom du produit doit comporter au moins 3 caractères").max(191, "Le nom du produit est trop long"),
  description: z.string().trim().min(20, "La description doit comporter au moins 20 caractères").max(5000, "La description est trop longue (5000 caractères maximum)"),
  // Catégorie de la boutique du vendeur (facultative). La catégorie globale du site est attribuée par l'administration.
  shopCategoryId: z.number().int().positive().nullable().optional(),
  priceTnd: money("Le prix"),
  promoPriceTnd: money("Le prix promotionnel").nullable().optional(),
  availability: z.enum(["in_stock", "made_to_order", "out_of_stock"]),
  stock: z.number().int("La quantité doit être un nombre entier").min(0, "La quantité ne peut pas être négative").max(100000).nullable().optional(),
  sku: z.string().trim().max(64, "La référence est trop longue").optional(),
  variants: z.object({ dimensions: variantList, colors: variantList, materials: variantList, models: variantList }),
  delivery: z.string().trim().max(500, "Les informations de livraison sont trop longues").optional(),
  preparationTime: z.string().trim().max(128, "Le délai de préparation est trop long").optional(),
  extraInfo: z.string().trim().max(2000, "Les informations complémentaires sont trop longues").optional(),
  images: z.array(z.object({ mediaId: z.number().int().positive(), isPrimary: z.boolean() })).max(MAX_PRODUCT_IMAGES, `${MAX_PRODUCT_IMAGES} photos maximum`),
  videoMediaId: z.number().int().positive().nullable().optional(),
  videoUrl: z.string().trim().max(500).nullable().optional(),
  action: z.enum(["draft", "publish"]),
  // Prix sur mesure (facultatif : par défaut, prix fixe comme avant)
  pricingMode: z.enum(["fixed", "per_m2", "per_linear_m"]).default("fixed"),
  unitPriceTnd: optionalMoney("Le prix unitaire").nullable().optional(),
  minWidthCm: cm("La largeur minimum").nullable().optional(),
  maxWidthCm: cm("La largeur maximum").nullable().optional(),
  minHeightCm: cm("La hauteur minimum").nullable().optional(),
  maxHeightCm: cm("La hauteur maximum").nullable().optional(),
  minBillableArea: z.number().nonnegative("La surface minimum ne peut pas être négative").max(10_000).nullable().optional(),
  minPriceTnd: optionalMoney("Le prix minimum").nullable().optional(),
  promoPercent: z.number().gt(0, "La remise doit être supérieure à 0 %").lt(100, "La remise doit être inférieure à 100 %").nullable().optional(),
  options: z.array(productOptionInputSchema).max(MAX_PRODUCT_OPTIONS, `${MAX_PRODUCT_OPTIONS} options maximum`).default([]),
})
  .refine((d) => d.pricingMode === "fixed" || (d.unitPriceTnd != null && d.unitPriceTnd > 0), { message: "Indiquez le prix unitaire (au m² ou au mètre)", path: ["unitPriceTnd"] })
  .refine((d) => d.pricingMode === "fixed" || (d.minWidthCm != null && d.maxWidthCm != null), { message: "Indiquez les dimensions minimum et maximum", path: ["maxWidthCm"] })
  .refine((d) => d.pricingMode !== "per_m2" || (d.minHeightCm != null && d.maxHeightCm != null), { message: "Indiquez la hauteur minimum et maximum", path: ["maxHeightCm"] })
  .refine((d) => d.minWidthCm == null || d.maxWidthCm == null || d.minWidthCm <= d.maxWidthCm, { message: "Le minimum ne peut pas dépasser le maximum", path: ["maxWidthCm"] })
  .refine((d) => d.minHeightCm == null || d.maxHeightCm == null || d.minHeightCm <= d.maxHeightCm, { message: "La hauteur minimum ne peut pas dépasser la hauteur maximum", path: ["maxHeightCm"] })
  .refine((d) => d.pricingMode === "fixed" || d.promoPriceTnd == null, { message: "Pour un produit sur mesure, utilisez une remise en %", path: ["promoPriceTnd"] })
  .refine((d) => d.pricingMode !== "fixed" || d.promoPercent == null, { message: "La remise en % est réservée aux produits sur mesure", path: ["promoPercent"] })
  .refine((d) => d.promoPriceTnd == null || d.promoPriceTnd < d.priceTnd, { message: "Le prix promotionnel doit être inférieur au prix normal", path: ["promoPriceTnd"] })
  .refine((d) => d.availability !== "in_stock" || (d.stock != null && d.stock >= 1), { message: "Indiquez la quantité disponible (au moins 1) ou choisissez « Sur commande »", path: ["stock"] })
  .refine((d) => d.action !== "publish" || d.images.length > 0, { message: "Ajoutez au moins une photo pour publier le produit", path: ["images"] })
  .refine((d) => d.images.length === 0 || d.images.filter((i) => i.isPrimary).length === 1, { message: "Choisissez une image principale", path: ["images"] })
  .refine((d) => !d.videoUrl || toVideoEmbedUrl(d.videoUrl) !== null, { message: "Lien vidéo non reconnu : utilisez une URL YouTube ou Vimeo en https", path: ["videoUrl"] });

export type ProductInput = z.infer<typeof productInputSchema>;

/** Prix effectivement payé par le client (promotion incluse). */
export function effectivePrice(priceTnd: number, promoPriceTnd: number | null | undefined) {
  return promoPriceTnd != null && promoPriceTnd > 0 && promoPriceTnd < priceTnd ? promoPriceTnd : priceTnd;
}

export function formatTnd(value: number) {
  return `${value.toFixed(2).replace(".", ",")} DT`;
}
