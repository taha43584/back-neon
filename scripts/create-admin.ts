import "dotenv/config";
import readline from "readline";
import { ensureDatabaseConnection } from "../server/dbConnection";
import { createOrUpdateAdminUser } from "../server/db";

async function promptPassword(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question("Entrez le mot de passe pour l'administrateur (min 8 caractères) : ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  await ensureDatabaseConnection();

  let targetEmail = "admin@elegancedeco.tn";
  let password = process.env.ADMIN_PASSWORD;

  const arg1 = process.argv[2];
  const arg2 = process.argv[3];

  if (arg1 && arg1.includes("@")) {
    targetEmail = arg1;
    if (arg2) password = arg2;
  } else if (arg1 && !arg1.includes("@")) {
    password = arg1;
  }

  if (!password) {
    if (process.stdin.isTTY) {
      password = await promptPassword();
    } else {
      console.error("Erreur : Aucun mot de passe fourni.");
      console.error("Usage : pnpm admin:create <mot-de-passe>");
      console.error("Ou :    pnpm admin:create admin@elegancedeco.tn <mot-de-passe>");
      console.error("Ou :    ADMIN_PASSWORD=mon_mot_de_passe pnpm admin:create");
      process.exit(1);
    }
  }

  if (password.length < 8) {
    console.error("Erreur : Le mot de passe doit comporter au moins 8 caractères.");
    process.exit(1);
  }

  console.log(`Initialisation / mise à jour du compte administrateur : ${targetEmail}...`);
  const result = await createOrUpdateAdminUser({
    email: targetEmail,
    password,
    name: "Administrateur Elegance Deco",
  });

  if (result.created) {
    console.log(`✓ Compte administrateur créé avec succès !`);
  } else {
    console.log(`✓ Compte administrateur existant mis à jour avec succès !`);
  }
  console.log(`  - ID : ${result.user.id}`);
  console.log(`  - Email : ${result.user.email}`);
  console.log(`  - Rôle : ${result.user.role}`);
  console.log(`  - Hash bcrypt généré et stocké dans users.passwordHash`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Échec de la configuration de l'administrateur :", err);
  process.exit(1);
});
