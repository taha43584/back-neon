import { z } from "zod";

/**
 * Néon personnalisé : listes fixes, analyse du texte et calcul du prix.
 * Même code dans le navigateur (aperçu, prix affiché) et sur le serveur (panier, commande) :
 * le serveur recalcule toujours, aucun prix venant du navigateur n'est accepté.
 */

export const NEON_PRODUCT_SLUG = "neon-personnalise";
export const NEON_PRODUCT_NAME = "Néon personnalisé";
export const NEON_MAX_LINES = 3;
export const NEON_MAX_CHARS_PER_LINE = 25;

export type NeonScript = "latin" | "arabic";

/** Polices Google Fonts, toutes sous licence SIL OFL 1.1. */
export const NEON_FONTS = [
  { key: "tilt-neon", name: "Tilt Neon", family: "'Tilt Neon', sans-serif", script: "latin", css: "Tilt+Neon" },
  { key: "pacifico", name: "Pacifico", family: "'Pacifico', cursive", script: "latin", css: "Pacifico" },
  { key: "sacramento", name: "Sacramento", family: "'Sacramento', cursive", script: "latin", css: "Sacramento" },
  { key: "great-vibes", name: "Great Vibes", family: "'Great Vibes', cursive", script: "latin", css: "Great+Vibes" },
  { key: "kaushan-script", name: "Kaushan Script", family: "'Kaushan Script', cursive", script: "latin", css: "Kaushan+Script" },
  { key: "monoton", name: "Monoton", family: "'Monoton', cursive", script: "latin", css: "Monoton" },
  { key: "reem-kufi", name: "Reem Kufi", family: "'Reem Kufi', sans-serif", script: "arabic", css: "Reem+Kufi:wght@500" },
  { key: "aref-ruqaa", name: "Aref Ruqaa", family: "'Aref Ruqaa', serif", script: "arabic", css: "Aref+Ruqaa:wght@700" },
] as const satisfies ReadonlyArray<{ key: string; name: string; family: string; script: NeonScript; css: string }>;

export const NEON_COLORS = [
  { key: "warm_white", name: "Blanc chaud", hex: "#FFE9C7" },
  { key: "cold_white", name: "Blanc froid", hex: "#EAF6FF" },
  { key: "pink", name: "Rose", hex: "#FF4FA8" },
  { key: "red", name: "Rouge", hex: "#FF3B3B" },
  { key: "orange", name: "Orange", hex: "#FF8A2B" },
  { key: "yellow", name: "Jaune", hex: "#FFD93B" },
  { key: "green", name: "Vert", hex: "#3BFF7A" },
  { key: "ice_blue", name: "Bleu glace", hex: "#7FE7FF" },
  { key: "blue", name: "Bleu", hex: "#3B7BFF" },
  { key: "purple", name: "Violet", hex: "#B04BFF" },
] as const;

export const NEON_SUPPORTS = [
  { code: "cut", name: "Découpé à la forme" },
  { code: "rect", name: "Plaque rectangle" },
  { code: "none", name: "Sans support" },
] as const;

export type NeonFontKey = (typeof NEON_FONTS)[number]["key"];
export type NeonColorKey = (typeof NEON_COLORS)[number]["key"];
export type NeonSupportCode = (typeof NEON_SUPPORTS)[number]["code"];

/** Tailles proposées par défaut à un nouvel atelier (largeur en cm ; le prix est fixé par l'atelier). */
export const DEFAULT_NEON_SIZES = [
  { code: "S", widthCm: 50 },
  { code: "M", widthCm: 75 },
  { code: "L", widthCm: 100 },
  { code: "XL", widthCm: 130 },
] as const;

export const neonFont = (key: string) => NEON_FONTS.find((f) => f.key === key);
export const neonColor = (key: string) => NEON_COLORS.find((c) => c.key === key);
export const neonSupport = (code: string) => NEON_SUPPORTS.find((s) => s.code === code);
export const fontsForScript = (script: NeonScript) => NEON_FONTS.filter((f) => f.script === script);

/** Feuille Google Fonts pour les polices demandées (chargée seulement par les pages qui affichent un néon). */
export function neonFontsStylesheet(keys: readonly string[]) {
  const families = Array.from(new Set(keys)).map(neonFont).filter(Boolean).map((f) => `family=${f!.css}`);
  return families.length ? `https://fonts.googleapis.com/css2?${families.join("&")}&display=swap` : null;
}

// ---------------------------------------------------------------------------
// Analyse du texte
// ---------------------------------------------------------------------------

