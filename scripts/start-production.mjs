// Démarrage en production (Dockerfile) : attend MySQL, crée les tables si la base est vide,
// applique les migrations additives, puis lance l'API.
// Base vide + ADMIN_EMAIL et ADMIN_PASSWORD définis : le compte administrateur est aussi créé.
import { execSync } from "node:child_process";
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[démarrage] DATABASE_URL est absente : renseignez-la dans les variables d'environnement.");
  process.exit(1);
}

const lancer = (commande, env = {}) => execSync(commande, { stdio: "inherit", env: { ...process.env, ...env } });

// MySQL peut démarrer après le back : jusqu'à 2 minutes d'attente
let connexion;
for (let essai = 0; essai < 60 && !connexion; essai++) {
  try {
    connexion = await mysql.createConnection(url);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
if (!connexion) {
  console.error("[démarrage] MySQL reste injoignable : vérifiez DATABASE_URL et le service de base de données.");
  process.exit(1);
}
const [lignes] = await connexion.query(
  "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'",
);
await connexion.end();
const baseVide = Number(lignes[0].n) === 0;

if (baseVide) {
  console.log("[démarrage] Base vide : création des tables.");
  lancer("npx drizzle-kit push");
}
lancer("npx tsx scripts/migrate.ts");
if (baseVide && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  // Le mot de passe passe par ADMIN_PASSWORD, jamais par la ligne de commande
  lancer(`npx tsx scripts/create-admin.ts "${process.env.ADMIN_EMAIL}"`);
}

await import("../dist/index.js");
