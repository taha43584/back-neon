import { describe, expect, it } from "vitest";
import { analyzeNeonText, computeNeonPrice, fontsForScript, NEON_FONTS, neonFromPrice, neonOfferIssues, neonOfferSchema, neonOrderDay, orderNeonWorkshopsForDay, type NeonOffer } from "../shared/neon";

/** Règles partagées du néon (navigateur + serveur) : texte, écritures, lettres comptées, prix. */

const letters = (text: string) => {
  const r = analyzeNeonText(text);
  if (!r.ok) throw new Error(r.error);
  return r.letters;
};
const refused = (text: string) => {
  const r = analyzeNeonText(text);
  return r.ok ? null : r.error;
};

const OFFER: NeonOffer = {
  enabled: true,
  sizes: [{ code: "S", widthCm: 50, priceTnd: 150 }, { code: "M", widthCm: 75, priceTnd: 220 }],
  includedLetters: 6, extraLetterPriceTnd: 8.5,
  colors: ["pink", "warm_white"],
  supports: [{ code: "cut", surchargeTnd: 30 }, { code: "none", surchargeTnd: 0 }],
  outdoorEnabled: true, outdoorSurchargeType: "percent", outdoorSurchargeValue: 20,
  arabicEnabled: true, productionDaysMin: 5, productionDaysMax: 7,
};
const LINE = { text: "Coffee", font: "pacifico", color: "pink", size: "S", support: "none", outdoor: false };

describe("Néon : lettres comptées (seules les LETTRES, même règle en latin et en arabe)", () => {
  it("chiffres, espaces et ponctuation ne comptent pas", () => {
    expect(letters("Coffee 2026")).toBe(6);
    expect(letters("Bienvenue !")).toBe(9);
    expect(letters("Néon éclatant")).toBe(12);
  });

  it("arabe : ni espaces, ni harakat, ni tatweel, ni ponctuation, ni chiffres", () => {
    expect(letters("مرحبا 2026")).toBe(5);
    expect(letters("مَرْحَبًا")).toBe(5);
    expect(letters("مـرحـبا")).toBe(5);
    expect(letters("سلام، أهلاً!")).toBe(8);
    expect(letters("مرحبا ٢٠٢٦")).toBe(5);
  });
});

describe("Néon : écritures et caractères", () => {
  it("les chiffres sont neutres : « مرحبا 2026 » est accepté (pas de mélange)", () => {
    expect(analyzeNeonText("مرحبا 2026")).toMatchObject({ ok: true, script: "arabic" });
    expect(analyzeNeonText("Coffee 2026")).toMatchObject({ ok: true, script: "latin" });
  });

  it("mélange arabe + latin refusé avec un message clair", () => {
    expect(refused("Hello مرحبا")).toBe("Une seule écriture par néon : texte en arabe ou en caractères latins, pas les deux.");
    expect(refused("Café\nمرحبا")).toContain("Une seule écriture");
  });

  it("emojis refusés, en latin comme en arabe", () => {
    expect(refused("Love 😍")).toContain("non accepté");
    expect(refused("حب ❤️")).toContain("non accepté");
  });

  it("3 lignes et 25 caractères par ligne au maximum (chiffres compris, harakat exclus)", () => {
    expect(refused("a\nb\nc\nd")).toContain("3 lignes");
    expect(analyzeNeonText("Un\nDeux\nTrois")).toMatchObject({ ok: true, lines: ["Un", "Deux", "Trois"] });
    expect(analyzeNeonText("A".repeat(25)).ok).toBe(true);
    expect(refused("Coffee 2026 et compagnie 1")).toContain("25 caractères");
    expect(refused("12345678901234567890123 a5")).toContain("25 caractères");
    // 25 lettres arabes + harakat : accepté (les harakat ne comptent pas dans la limite)
    expect(analyzeNeonText("بَ".repeat(25)).ok).toBe(true);
  });

  it("un texte sans lettre est refusé", () => {
    expect(refused("2026 !")).toContain("au moins une lettre");
    expect(refused("   ")).toContain("Écrivez");
  });
});

describe("Néon : polices (toutes OFL)", () => {
  it("6 polices latines dont Great Vibes, 2 polices arabes ; Yellowtail n'est plus proposée", () => {
    expect(fontsForScript("latin").map((f) => f.name)).toEqual(["Tilt Neon", "Pacifico", "Sacramento", "Great Vibes", "Kaushan Script", "Monoton"]);
    expect(fontsForScript("arabic").map((f) => f.name)).toEqual(["Reem Kufi", "Aref Ruqaa"]);
    expect(NEON_FONTS.some((f) => f.name === "Yellowtail")).toBe(false);
    expect(computeNeonPrice(OFFER, { ...LINE, font: "great-vibes" }).ok).toBe(true);
    expect(computeNeonPrice(OFFER, { ...LINE, font: "yellowtail" })).toMatchObject({ ok: false, field: "font" });
  });

  it("texte arabe : seules les polices arabes ; texte latin : pas de police arabe", () => {
    expect(computeNeonPrice(OFFER, { ...LINE, text: "مرحبا", font: "reem-kufi" })).toMatchObject({ ok: true, script: "arabic" });
    expect(computeNeonPrice(OFFER, { ...LINE, text: "مرحبا", font: "aref-ruqaa" }).ok).toBe(true);
    expect(computeNeonPrice(OFFER, { ...LINE, text: "مرحبا", font: "pacifico" })).toMatchObject({ ok: false, field: "font" });
    expect(computeNeonPrice(OFFER, { ...LINE, font: "reem-kufi" })).toMatchObject({ ok: false, field: "font" });
  });

  it("atelier qui n'accepte pas l'arabe : refusé", () => {
    expect(computeNeonPrice({ ...OFFER, arabicEnabled: false }, { ...LINE, text: "مرحبا", font: "reem-kufi" })).toMatchObject({ ok: false, error: "Cet atelier ne réalise pas de néons en arabe." });
  });
});