// Classes Unicode construites avec new RegExp (drapeau « u » non accepté par la cible TypeScript du projet)
const LATIN_LETTER = new RegExp("^\\p{Script=Latin}$", "u");
const ARABIC_SCRIPT = new RegExp("^\\p{Script=Arabic}$", "u");
const LETTER = new RegExp("^\\p{L}$", "u");
const DIGIT = /^[0-9٠-٩]$/; // 0-9 et ٠-٩ : neutres (ni latin ni arabe), jamais comptés comme lettres
const TATWEEL = "ـ";
const HARAKAT = /^[ً-ٰٟۖ-ۭ]$/; // signes diacritiques arabes
const LATIN_PUNCTUATION = new Set(["'", "’", "!", "?", ".", ",", "&", "-", "+", "@", "#"]);
const ARABIC_PUNCTUATION = new Set(["،", "؛", "؟", "!", ".", "-"]);

type CharKind = "space" | "digit" | "latin" | "arabic" | "mark" | "punct" | "invalid";

function classify(ch: string): CharKind {
  if (ch === " ") return "space";
  if (DIGIT.test(ch)) return "digit";
  if (ch === TATWEEL || HARAKAT.test(ch)) return "mark";
  if (LETTER.test(ch) && LATIN_LETTER.test(ch)) return "latin";
  if (LETTER.test(ch) && ARABIC_SCRIPT.test(ch)) return "arabic";
  if (LATIN_PUNCTUATION.has(ch) || ARABIC_PUNCTUATION.has(ch)) return "punct";
  return "invalid";
}

export type NeonTextAnalysis =
  | { ok: true; text: string; lines: string[]; script: NeonScript; letters: number; longestLine: number }
  | { ok: false; error: string };

/**
 * Texte d'un néon : 1 à 3 lignes, 25 caractères par ligne (harakat non comptés), une seule écriture.
 * Lettres comptées : uniquement les LETTRES (ni espaces, ni chiffres, ni ponctuation, ni harakat/tatweel).
 */
export function analyzeNeonText(raw: string): NeonTextAnalysis {
  const lines = String(raw ?? "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean);
  if (!lines.length) return { ok: false, error: "Écrivez le texte de votre néon." };
  if (lines.length > NEON_MAX_LINES) return { ok: false, error: `${NEON_MAX_LINES} lignes au maximum.` };

  let latin = 0;
  let arabic = 0;
  let longestLine = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    let length = 0;
    for (const ch of Array.from(line)) {
      const kind = classify(ch);
      if (kind === "invalid") return { ok: false, error: `Caractère non accepté : « ${ch} ». Lettres, chiffres et ponctuation simple uniquement (pas d'emoji).` };
      if (kind === "latin") latin++;
      if (kind === "arabic") arabic++;
      if (kind !== "mark") length++;
    }
    if (length > NEON_MAX_CHARS_PER_LINE) return { ok: false, error: `Ligne ${index + 1} : ${NEON_MAX_CHARS_PER_LINE} caractères au maximum (${length} actuellement).` };
    longestLine = Math.max(longestLine, length);
  }
  if (latin && arabic) return { ok: false, error: "Une seule écriture par néon : texte en arabe ou en caractères latins, pas les deux." };
  if (!latin && !arabic) return { ok: false, error: "Le texte doit contenir au moins une lettre." };

  const script: NeonScript = arabic ? "arabic" : "latin";
  // La ponctuation propre à une écriture n'est acceptée qu'avec elle
  const foreign = script === "latin" ? ["،", "؛", "؟"] : Array.from(LATIN_PUNCTUATION).filter((p) => !ARABIC_PUNCTUATION.has(p));
  const bad = lines.join("").split("").find((ch) => foreign.includes(ch));
  if (bad) return { ok: false, error: `Caractère non accepté avec cette écriture : « ${bad} ».` };

  return { ok: true, text: lines.join("\n"), lines, script, letters: latin + arabic, longestLine };
}

// ---------------------------------------------------------------------------
// Réglages d'un atelier
// ---------------------------------------------------------------------------

const money = (max: number) => z.number({ message: "Montant invalide" }).finite().min(0, "Montant invalide").max(max, "Montant trop élevé");

