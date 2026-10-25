import { asc, inArray } from "drizzle-orm";
import { productOptions, products } from "../drizzle/schema";
import { getDb } from "./db";
import { computeCustomPrice, type CustomPriceResult, type CustomPricingMode } from "@shared/customPricing";

/**
 * Prix sur mesure côté serveur : la configuration et les options sont TOUJOURS relues depuis la base.
 * Le navigateur n'envoie que des mesures et des identifiants d'options ; tout montant reçu est ignoré.
 */

type ProductRow = typeof products.$inferSelect;

export type CustomLineRequest = { widthCm?: unknown; heightCm?: unknown; optionIds?: number[] };

export async function loadProductOptions(productIds: number[]) {
  const byProduct = new Map<number, Array<typeof productOptions.$inferSelect>>();
  if (!productIds.length) return byProduct;
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  const rows = await db.select().from(productOptions).where(inArray(productOptions.productId, productIds)).orderBy(asc(productOptions.position), asc(productOptions.id));
  for (const row of rows) byProduct.set(row.productId, [...(byProduct.get(row.productId) ?? []), row]);
  return byProduct;
}

export const isCustomProduct = (product: Pick<ProductRow, "pricingMode">) => product.pricingMode !== "fixed";

/** Calcule le prix d'une pièce d'un produit sur mesure ; refuse les options inconnues ou d'un autre produit. */
export function priceCustomLine(
  product: Pick<ProductRow, "id" | "name" | "pricingMode" | "unitPriceTnd" | "minWidthCm" | "maxWidthCm" | "minHeightCm" | "maxHeightCm" | "minBillableArea" | "minPriceTnd" | "promoPercent">,
  options: Array<typeof productOptions.$inferSelect>,
  request: CustomLineRequest,
): CustomPriceResult {
  const ids = Array.from(new Set(request.optionIds ?? []));
  const chosen = ids.map((id) => options.find((o) => o.id === id));
  if (chosen.some((o) => !o)) return { ok: false, error: `Option invalide pour « ${product.name} ». Rechargez la page du produit.`, field: "config" };
  return computeCustomPrice(
    {
      mode: product.pricingMode as CustomPricingMode,
      unitPriceTnd: product.unitPriceTnd,
      minWidthCm: product.minWidthCm,
      maxWidthCm: product.maxWidthCm,
      minHeightCm: product.minHeightCm,
      maxHeightCm: product.maxHeightCm,
      minBillableArea: product.minBillableArea,
      minPriceTnd: product.minPriceTnd,
      promoPercent: product.promoPercent,
    },
    { widthCm: request.widthCm, heightCm: request.heightCm },
    chosen.map((o) => ({ id: o!.id, name: o!.name, surchargeType: o!.surchargeType, amountTnd: o!.amountTnd })),
  );
}
