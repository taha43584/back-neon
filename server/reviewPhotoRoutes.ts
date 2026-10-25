import type { Express, Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { UploadError } from "./mediaStorage";
import { cleanupPendingReviewPhotos, storeReviewPhoto } from "./customerReviews";

/**
 * Photos d'avis (A-10c) : POST /api/review-uploads, corps brut = l'image.
 * Réservé à un client connecté ; même validation que les photos produits (type réel du fichier, 8 Mo).
 * La photo reste privée (visible par son auteur et l'admin) jusqu'à la publication de l'avis.
 * Les photos jamais rattachées à un avis sont supprimées après 24 h : à chaque envoi, au démarrage, puis toutes les heures.
 */
export function registerReviewPhotoRoutes(app: Express) {
  app.post("/api/review-uploads", async (req: Request, res: Response) => {
    const refuse = (status: number, error: string) => { if (!req.complete) req.resume(); res.status(status).json({ error }); };
    const user = await sdk.authenticateRequest(req).catch(() => null);
    if (!user) return refuse(401, "Connectez-vous pour ajouter des photos à votre avis.");
    if (user.role !== "user") return refuse(403, "Seuls les clients peuvent ajouter des photos à un avis.");
    const declared = Number(req.headers["content-length"]);
    try {
      res.status(201).json(await storeReviewPhoto(user.id, req, Number.isFinite(declared) ? declared : undefined));
    } catch (error) {
      if (error instanceof UploadError) return refuse(error.status, error.message);
      const status = (error as { status?: number }).status;
      if (status === 429) return refuse(429, (error as Error).message);
      console.error("[Avis] Échec de l'envoi d'une photo :", error);
      refuse(500, "La photo n'a pas pu être enregistrée.");
    }
  });

  const cleanup = () => cleanupPendingReviewPhotos()
    .then((removed) => removed && console.log(`[Avis] ${removed} photo(s) d'avis non utilisée(s) depuis plus de 24 h supprimée(s).`))
    .catch((error) => console.warn("[Avis] Nettoyage des photos d'avis impossible :", error));
  void cleanup();
  setInterval(cleanup, 60 * 60 * 1000).unref();
}