export const neonOfferSchema = z.object({
  enabled: z.boolean(),
  sizes: z.array(z.object({
    code: z.string().trim().min(1, "Code de taille requis").max(8, "Code de taille : 8 caractères au maximum").regex(/^[A-Z0-9]+$/, "Code de taille : lettres majuscules ou chiffres (ex. S, M, XL)"),
    widthCm: z.number({ message: "Indiquez la largeur de chaque taille" }).int("Largeur en centimètres entiers").min(10, "Largeur minimale : 10 cm").max(400, "Largeur maximale : 400 cm"),
    priceTnd: z.number({ message: "Indiquez un prix pour chaque taille" }).finite("Indiquez un prix pour chaque taille").gt(0, "Indiquez un prix pour chaque taille").max(100000, "Montant trop élevé"),
  })).min(1, "Ajoutez au moins une taille").max(8, "8 tailles au maximum")
    .refine((sizes) => new Set(sizes.map((s) => s.code)).size === sizes.length, "Chaque taille doit avoir un code différent"),
  includedLetters: z.number({ message: "Lettres incluses : nombre invalide" }).int("Lettres incluses : nombre entier").min(0, "Lettres incluses : 0 au minimum").max(200, "Lettres incluses : 200 au maximum"),
  extraLetterPriceTnd: money(10000),
  colors: z.array(z.enum(NEON_COLORS.map((c) => c.key) as [NeonColorKey, ...NeonColorKey[]], { message: "Couleur inconnue" })).min(1, "Proposez au moins une couleur")
    .refine((c) => new Set(c).size === c.length, "Couleur en double"),
  supports: z.array(z.object({
    code: z.enum(NEON_SUPPORTS.map((s) => s.code) as [NeonSupportCode, ...NeonSupportCode[]], { message: "Support inconnu" }),
    surchargeTnd: money(100000),
  })).min(1, "Proposez au moins un support")
    .refine((s) => new Set(s.map((x) => x.code)).size === s.length, "Support en double"),
  outdoorEnabled: z.boolean(),
  outdoorSurchargeType: z.enum(["percent", "fixed"]),
  outdoorSurchargeValue: money(100000),
  arabicEnabled: z.boolean(),
  productionDaysMin: z.number({ message: "Délai minimum invalide" }).int("Délai en jours entiers").min(1, "Délai de fabrication : 1 jour au minimum").max(365, "Délai de fabrication : 365 jours au maximum").nullable(),
  productionDaysMax: z.number({ message: "Délai maximum invalide" }).int("Délai en jours entiers").min(1, "Délai de fabrication : 1 jour au minimum").max(365, "Délai de fabrication : 365 jours au maximum").nullable(),
}).superRefine((offer, ctx) => {
  if (offer.outdoorSurchargeType === "percent" && offer.outdoorSurchargeValue > 200) ctx.addIssue({ code: "custom", path: ["outdoorSurchargeValue"], message: "Supplément extérieur : 200 % au maximum" });
  if (offer.productionDaysMin != null && offer.productionDaysMax != null && offer.productionDaysMin > offer.productionDaysMax) {
    ctx.addIssue({ code: "custom", path: ["productionDaysMax"], message: "Le délai maximum doit être supérieur ou égal au minimum" });
  }
});

export type NeonOffer = z.infer<typeof neonOfferSchema>;

// ---------------------------------------------------------------------------
// Prix
// ---------------------------------------------------------------------------

export type NeonLineRequest = { text: string; font: string; color: string; size: string; support: string; outdoor: boolean };

export type NeonPriceSuccess = {
  ok: true;
  text: string;
  lines: string[];
  script: NeonScript;
  letters: number;
  extraLetters: number;
  font: { key: string; name: string };
  color: { key: string; name: string; hex: string };
  size: { code: string; widthCm: number };
  heightCm: number;
  support: { code: string; name: string; surchargeTnd: number };
  outdoor: boolean;
  basePriceTnd: number;
  letterSurchargeTnd: number;
  supportSurchargeTnd: number;
  outdoorSurchargeTnd: number;
  priceTnd: number;
  productionDays: { min: number | null; max: number | null };
};
export type NeonPriceResult = NeonPriceSuccess | { ok: false; error: string; field: "text" | "font" | "color" | "size" | "support" | "outdoor" | "offer" };

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Hauteur estimée (cm) : proportionnelle à la largeur, au nombre de lignes et à la ligne la plus longue. */
export function estimateNeonHeight(widthCm: number, lineCount: number, longestLine: number) {
  const charWidthRatio = 0.62;
  const lineHeight = 1.3;
  const height = (widthCm * lineCount * lineHeight) / (Math.max(longestLine, 3) * charWidthRatio);
  return Math.max(5, Math.min(Math.round(height), Math.round(widthCm * 1.2)));
}

