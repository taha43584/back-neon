/** Règles partagées navigateur / serveur pour l'identité visuelle et les réseaux sociaux des boutiques. */

export type ShopImageSlot = "logo" | "cover";

/**
 * Dimensions finales exactes : le navigateur recadre et redimensionne, le serveur
 * refuse toute image qui n'a pas exactement ces dimensions.
 */
export const SHOP_IMAGE_SPECS: Record<ShopImageSlot, { width: number; height: number; label: string }> = {
  logo: { width: 400, height: 400, label: "photo de profil" },
  cover: { width: 1600, height: 500, label: "photo de couverture" },
};

export const SHOP_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const SHOP_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const SHOP_IMAGE_FORMAT_LABEL = "JPG, PNG ou WEBP, 5 Mo maximum";

/** Initiales affichées quand la boutique n'a pas de logo (« Atelier Lumière » → « AL »). */
export function shopInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase() || "?";
}

// --- Réseaux sociaux ---

/** Limite de la colonne existante (varchar 191). */
export const SOCIAL_URL_MAX = 191;

type Normalized = { ok: true; value: string | null } | { ok: false; error: string };

const FACEBOOK_HOSTS = new Set(["facebook.com", "www.facebook.com", "m.facebook.com", "fb.com"]);
const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);

function normalizeUrl(raw: string, hosts: Set<string>, network: string, example: string): Normalized {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > SOCIAL_URL_MAX) return { ok: false, error: `Le lien ${network} est trop long (${SOCIAL_URL_MAX} caractères maximum).` };
  // Un autre protocole que http(s) (javascript:, data:, ftp:…) est refusé ; sans protocole, https:// est ajouté
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") return { ok: false, error: `Lien ${network} invalide. Exemple : ${example}` };
  let url: URL;
  try {
    url = new URL(scheme ? value : `https://${value}`);
  } catch {
    return { ok: false, error: `Lien ${network} invalide. Exemple : ${example}` };
  }
  url.protocol = "https:";
  const host = url.hostname.toLowerCase();
  if (!hosts.has(host) || url.username || url.password || url.port) {
    return { ok: false, error: `Seuls les liens ${network} sont acceptés. Exemple : ${example}` };
  }
  if (url.pathname.replace(/\/+$/, "") === "") return { ok: false, error: `Indiquez le lien complet de votre page ${network}. Exemple : ${example}` };
  const href = url.toString();
  if (href.length > SOCIAL_URL_MAX) return { ok: false, error: `Le lien ${network} est trop long (${SOCIAL_URL_MAX} caractères maximum).` };
  return { ok: true, value: href };
}

/** Facebook : https://(www.|m.)facebook.com/… ou https://fb.com/… ; vide = lien supprimé. */
export function normalizeFacebookUrl(raw: string | null | undefined): Normalized {
  return normalizeUrl(raw ?? "", FACEBOOK_HOSTS, "Facebook", "https://www.facebook.com/maboutique");
}

/** Instagram : https://(www.)instagram.com/… ou « @nomutilisateur » ; vide = lien supprimé. */
export function normalizeInstagramUrl(raw: string | null | undefined): Normalized {
  const value = (raw ?? "").trim();
  const handle = value.match(/^@([A-Za-z0-9._]{1,30})$/);
  if (handle) return { ok: true, value: `https://www.instagram.com/${handle[1]}` };
  if (value.startsWith("@")) return { ok: false, error: "Nom d'utilisateur Instagram invalide (lettres, chiffres, points et _ uniquement, 30 caractères maximum)." };
  return normalizeUrl(value, INSTAGRAM_HOSTS, "Instagram", "https://www.instagram.com/maboutique ou @maboutique");
}
