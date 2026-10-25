import type { Express } from "express";
import fs from "fs";
import path from "path";
import { ENV } from "./env";

/**
 * Les visuels du catalogue éditorial (`/manus-storage/...`) sont hébergés sur le stockage
 * cloud Manus (Forge). Sans BUILT_IN_FORGE_API_URL / KEY (cas du développement local),
 * le proxy sert une copie locale si elle a été déposée dans storage/manus-assets/,
 * sinon une image neutre « Image indisponible » avec un statut 404 (au lieu d'une erreur 500).
 */
const LEGACY_ASSETS_DIR = path.resolve(process.cwd(), "storage", "manus-assets");
const LEGACY_KEY = /^[A-Za-z0-9._-]{1,200}$/;
const LEGACY_TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800"><rect width="800" height="800" fill="#f3ede7"/><g fill="none" stroke="#c9b5a5" stroke-width="10"><rect x="290" y="300" width="220" height="170" rx="18"/><circle cx="350" cy="355" r="22"/><path d="M300 450l70-70 50 50 40-35 50 55"/></g><text x="400" y="540" font-family="Georgia, serif" font-size="30" fill="#9a8b81" text-anchor="middle">Image indisponible</text></svg>`;

let warned = false;

export function registerStorageProxy(app: Express) {
  app.get("/manus-storage/*", async (req, res) => {
    const key = (req.params as Record<string, string>)[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }

    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      if (!warned) {
        warned = true;
        console.warn(`[StorageProxy] Stockage Manus non configuré : les visuels /manus-storage sont servis depuis ${LEGACY_ASSETS_DIR} s'ils y sont déposés, sinon une image neutre est affichée.`);
      }
      const ext = path.extname(key).toLowerCase();
      if (LEGACY_KEY.test(key) && LEGACY_TYPES[ext]) {
        const local = path.resolve(LEGACY_ASSETS_DIR, key);
        if (path.dirname(local) === LEGACY_ASSETS_DIR && fs.existsSync(local)) {
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.sendFile(key, { root: LEGACY_ASSETS_DIR, headers: { "Content-Type": LEGACY_TYPES[ext], "Cache-Control": "public, max-age=3600" } });
          return;
        }
      }
      res.status(404).set({ "Content-Type": "image/svg+xml", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).send(PLACEHOLDER_SVG);
      return;
    }

    try {
      const forgeUrl = new URL(
        "v1/storage/presign/get",
        ENV.forgeApiUrl.replace(/\/+$/, "") + "/",
      );
      forgeUrl.searchParams.set("path", key);

      const forgeResp = await fetch(forgeUrl, {
        headers: { Authorization: `Bearer ${ENV.forgeApiKey}` },
      });

      if (!forgeResp.ok) {
        const body = await forgeResp.text().catch(() => "");
        console.error(`[StorageProxy] forge error: ${forgeResp.status} ${body}`);
        res.status(502).send("Storage backend error");
        return;
      }

      const { url } = (await forgeResp.json()) as { url: string };
      if (!url) {
        res.status(502).send("Empty signed URL from backend");
        return;
      }

      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}