/** Prix d'UNE pièce : taille + lettres au-delà de N + support, puis supplément extérieur (% ou fixe). */
export function computeNeonPrice(offer: NeonOffer, request: NeonLineRequest): NeonPriceResult {
  if (!offer.enabled) return { ok: false, error: "Cet atelier ne propose plus le néon personnalisé.", field: "offer" };
  const analysis = analyzeNeonText(request.text);
  if (!analysis.ok) return { ok: false, error: analysis.error, field: "text" };
  if (analysis.script === "arabic" && !offer.arabicEnabled) return { ok: false, error: "Cet atelier ne réalise pas de néons en arabe.", field: "text" };

  const font = neonFont(request.font);
  if (!font) return { ok: false, error: "Cette police n'est pas proposée.", field: "font" };
  if (font.script !== analysis.script) {
    return { ok: false, field: "font", error: analysis.script === "arabic" ? "Pour un texte en arabe, choisissez Reem Kufi ou Aref Ruqaa." : "Cette police est réservée aux textes en arabe." };
  }
  const color = neonColor(request.color);
  if (!color || !offer.colors.includes(color.key)) return { ok: false, error: "Cette couleur n'est pas proposée par l'atelier.", field: "color" };
  const size = offer.sizes.find((s) => s.code === request.size);
  if (!size) return { ok: false, error: "Cette taille n'est pas proposée par l'atelier.", field: "size" };
  const supportOffer = offer.supports.find((s) => s.code === request.support);
  const support = neonSupport(request.support);
  if (!supportOffer || !support) return { ok: false, error: "Ce support n'est pas proposé par l'atelier.", field: "support" };
  if (request.outdoor && !offer.outdoorEnabled) return { ok: false, error: "Cet atelier ne propose pas l'option extérieur.", field: "outdoor" };

  const extraLetters = Math.max(0, analysis.letters - offer.includedLetters);
  const basePriceTnd = round3(size.priceTnd);
  const letterSurchargeTnd = round3(extraLetters * offer.extraLetterPriceTnd);
  const supportSurchargeTnd = round3(supportOffer.surchargeTnd);
  const subtotal = basePriceTnd + letterSurchargeTnd + supportSurchargeTnd;
  const outdoorSurchargeTnd = request.outdoor
    ? round3(offer.outdoorSurchargeType === "percent" ? (subtotal * offer.outdoorSurchargeValue) / 100 : offer.outdoorSurchargeValue)
    : 0;

  return {
    ok: true,
    text: analysis.text,
    lines: analysis.lines,
    script: analysis.script,
    letters: analysis.letters,
    extraLetters,
    font: { key: font.key, name: font.name },
    color: { key: color.key, name: color.name, hex: color.hex },
    size: { code: size.code, widthCm: size.widthCm },
    heightCm: estimateNeonHeight(size.widthCm, analysis.lines.length, analysis.longestLine),
    support: { code: support.code, name: support.name, surchargeTnd: supportSurchargeTnd },
    outdoor: Boolean(request.outdoor),
    basePriceTnd,
    letterSurchargeTnd,
    supportSurchargeTnd,
    outdoorSurchargeTnd,
    priceTnd: round2(subtotal + outdoorSurchargeTnd),
    productionDays: { min: offer.productionDaysMin, max: offer.productionDaysMax },
  };
}

/** « 5 à 7 jours » / « 5 jours » / null */
export function describeProductionDays(days: { min: number | null; max: number | null }) {
  if (days.min && days.max && days.min !== days.max) return `${days.min} à ${days.max} jours`;
  const d = days.min ?? days.max;
  return d ? `${d} jour${d > 1 ? "s" : ""}` : null;
}

/** Résumé d'une ligne néon : « Coffee » · Pacifico · Rose · M (75 cm) · Découpé à la forme · Extérieur */
export function describeNeonLine(n: { text: string; fontName: string; colorName: string; size: string; widthCm?: number | null; supportName: string; outdoor: boolean }) {
  return [
    `« ${n.text.replace(/\n/g, " / ")} »`, n.fontName, n.colorName,
    n.widthCm ? `${n.size} (${n.widthCm} cm)` : n.size, n.supportName, n.outdoor ? "Extérieur" : null,
  ].filter(Boolean).join(" · ");
}

/** Plus petit prix de taille de l'atelier (« à partir de X DT »). */
export function neonFromPrice(offer: Pick<NeonOffer, "sizes">) {
  return offer.sizes.length ? Math.min(...offer.sizes.map((s) => s.priceTnd)) : null;
}

/** Jour (AAAA-MM-JJ, heure de Tunis) servant de graine à l'ordre des ateliers. */
export function neonOrderDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tunis", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function fnv1a(value: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Ordre des ateliers « aléatoire stable par jour » : le même toute la journée (et pour tout le monde),
 * différent d'un jour à l'autre, sans favoriser un vendeur (aucun critère de popularité ni d'ancienneté).
 */
export function orderNeonWorkshopsForDay<T extends { shopSlug: string }>(items: T[], day: string): T[] {
  return [...items].sort((a, b) => fnv1a(`${day}|${a.shopSlug}`) - fnv1a(`${day}|${b.shopSlug}`) || a.shopSlug.localeCompare(b.shopSlug));
}

/** Toutes les erreurs de réglage d'une offre, en phrases lisibles et sans doublon (formulaire vendeur). */
export function neonOfferIssues(input: unknown): string[] {
  const parsed = neonOfferSchema.safeParse(input);
  if (parsed.success) return [];
  return Array.from(new Set(parsed.error.issues.map((i) => i.message)));
}
