/** Données géographiques partagées navigateur / serveur. */

/** Les 24 gouvernorats de Tunisie (liste du formulaire de commande) */
export const GOVERNORATES = [
  "Ariana", "Béja", "Ben Arous", "Bizerte", "Gabès", "Gafsa", "Jendouba", "Kairouan", "Kasserine", "Kébili",
  "Le Kef", "Mahdia", "La Manouba", "Médenine", "Monastir", "Nabeul", "Sfax", "Sidi Bouzid", "Siliana",
  "Sousse", "Tataouine", "Tozeur", "Tunis", "Zaghouan",
] as const;

/** Compare deux noms sans accents ni majuscules (« beja » = « Béja ») */
export function sameName(a: string, b: string) {
  const key = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  return key(a) === key(b);
}

/**
 * Lit une ville enregistrée : « Hammam Sousse, Sousse » → { city: 'Hammam Sousse', governorate: 'Sousse' } ;
 * « Sousse » → { city: '', governorate: 'Sousse' } ; « La Marsa » → { city: 'La Marsa', governorate: '' }.
 */
export function splitCity(value: string | null | undefined): { city: string; governorate: string } {
  const text = String(value ?? "").trim();
  const comma = text.lastIndexOf(",");
  const last = comma >= 0 ? text.slice(comma + 1).trim() : text;
  const governorate = GOVERNORATES.find((g) => sameName(g, last)) ?? "";
  if (!governorate) return { city: text, governorate: "" };
  return { city: comma >= 0 ? text.slice(0, comma).trim() : "", governorate };
}
