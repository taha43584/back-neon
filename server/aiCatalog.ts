type CandidateProduct = { name: string; price: string; category: string; description: string; material: string };

export function selectCatalogCandidates<T extends CandidateProduct>(products: T[], criteria: { style?: string; budget?: string }): T[] {
  const priceNumber = (price: string) => Number(price.replace(/[^0-9.,]/g, "").replace(",", "."));
  const budget = criteria.budget ?? "";
  const budgetFiltered = products.filter((product) => {
    const price = priceNumber(product.price);
    if (budget.includes("Moins")) return price < 100;
    if (budget.includes("100")) return price >= 100 && price <= 300;
    if (budget.includes("300")) return price > 300 && price <= 700;
    if (budget.includes("700")) return price > 700;
    return true;
  });
  const styleKeywords: Record<string, string[]> = {
    Minimaliste: ["minimal", "épur", "sobre", "naturel"],
    "Art déco": ["laiton", "dor", "velours", "miroir", "géométr"],
    Chaleureux: ["bois", "terre", "chaleur", "rotin", "lumière"],
    Professionnel: ["bureau", "enseigne", "épur", "contemporain"],
    Contemporain: ["contemporain", "moderne", "led", "miroir"],
  };
  const keywords = styleKeywords[criteria.style ?? ""] ?? [];
  const styleFiltered = keywords.length
    ? budgetFiltered.filter((product) => keywords.some((keyword) => `${product.name} ${product.category} ${product.description} ${product.material}`.toLowerCase().includes(keyword)))
    : budgetFiltered;
  return styleFiltered.length ? styleFiltered : budgetFiltered;
}
