// « npm run dev » : le serveur de DÉVELOPPEMENT utilise UNIQUEMENT la base de test (et le dossier de fichiers de test).
// La base réelle (elegance_deco) est réservée au vrai site local (front/site-local, ports 8080 / 3100).
// Refus de démarrer si l'adresse de la base de test manque ou ne se termine pas par « _test ».
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  (fs.existsSync(path.join(RACINE, ".env")) ? fs.readFileSync(path.join(RACINE, ".env"), "utf8") : "")
    .split(/\r?\n/).filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const url = process.env.DATABASE_URL_TEST || env.DATABASE_URL_TEST || "";
let base = "";
try { base = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, "")); } catch { /* adresse invalide */ }
if (!base.endsWith("_test")) {
  console.error(`\n[dev] REFUS : le serveur de développement ne démarre que sur une base de TEST (nom en « _test »).`);
  console.error(`[dev] DATABASE_URL_TEST ${url ? `vise « ${base || "?"} »` : "est absente de .env"}. La base réelle est réservée au vrai site (site-local).\n`);
  process.exit(1);
}
console.log(`[dev] Base de développement : ${base} (jamais la base réelle) · fichiers : storage/uploads-test`);

const enfant = spawn("npx", ["tsx", "watch", "server/_core/index.ts"], {
  cwd: RACINE, stdio: "inherit", shell: true,
  // Ces valeurs priment sur .env (dotenv ne remplace pas une variable déjà fixée)
  env: { ...process.env, NODE_ENV: "development", DATABASE_URL: url, UPLOAD_DIR: path.join(RACINE, "storage", "uploads-test") },
});
enfant.on("exit", (code) => process.exit(code ?? 0));
