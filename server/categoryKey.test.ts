import { describe, expect, it } from "vitest";
import { categorySlug, findSimilarCategories, normalizeCategoryName } from "../shared/categoryKey";

describe("Clé des catégories du site (fonction de normalisation unique)", () => {
  it("minuscules, sans accents, espaces réduits", () => {
    expect(normalizeCategoryName("  Miroirs   Muraux ")).toBe("miroirs muraux");
    expect(normalizeCategoryName("LED Néon")).toBe("led neon");
    expect(normalizeCategoryName("Décoration murale")).toBe("decoration murale");
    expect(normalizeCategoryName("Œuvres d'Art")).toBe("oeuvres d'art");
    expect(normalizeCategoryName("Céramique\tÀ\nla main")).toBe("ceramique a la main");
  });

  it("les variantes d'un même nom donnent la même clé et le même slug", () => {
    const variants = ["Miroirs", "miroirs", "MIROIRS", "  Miroirs ", "Mîroirs", "Miroirs "];
    expect(new Set(variants.map(normalizeCategoryName))).toEqual(new Set(["miroirs"]));
    expect(new Set(variants.map(categorySlug))).toEqual(new Set(["miroirs"]));
  });

  it("slug d'URL stable et sûr", () => {
    expect(categorySlug("LED Néon")).toBe("led-neon");
    expect(categorySlug("Décoration murale")).toBe("decoration-murale");
    expect(categorySlug("Cafés & restaurants")).toBe("cafes-restaurants");
    expect(categorySlug("MDF / CNC")).toBe("mdf-cnc");
    expect(categorySlug("--Tableaux--")).toBe("tableaux");
    // Même entrée → même slug, à chaque appel
    expect(categorySlug("Néons LED")).toBe(categorySlug("Néons LED"));
    expect(categorySlug("x".repeat(300)).length).toBeLessThanOrEqual(120);
  });

  it("deux noms différents qui donnent le même slug désignent la même catégorie", () => {
    expect(categorySlug("LED Néon")).toBe(categorySlug("LED-Néon"));
    expect(categorySlug("LED & Néon")).toBe(categorySlug("led néon"));
  });

  it("anti-doublons : « Vouliez-vous dire … ? » (singulier/pluriel, petite faute)", () => {
    const existing = [{ name: "Miroirs" }, { name: "LED Néon" }, { name: "Décoration murale" }, { name: "Tableaux" }, { name: "Vases" }];
    const names = (input: string) => findSimilarCategories(input, existing).map((c) => c.name);
    expect(names("Miroir")).toEqual(["Miroirs"]);
    expect(names("miroire")).toEqual(["Miroirs"]);
    expect(names("Tableau")).toEqual(["Tableaux"]);
    expect(names("Decoration murales")).toEqual(["Décoration murale"]);
    expect(names("Décoratoin murale")).toEqual(["Décoration murale"]);
    expect(names("LED Neons")).toEqual(["LED Néon"]);
    // Même slug = même catégorie (pas une suggestion) ; noms éloignés : aucune suggestion
    expect(names("led neon")).toEqual([]);
    expect(names("Luminaires")).toEqual([]);
    expect(names("Va")).toEqual([]);
  });

  it("nom sans lettre ni chiffre latin : slug stable « c-… »", () => {
    const slug = categorySlug("ديكور");
    expect(slug).toMatch(/^c-[0-9a-z]+$/);
    expect(categorySlug("ديكور")).toBe(slug);
    expect(categorySlug("★★")).toMatch(/^c-[0-9a-z]+$/);
    expect(categorySlug("★★")).not.toBe(slug);
  });
});

describe("Suggestion « Vouliez-vous dire … ? » entre boutiques", () => {
  it("« led neo » (catégorie d'une autre boutique) propose « Led neon » ; jamais la catégorie identique", () => {
    const existing = [{ name: "led neo" }, { name: "Led neon" }, { name: "Lettres boîtiers" }];
    expect(findSimilarCategories("led neo", existing).map((c) => c.name)).toEqual(["Led neon"]);
    expect(findSimilarCategories("LED NEO", existing).map((c) => c.name)).toEqual(["Led neon"]);
  });
});
