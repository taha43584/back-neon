import fs from "fs";
import { eq, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { shops } from "../drizzle/schema";
import { getDb } from "./db";
import { deleteStoredFile, mediaUrl, resolveStoragePath, UploadError } from "./mediaStorage";
import { normalizeFacebookUrl, normalizeInstagramUrl, SHOP_IMAGE_SPECS, type ShopImageSlot } from "@shared/shopValidation";

/**
 * Logo et couverture des boutiques.
 * - La boutique est TOUJOURS celle du vendeur connecté (jamais un identifiant reçu du navigateur).
 * - Le navigateur recadre et redimensionne ; le serveur revérifie le type réel (signature),
 *   la taille (5 Mo) et les dimensions exactes lues dans l'en-tête du fichier.
 * - Le chemin `/media/<clé>` est enregistré dans shops.logoUrl / shops.coverUrl (aucune ligne `media`,
 *   donc pas de nettoyage automatique des fichiers « orphelins ») ; l'ancien fichier est supprimé du disque.
 */

const COLUMN = { logo: "logoUrl", cover: "coverUrl" } as const;
const MEDIA_PATH = /^\/media\/([a-z0-9]{24}\.(?:jpg|png|webp))$/;
/** Statuts autorisés : la boutique peut être préparée avant l'approbation (images privées jusque-là). */
const EDITABLE_STATUSES = new Set(["pending", "active", "rejected"]);

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("La base de données est indisponible");
  return db;
}

/** Clé de stockage contenue dans une URL `/media/<clé>` enregistrée, sinon null (ancienne URL externe, valeur vide…). */
export function storageKeyFromUrl(url: string | null | undefined) {
  return url ? MEDIA_PATH.exec(url)?.[1] ?? null : null;
}

/** Dimensions lues dans l'en-tête d'une image PNG, JPEG ou WEBP (sans bibliothèque). */
export function readImageDimensions(buf: Buffer): { width: number; height: number } | null {
  // PNG : bloc IHDR juste après la signature
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("ascii", 12, 16) === "IHDR") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // WEBP : conteneur RIFF, premier bloc VP8 (avec perte), VP8L (sans perte) ou VP8X (étendu)
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8 " && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L" && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    return null;
  }
  // JPEG : parcours des segments jusqu'au premier marqueur SOF (dimensions de l'image)
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
      const length = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + length;
    }
  }
  return null;
}

/** Boutique du vendeur connecté, modifiable (en attente, active ou refusée ; jamais suspendue). */
export async function requireEditableShop(userId: number) {
  const db = await requireDb();
  const shop = (await db.select().from(shops).where(eq(shops.userId, userId)).limit(1))[0];
  if (!shop) throw new TRPCError({ code: "FORBIDDEN", message: "Boutique introuvable pour ce compte vendeur" });
  if (!EDITABLE_STATUSES.has(shop.status)) throw new TRPCError({ code: "FORBIDDEN", message: "Votre boutique est suspendue : elle ne peut pas être modifiée." });
  return shop;
}

/**
 * Enregistre un fichier déjà validé (signature + taille) comme logo ou couverture de la boutique.
 * Vérifie les dimensions exactes ; en cas de refus, le fichier est supprimé.
 */
export async function saveShopImage(userId: number, slot: ShopImageSlot, storageKey: string) {
  const spec = SHOP_IMAGE_SPECS[slot];
  const path = resolveStoragePath(storageKey);
  const dims = path ? readImageDimensions(fs.readFileSync(path)) : null;
  if (!dims || dims.width !== spec.width || dims.height !== spec.height) {
    deleteStoredFile(storageKey);
    throw new UploadError(`La ${spec.label} doit mesurer exactement ${spec.width} × ${spec.height} pixels${dims ? ` (reçu : ${dims.width} × ${dims.height})` : ""}.`, 422);
  }
  const db = await requireDb();
  let shop;
  try {
    shop = await requireEditableShop(userId);
  } catch (error) {
    deleteStoredFile(storageKey);
    throw error;
  }
  const url = mediaUrl(storageKey);
  const previousKey = storageKeyFromUrl(shop[COLUMN[slot]]);
  await db.update(shops).set({ [COLUMN[slot]]: url }).where(eq(shops.id, shop.id));
  // L'ancien fichier n'est plus référencé : supprimé du disque (il ne sera plus servi)
  if (previousKey && previousKey !== storageKey) deleteStoredFile(previousKey);
  return { url, width: dims.width, height: dims.height };
}

/** Retire le logo ou la couverture (retour à l'affichage par défaut) et supprime le fichier. */
export async function removeShopImage(userId: number, slot: ShopImageSlot) {
  const db = await requireDb();
  const shop = await requireEditableShop(userId);
  const previousKey = storageKeyFromUrl(shop[COLUMN[slot]]);
  await db.update(shops).set({ [COLUMN[slot]]: null }).where(eq(shops.id, shop.id));
  if (previousKey) deleteStoredFile(previousKey);
  return { success: true };
}

/** Droits de lecture d'une image de boutique : publique si la boutique est active, sinon propriétaire / administration. */
export async function getShopImageAccess(storageKey: string) {
  const db = await requireDb();
  const url = mediaUrl(storageKey);
  const shop = (await db.select({ userId: shops.userId, status: shops.status }).from(shops).where(or(eq(shops.logoUrl, url), eq(shops.coverUrl, url))).limit(1))[0];
  if (!shop) return null;
  const extension = storageKey.split(".").pop();
  const mimeType = extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg";
  return { ownerUserId: shop.userId, mimeType, isPublic: shop.status === "active" };
}

/** Liens Facebook / Instagram de la boutique du vendeur connecté (vide = lien supprimé). */
export async function updateShopSocialLinks(userId: number, input: { facebook?: string | null; instagram?: string | null }) {
  const db = await requireDb();
  const shop = await requireEditableShop(userId);
  const facebook = normalizeFacebookUrl(input.facebook);
  if (!facebook.ok) throw new TRPCError({ code: "BAD_REQUEST", message: facebook.error });
  const instagram = normalizeInstagramUrl(input.instagram);
  if (!instagram.ok) throw new TRPCError({ code: "BAD_REQUEST", message: instagram.error });
  await db.update(shops).set({ socialFacebook: facebook.value, socialInstagram: instagram.value }).where(eq(shops.id, shop.id));
  return { facebook: facebook.value, instagram: instagram.value };
}