describe("Néon : prix", () => {
  it("taille + lettres au-delà de N + support, puis extérieur en %", () => {
    // « Bienvenue ! » = 9 lettres, 6 incluses → 3 × 8,5 = 25,5 ; M 220 ; découpé +30 ; extérieur +20 %
    const r = computeNeonPrice(OFFER, { ...LINE, text: "Bienvenue !", size: "M", support: "cut", outdoor: true });
    expect(r).toMatchObject({ ok: true, letters: 9, extraLetters: 3, basePriceTnd: 220, letterSurchargeTnd: 25.5, supportSurchargeTnd: 30, outdoorSurchargeTnd: 55.1, priceTnd: 330.6 });
  });

  it("extérieur en montant fixe ; chiffres jamais facturés comme lettres", () => {
    const r = computeNeonPrice({ ...OFFER, outdoorSurchargeType: "fixed", outdoorSurchargeValue: 40 }, { ...LINE, text: "Coffee 2026", outdoor: true });
    expect(r).toMatchObject({ ok: true, letters: 6, extraLetters: 0, priceTnd: 190 });
  });

  it("couleur, taille, support ou extérieur non proposés : refusés", () => {
    expect(computeNeonPrice(OFFER, { ...LINE, color: "green" })).toMatchObject({ ok: false, field: "color" });
    expect(computeNeonPrice(OFFER, { ...LINE, size: "XL" })).toMatchObject({ ok: false, field: "size" });
    expect(computeNeonPrice(OFFER, { ...LINE, support: "rect" })).toMatchObject({ ok: false, field: "support" });
    expect(computeNeonPrice({ ...OFFER, outdoorEnabled: false }, { ...LINE, outdoor: true })).toMatchObject({ ok: false, field: "outdoor" });
    expect(computeNeonPrice({ ...OFFER, enabled: false }, LINE)).toMatchObject({ ok: false, field: "offer" });
  });

  it("réglages d'atelier invalides refusés (prix manquant, code en double, couleur inconnue, délai incohérent)", () => {
    expect(neonOfferSchema.safeParse({ ...OFFER, sizes: [{ code: "S", widthCm: 50, priceTnd: 0 }] }).success).toBe(false);
    expect(neonOfferSchema.safeParse({ ...OFFER, sizes: [{ code: "S", widthCm: 50, priceTnd: 1 }, { code: "S", widthCm: 60, priceTnd: 2 }] }).success).toBe(false);
    expect(neonOfferSchema.safeParse({ ...OFFER, colors: ["fuchsia"] }).success).toBe(false);
    expect(neonOfferSchema.safeParse({ ...OFFER, productionDaysMin: 9, productionDaysMax: 3 }).success).toBe(false);
    expect(neonOfferSchema.safeParse(OFFER).success).toBe(true);
  });
});

describe("Ateliers néon : ordre équitable, prix de départ, réglages manquants", () => {
  const ws = ["atelier-a", "atelier-b", "atelier-c", "atelier-d"].map((shopSlug) => ({ shopSlug }));
  it("ordre aléatoire stable par jour : identique dans la journée, pas toujours le même atelier en premier", () => {
    const day = "2026-10-18";
    expect(orderNeonWorkshopsForDay(ws, day)).toEqual(orderNeonWorkshopsForDay([...ws].reverse(), day));
    const firsts = new Set(Array.from({ length: 30 }, (_, i) => orderNeonWorkshopsForDay(ws, `2026-11-${String(i + 1).padStart(2, "0")}`)[0].shopSlug));
    expect(firsts.size).toBeGreaterThan(1);
    expect(orderNeonWorkshopsForDay(ws, day)).toHaveLength(4);
  });
  it("jour calculé à l'heure de Tunis", () => {
    expect(neonOrderDay(new Date("2026-10-18T23:30:00Z"))).toBe("2026-10-19");
    expect(neonOrderDay(new Date("2026-10-18T10:00:00Z"))).toBe("2026-10-18");
  });
  it("« à partir de » = plus petit prix de taille", () => {
    expect(neonFromPrice({ sizes: [{ code: "M", widthCm: 75, priceTnd: 220 }, { code: "S", widthCm: 50, priceTnd: 150 }] })).toBe(150);
    expect(neonFromPrice({ sizes: [] })).toBeNull();
  });
  it("toutes les erreurs de réglage, en clair et sans doublon", () => {
    const issues = neonOfferIssues({ ...OFFER, colors: [], supports: [], sizes: [{ code: "S", widthCm: 50, priceTnd: Number.NaN }, { code: "M", widthCm: 75, priceTnd: 0 }] });
    expect(issues).toEqual(expect.arrayContaining(["Proposez au moins une couleur", "Proposez au moins un support", "Indiquez un prix pour chaque taille"]));
    expect(issues.filter((i) => i === "Indiquez un prix pour chaque taille")).toHaveLength(1);
    expect(neonOfferIssues(OFFER)).toEqual([]);
  });
});
