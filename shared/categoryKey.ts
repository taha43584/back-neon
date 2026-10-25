/**
 * Clé des catégories du site — UNE seule fonction de normalisation, utilisée partout :
 * regroupement des catégories des vendeurs, slug de l'URL /categorie/<slug> et masquage par l'admin.
 *
 * normalizeCategoryName : minuscules, sans accents, espaces réduits (« Miroirs  Muraux » → « miroirs muraux »)
 * categorySlug          : clé normalisée → slug d'URL (« miroirs muraux » → « miroirs-muraux »)
 *
 * Le slug ne dépend QUE du texte du nom (ni de l'ordre, ni d'un identifiant) : il est stable.
 * Deux noms qui donnent le même slug désignent la même catégorie du site (elles sont fusionnées).
 */

const MAX_SLUG = 120;

/** Minuscules, sans accents (é → e, œ → oe…), espaces (y compris insécables) réduits à un seul, bords retirés. */
export function normalizeCategoryName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/œ/gi, "oe")
    .replace(/æ/gi, "ae")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Petit hachage stable (FNV-1a 32 bits), pour les noms sans aucune lettre ni chiffre latin. */
function stableHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Forme « au singulier » d'une clé normalisée : retire le s / x final de chaque mot (miroirs → miroir, panneaux → panneau). */
function singularKey(key: string) {
  return key.split(" ").map((w) => (w.length > 3 && /(s|x)$/.test(w) ? w.slice(0, -1) : w)).join(" ");
}

/** Distance d'édition (Levenshtein), bornée : renvoie max + 1 dès que la limite est dépassée. */
function editDistance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Catégories existantes PROCHES d'un nom saisi (anti-doublons « Vouliez-vous dire … ? ») :
 * même nom au singulier/pluriel près, ou petite faute (1 lettre ; 2 si le nom fait au moins 9 caractères).
 * Un nom qui a exactement le même slug n'est pas une « suggestion » : c'est la même catégorie.
 */
export function findSimilarCategories<T extends { name: string }>(input: string, existing: T[], limit = 3): T[] {
  const key = normalizeCategoryName(input);
  if (key.length < 3) return [];
  const slug = categorySlug(input);
  const singular = singularKey(key);
  const max = key.length >= 9 ? 2 : 1;
  return existing
    .map((item) => {
      const other = normalizeCategoryName(item.name);
      if (categorySlug(item.name) === slug) return null;
      if (singularKey(other) === singular) return { item, score: 0 };
      const d = editDistance(singular, singularKey(other), max);
      return d <= max ? { item, score: d } : null;
    })
    .filter((x): x is { item: T; score: number } => x !== null)
    .sort((a, b) => a.score - b.score || a.item.name.localeCompare(b.item.name, "fr"))
    .slice(0, limit)
    .map((x) => x.item);
}

/**
 * Slug d'URL de la catégorie, dérivé de la clé normalisée : tout ce qui n'est pas lettre/chiffre devient « - ».
 * Un nom sans lettre ni chiffre latin (ex. « ★★ » ou un nom en arabe) reçoit un slug stable « c-<hachage> ».
 */
export function categorySlug(name: string): string {
  const key = normalizeCategoryName(name);
  const slug = key.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_SLUG).replace(/-+$/g, "");
  return slug || `c-${stableHash(key)}`;
}
