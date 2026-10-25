import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import type { Readable } from "stream";
import { MEDIA_LIMITS } from "@shared/productValidation";

/**
 * Stockage local des fichiers vendeurs.
 * - Les binaires sont écrits dans UPLOAD_DIR (par défaut ./storage/uploads), hors du dossier servi statiquement.
 * - MySQL ne garde que la clé (`<24 caractères>.<ext>`) et les métadonnées (table `media`).
 * - Le type réel est déterminé par la signature binaire du fichier, jamais par l'extension ni l'en-tête du navigateur.
 */

export type MediaKind = keyof typeof MEDIA_LIMITS;

export const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), "storage", "uploads"));
const TMP_DIR = path.join(UPLOAD_ROOT, ".tmp");

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

const KEY_PATTERN = /^[a-z0-9]{24}\.(jpg|png|webp|mp4|webm)$/;

export class UploadError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export function ensureUploadDirs() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

export function isValidStorageKey(key: string) {
  return KEY_PATTERN.test(key);
}

export function mediaUrl(storageKey: string) {
  return `/media/${storageKey}`;
}

/** Chemin absolu d'une clé, avec double contrôle anti-traversée de répertoire. */
export function resolveStoragePath(key: string): string | null {
  if (!isValidStorageKey(key)) return null;
  const full = path.resolve(UPLOAD_ROOT, key);
  if (path.dirname(full) !== UPLOAD_ROOT) return null;
  return full;
}

/** Détecte le type MIME réel à partir des premiers octets. */
export function detectMimeType(head: Buffer): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 12 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (head.length >= 12 && head.toString("ascii", 4, 8) === "ftyp") {
    const brand = head.toString("ascii", 8, 12);
    // Les conteneurs QuickTime (.mov) ne sont pas lus par tous les navigateurs : refusés
    if (brand !== "qt  ") return "video/mp4";
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "video/webm";
  return null;
}

/**
 * Écrit un flux entrant sur disque en respectant la taille maximale, puis valide sa signature.
 * Le fichier n'est rendu définitif qu'après validation complète ; sinon il est supprimé.
 */
export type UploadLimits = { maxBytes: number; mimeTypes: readonly string[]; label: string };

export async function storeUpload(stream: Readable, kind: MediaKind, declaredLength?: number, limitsOverride?: UploadLimits) {
  ensureUploadDirs();
  const limits: UploadLimits = limitsOverride ?? MEDIA_LIMITS[kind];
  if (declaredLength !== undefined && declaredLength > limits.maxBytes) {
    throw new UploadError(`Fichier trop volumineux (${limits.label}).`, 413);
  }

  const tmpPath = path.join(TMP_DIR, `${randomBytes(12).toString("hex")}.part`);
  const out = fs.createWriteStream(tmpPath, { flags: "wx" });
  let size = 0;
  let head = Buffer.alloc(0);

  try {
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (head.length < 32) head = Buffer.concat([head, chunk.subarray(0, 32 - head.length)]);
        if (size > limits.maxBytes) {
          stream.unpipe(out);
          stream.resume();
          reject(new UploadError(`Fichier trop volumineux (${limits.label}).`, 413));
        }
      });
      stream.on("error", reject);
      out.on("error", reject);
      out.on("finish", resolve);
      stream.pipe(out);
    });
  } catch (error) {
    out.destroy();
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }

  if (size === 0) {
    fs.rmSync(tmpPath, { force: true });
    throw new UploadError("Le fichier est vide.");
  }

  const mimeType = detectMimeType(head);
  if (!mimeType || !limits.mimeTypes.includes(mimeType)) {
    fs.rmSync(tmpPath, { force: true });
    throw new UploadError(`Format non autorisé. Formats acceptés : ${limits.label}.`, 415);
  }

  const storageKey = `${randomBytes(12).toString("hex")}.${EXTENSIONS[mimeType]}`;
  const finalPath = resolveStoragePath(storageKey)!;
  fs.renameSync(tmpPath, finalPath);
  return { storageKey, mimeType, sizeBytes: size };
}

export function deleteStoredFile(storageKey: string) {
  const full = resolveStoragePath(storageKey);
  if (full) fs.rmSync(full, { force: true });
}

export function storedFileExists(storageKey: string) {
  const full = resolveStoragePath(storageKey);
  return Boolean(full && fs.existsSync(full));
}
