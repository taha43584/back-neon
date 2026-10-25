import type { Express, Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { ensureUploadDirs, resolveStoragePath, storeUpload, UPLOAD_ROOT, UploadError, deleteStoredFile, isValidStorageKey, type MediaKind } from "./mediaStorage";
import { countUnattachedMedia, createMediaRecord, getMediaAccessInfo, getShopForUser, MAX_UNATTACHED_UPLOADS } from "./vendorCatalog";
import { canVendorViewQuoteLogo, requireNeonShop } from "./neon";
import { getShopImageAccess, requireEditableShop, saveShopImage } from "./shopImages";
import { SHOP_IMAGE_FORMAT_LABEL, SHOP_IMAGE_MAX_BYTES, SHOP_IMAGE_MIME_TYPES, type ShopImageSlot } from "@shared/shopValidation";
import { TRPCError } from "@trpc/server";
import { getReviewPhotoAccess } from "./customerReviews";
import fs from "fs";

const SHOP_IMAGE_LIMITS = { maxBytes: SHOP_IMAGE_MAX_BYTES, mimeTypes: SHOP_IMAGE_MIME_TYPES, label: SHOP_IMAGE_FORMAT_LABEL };

async function optionalUser(req: Request) {
  try {
    return await sdk.authenticateRequest(req);
  } catch {
    return null;
  }
}

export function registerMediaRoutes(app: Express) {
  ensureUploadDirs();
  console.log(`[Media] Stockage des fichiers : ${UPLOAD_ROOT}`);

  /**
   * Envoi d'un fichier : corps brut (le fichier lui-même), `?kind=image|video&name=<nom d'origine>`.
   * Réservé aux vendeurs dont la boutique est validée.
   */
  app.post("/api/uploads", async (req: Request, res: Response) => {
    const kind = req.query.kind === "video" ? "video" : req.query.kind === "image" ? "image" : null;
    if (!kind) {
      res.status(400).json({ error: "Type de fichier invalide (image ou video)." });
      return;
    }
    const user = await optionalUser(req);
    if (!user) {
      req.resume();
      res.status(401).json({ error: "Connectez-vous pour envoyer des fichiers." });
      return;
    }
    const shop = user.role === "vendor" ? await getShopForUser(user.id) : undefined;
    if (!shop || shop.status !== "active") {
      req.resume();
      res.status(403).json({ error: "Seuls les vendeurs dont la boutique est validée peuvent envoyer des fichiers." });
      return;
    }
    if ((await countUnattachedMedia(user.id)) >= MAX_UNATTACHED_UPLOADS) {
      req.resume();
      res.status(429).json({ error: "Trop de fichiers en attente : enregistrez ou supprimez vos produits en cours avant d'en envoyer d'autres." });
      return;
    }

    const declared = Number(req.headers["content-length"]);
    let stored: Awaited<ReturnType<typeof storeUpload>> | undefined;
    try {
      stored = await storeUpload(req, kind as MediaKind, Number.isFinite(declared) ? declared : undefined);
      const originalName = typeof req.query.name === "string" ? req.query.name.replace(/[^A-Za-z0-9À-ÿ ._-]/g, "").slice(0, 191) : null;
      const record = await createMediaRecord({ ownerUserId: user.id, shopId: shop.id, kind, originalName, ...stored });
      res.status(201).json(record);
    } catch (error) {
      if (stored) deleteStoredFile(stored.storageKey);
      if (error instanceof UploadError) {
        if (!req.complete) req.resume();
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error("[Media] Échec de l'envoi :", error);
      res.status(500).json({ error: "Le fichier n'a pas pu être enregistré." });
    }
  });

  /**
   * Logo (400×400) ou couverture (1600×500) de la boutique du vendeur connecté : corps brut = l'image recadrée.
   * La boutique vient de la session (aucun identifiant n'est lu dans la requête). Autorisé aux boutiques
   * en attente : l'image reste privée tant que la boutique n'est pas approuvée.
   */
  app.post("/api/vendor/shop/:slot", async (req: Request, res: Response) => {
    const slot = req.params.slot === "logo" || req.params.slot === "cover" ? (req.params.slot as ShopImageSlot) : null;
    const refuse = (status: number, error: string) => { req.resume(); res.status(status).json({ error }); };
    if (!slot) return refuse(404, "Emplacement d'image inconnu.");
    const user = await optionalUser(req);
    if (!user) return refuse(401, "Connectez-vous pour modifier votre boutique.");
    if (user.role !== "vendor") return refuse(403, "Seuls les vendeurs peuvent modifier l'image d'une boutique.");
    try {
      await requireEditableShop(user.id);
    } catch (error) {
      return refuse(403, error instanceof TRPCError ? error.message : "Boutique introuvable.");
    }
    const declared = Number(req.headers["content-length"]);
    try {
      const stored = await storeUpload(req, "image", Number.isFinite(declared) ? declared : undefined, SHOP_IMAGE_LIMITS);
      const saved = await saveShopImage(user.id, slot, stored.storageKey);
      res.status(201).json(saved);
    } catch (error) {
      if (error instanceof UploadError) {
        if (!req.complete) req.resume();
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof TRPCError) {
        res.status(403).json({ error: error.message });
        return;
      }
      console.error("[Media] Échec de l'envoi de l'image de boutique :", error);
      res.status(500).json({ error: "L'image n'a pas pu être enregistrée. Réessayez." });
    }
  });

  /**
   * Logo d'une demande de devis néon : corps brut = l'image, `?shop=<slug de l'atelier>`.
   * Réservé aux comptes Client ; même validation que les photos produits (format et taille réels du fichier).
   */
  app.post("/api/neon/quote-logo", async (req: Request, res: Response) => {
    const refuse = (status: number, error: string) => { req.resume(); res.status(status).json({ error }); };
    const user = await optionalUser(req);
    if (!user) return refuse(401, "Connectez-vous avec un compte Client pour envoyer votre logo.");
    if (user.role !== "user") return refuse(403, "L'envoi d'un logo pour un devis est réservé aux comptes Client.");
    const shopSlug = typeof req.query.shop === "string" ? req.query.shop.slice(0, 191) : "";
    let shopId: number;
    try {
      shopId = (await requireNeonShop(shopSlug)).id;
    } catch {
      return refuse(400, "Cet atelier ne propose pas le néon personnalisé.");
    }
    if ((await countUnattachedMedia(user.id)) >= MAX_UNATTACHED_UPLOADS) return refuse(429, "Trop de fichiers envoyés récemment. Réessayez plus tard.");

    const declared = Number(req.headers["content-length"]);
    let stored: Awaited<ReturnType<typeof storeUpload>> | undefined;
    try {
      stored = await storeUpload(req, "image", Number.isFinite(declared) ? declared : undefined);
      const originalName = typeof req.query.name === "string" ? req.query.name.replace(/[^A-Za-z0-9À-ÿ ._-]/g, "").slice(0, 191) : null;
      const record = await createMediaRecord({ ownerUserId: user.id, shopId, kind: "image", originalName, ...stored });
      res.status(201).json(record);
    } catch (error) {
      if (stored) deleteStoredFile(stored.storageKey);
      if (error instanceof UploadError) {
        if (!req.complete) req.resume();
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error("[Media] Échec de l'envoi du logo :", error);
      res.status(500).json({ error: "Le fichier n'a pas pu être enregistré." });
    }
  });

  /** Lecture d'un fichier : public si le produit est publié, sinon réservé au propriétaire et à l'administration. */
  app.get("/media/:key", async (req: Request, res: Response) => {
    const key = req.params.key;
    const fullPath = isValidStorageKey(key) ? resolveStoragePath(key) : null;
    if (!fullPath) {
      res.status(404).send("Fichier introuvable");
      return;
    }
    // Fichier de produit (table media), sinon logo / couverture de boutique (publics si la boutique est active)
    const info = (await getMediaAccessInfo(key).catch(() => null)) ?? (await getShopImageAccess(key).catch(() => null))
      // Photo d'avis client (A-10c) : publique seulement si l'avis est publié et la photo non masquée
      ?? (await getReviewPhotoAccess(key).catch(() => null));
    if (!info || !fs.existsSync(fullPath)) {
      res.status(404).send("Fichier introuvable");
      return;
    }
    if (!info.isPublic) {
      const user = await optionalUser(req);
      // Logo d'une demande de devis néon : visible aussi par le vendeur de l'atelier destinataire
      const quoteVendor = user?.role === "vendor" && "id" in info && typeof info.id === "number" ? await canVendorViewQuoteLogo(user.id, info.id) : false;
      if (!user || (user.id !== info.ownerUserId && user.role !== "admin" && !quoteVendor)) {
        res.status(404).send("Fichier introuvable");
        return;
      }
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", info.mimeType);
    // Cache court : un produit dépublié ou supprimé ne doit pas rester longtemps visible en cache
    res.setHeader("Cache-Control", info.isPublic ? "public, max-age=300" : "private, no-store");
    // sendFile gère les requêtes partielles (Range), nécessaires à la lecture vidéo
    res.sendFile(key, { root: UPLOAD_ROOT, dotfiles: "deny", headers: { "Content-Type": info.mimeType } });
  });
}
