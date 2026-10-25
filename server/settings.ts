import { z } from "zod";
import { marketplaceSettings } from "../drizzle/schema";
import { getDb } from "./db";

/**
 * Paramètres du marketplace enregistrés en base (table `marketplace_settings`).
 * Chaque paramètre listé ici est réellement utilisé par le code :
 *  - identité et coordonnées : en-tête, pied de page et pages publiques ;
 *  - deliveryInfo : fiche produit, panier et validation de commande ;
 *  - termsOfService / salesTerms : pages /conditions-generales et /conditions-de-vente ;
 *  - requireProductApproval : la publication d'un vendeur passe « en attente » jusqu'à validation admin ;
 *  - commissionRate : taux appliqué aux nouvelles commandes (les commandes passées gardent leur commission) ;
 *  - neonCategorySlug / neonBannerHidden : catégorie du site liée au configurateur néon (choisie par l'admin,
 *    jamais déduite du nom) et masquage manuel de sa bannière « Créer mon néon » (voir server/neon.ts).
 */
export const settingsSchema = z.object({
  marketplaceName: z.string().trim().min(2, "Le nom doit comporter au moins 2 caractères").max(80),
  tagline: z.string().trim().max(200),
  contactEmail: z.union([z.literal(""), z.string().trim().email("Adresse e-mail invalide").max(320)]),
  contactPhone: z.string().trim().max(40),
  contactAddress: z.string().trim().max(300),
  whatsapp: z.string().trim().max(40),
  socialInstagram: z.union([z.literal(""), z.string().trim().url("Lien Instagram invalide").max(300)]),
  socialFacebook: z.union([z.literal(""), z.string().trim().url("Lien Facebook invalide").max(300)]),
  deliveryInfo: z.string().trim().max(1000),
  termsOfService: z.string().trim().max(20000),
  salesTerms: z.string().trim().max(20000),
  requireProductApproval: z.boolean(),
  commissionRate: z.number().min(0, "Le taux doit être compris entre 0 et 50 %").max(50, "Le taux doit être compris entre 0 et 50 %"),
  neonCategorySlug: z.union([z.literal(""), z.string().trim().max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Catégorie invalide")]),
  neonBannerHidden: z.boolean(),
});

export type MarketplaceSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: MarketplaceSettings = {
  marketplaceName: "Elegance Deco",
  tagline: "La marketplace tunisienne de la décoration",
  contactEmail: "",
  contactPhone: "",
  contactAddress: "",
  whatsapp: "",
  socialInstagram: "",
  socialFacebook: "",
  deliveryInfo: "Livraison partout en Tunisie. Les délais et frais de livraison sont précisés par chaque boutique.",
  termsOfService: "",
  salesTerms: "",
  requireProductApproval: false,
  commissionRate: 10,
  neonCategorySlug: "",
  neonBannerHidden: false,
};

const PUBLIC_KEYS = ["marketplaceName", "tagline", "contactEmail", "contactPhone", "contactAddress", "whatsapp", "socialInstagram", "socialFacebook", "deliveryInfo", "termsOfService", "salesTerms", "requireProductApproval"] as const;

let cache: { value: MarketplaceSettings; at: number } | null = null;
const CACHE_MS = 30_000;

export async function getSettings(): Promise<MarketplaceSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const db = await getDb();
  if (!db) return { ...DEFAULT_SETTINGS };
  const rows = await db.select().from(marketplaceSettings);
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (!(row.key in DEFAULT_SETTINGS)) continue;
    try {
      merged[row.key] = JSON.parse(row.value);
    } catch {
      // valeur illisible : on garde la valeur par défaut
    }
  }
  const parsed = settingsSchema.safeParse(merged);
  const value = parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
  cache = { value, at: Date.now() };
  return value;
}

export async function getPublicSettings() {
  const all = await getSettings();
  return Object.fromEntries(PUBLIC_KEYS.map((key) => [key, all[key]])) as Pick<MarketplaceSettings, (typeof PUBLIC_KEYS)[number]>;
}

export async function updateSettings(input: Partial<MarketplaceSettings>, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  const next = settingsSchema.parse({ ...(await getSettings()), ...input });
  await db.transaction(async (tx) => {
    for (const key of Object.keys(input) as Array<keyof MarketplaceSettings>) {
      const value = JSON.stringify(next[key]);
      await tx.insert(marketplaceSettings).values({ key, value, updatedByUserId: userId })
        .onDuplicateKeyUpdate({ set: { value, updatedByUserId: userId } });
    }
  });
  cache = null;
  return next;
}

export function clearSettingsCache() {
  cache = null;
}
