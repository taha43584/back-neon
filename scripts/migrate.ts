import "dotenv/config";
import { ensureDatabaseConnection } from "../server/dbConnection";
import { applyMigrations } from "../server/migrations";

async function main() {
  // Démarre MySQL si besoin, sans exiger que le nouveau schéma soit déjà présent
  await ensureDatabaseConnection({ skipSchemaCheck: true });
  const applied = await applyMigrations();
  console.log(applied.length ? `Migrations appliquées :\n - ${applied.join("\n - ")}` : "Base déjà à jour, aucune modification.");
  process.exit(0);
}

main().catch((error) => {
  console.error("Échec de la migration :", error);
  process.exit(1);
});
