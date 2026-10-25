/**
 * Prix selon les dimensions (sur mesure) — UNE seule fonction de calcul, partagée :
 * le serveur l'utilise pour faire foi (panier, commande), le navigateur pour l'estimation en direct.
 *
 * Tous les calculs sont faits en entiers (BigInt) : surfaces en cm², longueurs en mm, argent en millimes.
 * Aucune erreur de virgule flottante.
 *
 * - m²      : surface = L × H ; facturée = max(surface, minimum) ; prix = facturée × (prix/m² + options/m²) + options fixes
 * - linéaire : longueur facturée = max(longueur, minimum) ; prix = longueur × (prix/m + options « au m² » comptées au mètre) + options fixes
 * - prix = max(prix, prix minimum) ; remise % éventuelle ; arrondi au 0,1 DT le plus proche (0,05 → vers le haut)
 */

/** Entier exact (BigInt) ; la cible TypeScript du projet n'autorise pas les littéraux « 123n ». */
const B = (value: number) => BigInt(value);

export type PricingMode = "fixed" | "per_m2" | "per_linear_m";
export type CustomPricingMode = Exclude<PricingMode, "fixed">;
export type SurchargeType = "per_m2" | "fixed";

type Money = number | string | null | undefined;

export type CustomPricingConfig = {
  mode: CustomPricingMode;
  unitPriceTnd: Money;
  minWidthCm?: number | null;
  maxWidthCm?: number | null;
  minHeightCm?: number | null;
  maxHeightCm?: number | null;
  /** m² (ou mètres en mode linéaire) */
  minBillableArea?: Money;
  minPriceTnd?: Money;
  promoPercent?: Money;
};

export type PricingOption = { id?: number; name: string; surchargeType: SurchargeType; amountTnd: Money };

export type CustomPriceSuccess = {
  ok: true;
  mode: CustomPricingMode;
  widthCm: number;
  heightCm: number | null;
  /** Surface mesurée en m² (ou longueur en m), 4 décimales */
  areaM2: number;
  billedAreaM2: number;
  unitPriceTnd: number;
  options: Array<{ name: string; surchargeType: SurchargeType; amountTnd: number }>;
  /** Prix avant remise (prix minimum déjà appliqué), arrondi au 0,1 DT */
  regularPriceTnd: number;
  /** Prix final d'une pièce, arrondi au 0,1 DT */
  priceTnd: number;
  promoPercent: number | null;
  minPriceApplied: boolean;
  minAreaApplied: boolean;
};

export type CustomPriceResult = CustomPriceSuccess | { ok: false; error: string; field?: "width" | "height" | "config" };

export const PRICING_MODE_LABELS: Record<PricingMode, string> = {
  fixed: "Prix fixe",
  per_m2: "Prix au m²",
  per_linear_m: "Prix au mètre linéaire",
};

export const unitLabel = (mode: CustomPricingMode) => (mode === "per_m2" ? "m²" : "m");

/** Montant (DT, jusqu'à 3 décimales) → millimes entiers, sans passer par un calcul flottant. */
export function toMillimes(value: Money): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  const text = typeof value === "number" ? (Number.isFinite(value) ? value.toFixed(3) : "") : String(value).trim().replace(",", ".");
  const match = /^(-?)(\d+)(?:\.(\d{1,3})\d*)?$/.exec(text);
  if (!match) return null;
  const millimes = BigInt(match[2]) * B(1000) + BigInt((match[3] ?? "").padEnd(3, "0"));
  return match[1] ? -millimes : millimes;
}

/** Millimes → DT (nombre), pour l'affichage et l'enregistrement en decimal. */
export const fromMillimes = (millimes: bigint) => Number(millimes) / 1000;

/** Arrondi d'une fraction positive num / den à l'entier le plus proche (moitié vers le haut). */
const roundDiv = (num: bigint, den: bigint) => (num * B(2) + den) / (B(2) * den);

