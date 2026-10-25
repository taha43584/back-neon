import { describe, expect, it } from "vitest";
import { computeCustomPrice, describeCustomLine, toMillimes, type CustomPricingConfig } from "../shared/customPricing";

const m2 = (overrides: Partial<CustomPricingConfig> = {}): CustomPricingConfig => ({ mode: "per_m2", unitPriceTnd: "120.000", minWidthCm: 20, maxWidthCm: 300, minHeightCm: 20, maxHeightCm: 300, ...overrides });
const price = (r: ReturnType<typeof computeCustomPrice>) => { if (!r.ok) throw new Error(r.error); return r; };

describe("Calcul du prix sur mesure (fonction partagée, entiers uniquement)", () => {
  it("80 × 150 cm à 120 DT/m² = 1,2 m² → 144,0 DT", () => {
    const r = price(computeCustomPrice(m2(), { widthCm: 80, heightCm: 150 }));
    expect(r).toMatchObject({ areaM2: 1.2, billedAreaM2: 1.2, priceTnd: 144, regularPriceTnd: 144, minAreaApplied: false });
  });

  it("30 × 30 cm avec surface minimum 0,5 m² à 120 DT/m² → 60,0 DT", () => {
    const r = price(computeCustomPrice(m2({ minBillableArea: "0.500" }), { widthCm: 30, heightCm: 30 }));
    expect(r).toMatchObject({ areaM2: 0.09, billedAreaM2: 0.5, priceTnd: 60, minAreaApplied: true });
  });

  it("options au m² et options fixes", () => {
    const options = [
      { name: "Cadre doré", surchargeType: "per_m2" as const, amountTnd: "30" },
      { name: "Pose murale", surchargeType: "fixed" as const, amountTnd: 25.5 },
    ];
    // 1,2 m² × (120 + 30) + 25,5 = 180 + 25,5 = 205,5
    const r = price(computeCustomPrice(m2(), { widthCm: 80, heightCm: 150 }, options));
    expect(r.priceTnd).toBe(205.5);
    expect(r.options).toEqual([{ name: "Cadre doré", surchargeType: "per_m2", amountTnd: 30 }, { name: "Pose murale", surchargeType: "fixed", amountTnd: 25.5 }]);
  });

  it("prix minimum appliqué", () => {
    const r = price(computeCustomPrice(m2({ minPriceTnd: 90 }), { widthCm: 40, heightCm: 50 })); // 0,2 m² × 120 = 24 → 90
    expect(r).toMatchObject({ priceTnd: 90, minPriceApplied: true });
    expect(price(computeCustomPrice(m2({ minPriceTnd: 90 }), { widthCm: 80, heightCm: 150 })).minPriceApplied).toBe(false);
  });

  it("arrondi au 0,1 DT le plus proche, sans erreur de virgule flottante", () => {
    // 0,1 × 0,3 m … : 33 × 33 cm = 0,1089 m² × 99,99 = 10,888911 → 10,9
    expect(price(computeCustomPrice(m2({ unitPriceTnd: "99.990" }), { widthCm: 33, heightCm: 33 })).priceTnd).toBe(10.9);
    // 0,05 arrondi vers le haut : 0,0625 m² (25 × 25) × 0,8 = 0,05 → 0,1
    expect(price(computeCustomPrice(m2({ unitPriceTnd: "0.800", minWidthCm: null, minHeightCm: null }), { widthCm: 25, heightCm: 25 })).priceTnd).toBe(0.1);
    // 0,1 + 0,2 piège classique : 10 × 30 cm (0,03 m²) à 10 DT = 0,3 exactement
    expect(price(computeCustomPrice(m2({ unitPriceTnd: 10, minWidthCm: null, minHeightCm: null }), { widthCm: 10, heightCm: 30 })).priceTnd).toBe(0.3);
    expect(toMillimes("12,345")).toBe(12345n);
    expect(toMillimes(0.1 + 0.2)).toBe(300n);
  });

  it("remise en % sur le prix calculé (après le prix minimum)", () => {
    const r = price(computeCustomPrice(m2({ promoPercent: "10.00" }), { widthCm: 80, heightCm: 150 }));
    expect(r).toMatchObject({ regularPriceTnd: 144, priceTnd: 129.6, promoPercent: 10 });
  });

  it("mètre linéaire : seule la longueur est demandée", () => {
    const linear: CustomPricingConfig = { mode: "per_linear_m", unitPriceTnd: 45, minWidthCm: 50, maxWidthCm: 600, minBillableArea: "1.000" };
    expect(price(computeCustomPrice(linear, { widthCm: 250 }))).toMatchObject({ areaM2: 2.5, priceTnd: 112.5, heightCm: null });
    expect(price(computeCustomPrice(linear, { widthCm: 60 }))).toMatchObject({ areaM2: 0.6, billedAreaM2: 1, priceTnd: 45 });
    // Une option « au m² » est comptée au mètre en mode linéaire
    expect(price(computeCustomPrice(linear, { widthCm: 200 }, [{ name: "LED", surchargeType: "per_m2", amountTnd: 5 }])).priceTnd).toBe(100);
  });

  it("mesures refusées avec un message clair", () => {
    const cases: Array<[unknown, unknown, string]> = [
      [10, 100, "La largeur doit être comprise entre 20 et 300 cm."],
      [80, 400, "La hauteur doit être comprise entre 20 et 300 cm."],
      [-5, 100, "La largeur doit être supérieure à 0 cm."],
      [0, 100, "La largeur doit être supérieure à 0 cm."],
      ["abc", 100, "La largeur doit être un nombre."],
      [80.5, 100, "La largeur doit être un nombre entier de centimètres."],
      [80, "", "Indiquez la hauteur en centimètres."],
      [80, Number.NaN, "La hauteur doit être un nombre."],
      [80, Infinity, "La hauteur doit être un nombre."],
    ];
    for (const [w, h, message] of cases) {
      const r = computeCustomPrice(m2(), { widthCm: w, heightCm: h });
      expect(r.ok, `${w} × ${h}`).toBe(false);
      if (!r.ok) expect(r.error).toBe(message);
    }
    expect(computeCustomPrice(m2({ unitPriceTnd: 0 }), { widthCm: 80, heightCm: 80 }).ok).toBe(false);
  });

  it("résumé de ligne : « 80 × 150 cm · 1,2 m² · Cadre doré »", () => {
    expect(describeCustomLine({ pricingMode: "per_m2", widthCm: 80, heightCm: 150, areaM2: "1.2000", options: [{ name: "Cadre doré" }] })).toBe("80 × 150 cm · 1,2 m² · Cadre doré");
    expect(describeCustomLine({ pricingMode: "per_linear_m", widthCm: 250, areaM2: 2.5 })).toBe("250 cm · 2,5 m");
    expect(describeCustomLine({ pricingMode: "fixed" })).toBeNull();
  });
});