function checkMeasure(value: unknown, label: string, min: number | null | undefined, max: number | null | undefined, field: "width" | "height"): { error: string; field: "width" | "height" } | null {
  if (value === null || value === undefined || value === "") return { error: `Indiquez ${label} en centimètres.`, field };
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return { error: `${capitalize(label)} doit être un nombre.`, field };
  if (!Number.isInteger(n)) return { error: `${capitalize(label)} doit être un nombre entier de centimètres.`, field };
  if (n <= 0) return { error: `${capitalize(label)} doit être supérieure à 0 cm.`, field };
  if ((min != null && n < min) || (max != null && n > max)) {
    const range = min != null && max != null ? `comprise entre ${min} et ${max} cm` : min != null ? `d'au moins ${min} cm` : `d'au plus ${max} cm`;
    return { error: `${capitalize(label)} doit être ${range}.`, field };
  }
  return null;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const WIDTH_LABEL = { per_m2: "la largeur", per_linear_m: "la longueur" } as const;

/**
 * Calcule le prix d'UNE pièce sur mesure. `selectedOptions` = options du produit cochées par le client
 * (le serveur les relit toujours depuis la base : jamais de montant venant du navigateur).
 */
export function computeCustomPrice(config: CustomPricingConfig, measures: { widthCm: unknown; heightCm?: unknown }, selectedOptions: PricingOption[] = []): CustomPriceResult {
  const unit = toMillimes(config.unitPriceTnd);
  if (unit === null || unit <= B(0)) return { ok: false, error: "Ce produit n'a pas de prix unitaire valide.", field: "config" };

  const widthError = checkMeasure(measures.widthCm, WIDTH_LABEL[config.mode], config.minWidthCm, config.maxWidthCm, "width");
  if (widthError) return { ok: false, ...widthError };
  const width = BigInt(Number(measures.widthCm));
  let height: bigint | null = null;
  if (config.mode === "per_m2") {
    const heightError = checkMeasure(measures.heightCm, "la hauteur", config.minHeightCm, config.maxHeightCm, "height");
    if (heightError) return { ok: false, ...heightError };
    height = BigInt(Number(measures.heightCm));
  }

  // Quantité mesurée dans une unité entière : cm² (1 m² = 10 000 cm²) ou mm (1 m = 1 000 mm)
  const perUnit = config.mode === "per_m2" ? B(10000) : B(1000);
  const measured = config.mode === "per_m2" ? width * height! : width * B(10);
  // Minimum facturé (m² ou m, 3 décimales) converti dans la même unité : 0,001 m² = 10 cm² ; 0,001 m = 1 mm
  const minArea = toMillimes(config.minBillableArea);
  const minMeasured = minArea !== null && minArea > B(0) ? (config.mode === "per_m2" ? minArea * B(10) : minArea) : B(0);
  const billed = measured > minMeasured ? measured : minMeasured;

  const options = selectedOptions.map((o) => ({ name: o.name, surchargeType: o.surchargeType, amount: toMillimes(o.amountTnd) ?? B(0) }));
  const rate = unit + options.filter((o) => o.surchargeType === "per_m2").reduce((s, o) => s + o.amount, B(0));
  const fixed = options.filter((o) => o.surchargeType === "fixed").reduce((s, o) => s + o.amount, B(0));

  // Prix exact en « millimes × perUnit » (fraction sans perte)
  let exact = billed * rate + fixed * perUnit;
  const minPrice = toMillimes(config.minPriceTnd);
  const minPriceApplied = minPrice !== null && minPrice > B(0) && exact < minPrice * perUnit;
  if (minPriceApplied) exact = minPrice! * perUnit;

  // Arrondi au 0,1 DT = 100 millimes
  const regularTenths = roundDiv(exact, perUnit * B(100));
  const promoHundredths = toMillimes(config.promoPercent); // % avec 2 décimales → ×1000 ici
  const promoPercent = promoHundredths !== null && promoHundredths > B(0) && promoHundredths < B(100000) ? promoHundredths : null;
  const finalTenths = promoPercent ? roundDiv(exact * (B(100000) - promoPercent), perUnit * B(100) * B(100000)) : regularTenths;

  const toM2 = (value: bigint) => Number(roundDiv(value * B(10000), perUnit)) / 10_000; // 4 décimales
  return {
    ok: true,
    mode: config.mode,
    widthCm: Number(width),
    heightCm: height === null ? null : Number(height),
    areaM2: toM2(measured),
    billedAreaM2: toM2(billed),
    unitPriceTnd: fromMillimes(unit),
    options: options.map((o) => ({ name: o.name, surchargeType: o.surchargeType, amountTnd: fromMillimes(o.amount) })),
    regularPriceTnd: Number(regularTenths) / 10,
    priceTnd: Number(finalTenths) / 10,
    promoPercent: promoPercent ? Number(promoPercent) / 1000 : null,
    minPriceApplied,
    minAreaApplied: billed > measured,
  };
}

/** « 1,2 m² » / « 2,35 m » (sans zéros inutiles). */
export function formatArea(value: number, mode: CustomPricingMode) {
  return `${Number(value.toFixed(4)).toLocaleString("fr-FR", { maximumFractionDigits: 4 })} ${unitLabel(mode)}`;
}

/** Résumé d'une ligne sur mesure : « 80 × 150 cm · 1,2 m² · Cadre doré ». */
export function describeCustomLine(line: { pricingMode?: string | null; widthCm?: number | null; heightCm?: number | null; areaM2?: number | string | null; options?: Array<{ name: string }> | null }) {
  if (!line.pricingMode || line.pricingMode === "fixed" || line.widthCm == null) return null;
  const mode = line.pricingMode as CustomPricingMode;
  const size = mode === "per_m2" ? `${line.widthCm} × ${line.heightCm} cm` : `${line.widthCm} cm`;
  const parts = [size];
  if (line.areaM2 != null) parts.push(formatArea(Number(line.areaM2), mode));
  for (const option of line.options ?? []) parts.push(option.name);
  return parts.join(" · ");
}

/** Lecture tolérante des options figées d'une ligne de commande. */
export function parseOrderOptions(raw: string | null | undefined): Array<{ name: string; surchargeType: SurchargeType; amountTnd: number }> {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((o) => o && typeof o.name === "string") : [];
  } catch {
    return [];
  }
}
