import "dotenv/config";
import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";
import { ensureDatabaseConnection } from "../server/dbConnection";
import { BCRYPT_ROUNDS, normalizeEmail } from "../server/db";
import { passwordField } from "../shared/validation";

/**
 * Réinitialise le mot de passe d'un compte EXISTANT.
 *
 *   npx tsx scripts/reset-password.ts <email> <nouveauMotDePasse>
 *
 * - Modifie UNIQUEMENT users.passwordHash (bcrypt, même coût que le site : BCRYPT_ROUNDS).
 * - Ne change ni le rôle, ni le statut, ni la boutique, ni aucune autre colonne
 *   (updatedAt est volontairement conservé tel quel).
 * - Refuse si l'email n'existe pas : ne crée JAMAIS de compte.
 * - Vérifie après coup que seule la colonne passwordHash a changé ; sinon tout est annulé.
 */

type UserRow = Record<string, unknown> & { id: number; email: string | null; role: string; passwordHash: string | null };

const show = (label: string, u: UserRow, shop: Record<string, unknown> | undefined) =>
  console.log(`${label} : id=${u.id} · email=${u.email} · rôle=${u.role} · suspendu=${u.suspended ? "oui" : "non"}${shop ? ` · boutique #${shop.id} « ${shop.name} » (${shop.status})` : " · aucune boutique"}`);

async function main() {
  const [rawEmail, newPassword] = process.argv.slice(2);
  if (!rawEmail || !newPassword) {
    console.error("Usage : npx tsx scripts/reset-password.ts <email> <nouveauMotDePasse>");
    process.exit(1);
  }
  // Même règle que l'inscription : 8 à 128 caractères, au moins une lettre et un chiffre
  const check = passwordField.safeParse(newPassword);
  if (!check.success) {
    console.error(`Mot de passe refusé : ${check.error.issues[0]?.message ?? "invalide"}`);
    process.exit(1);
  }
  const email = normalizeEmail(rawEmail);

  await ensureDatabaseConnection({ skipSchemaCheck: true });
  const conn = await mysql.createConnection(process.env.DATABASE_URL ?? "mysql://root:@localhost:3306/elegance_deco");
  try {
    await conn.beginTransaction();
    // Verrou de la ligne le temps de la mise à jour
    const [found] = await conn.query("SELECT * FROM users WHERE email = ? FOR UPDATE", [email]);
    const matches = found as UserRow[];
    if (matches.length === 0) {
      await conn.rollback();
      console.error(`Aucun compte avec l'email « ${email} ». Rien n'a été modifié (aucun compte n'est créé).`);
      process.exit(1);
    }
    if (matches.length > 1) {
      await conn.rollback();
      console.error(`${matches.length} comptes ont l'email « ${email} ». Opération annulée par sécurité.`);
      process.exit(1);
    }
    const before = matches[0];
    const [shopRows] = await conn.query("SELECT * FROM shops WHERE userId = ?", [before.id]);
    const shopBefore = (shopRows as Array<Record<string, unknown>>)[0];
    show("AVANT", before, shopBefore);

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    // `updatedAt = updatedAt` : empêche la mise à jour automatique (ON UPDATE CURRENT_TIMESTAMP)
    const [result] = await conn.query("UPDATE users SET passwordHash = ?, updatedAt = updatedAt WHERE id = ?", [passwordHash, before.id]);
    if ((result as { affectedRows: number }).affectedRows !== 1) throw new Error("La mise à jour n'a pas touché exactement un compte");

    // Preuve : toutes les colonnes sauf passwordHash sont identiques, la boutique aussi
    const [afterRows] = await conn.query("SELECT * FROM users WHERE id = ?", [before.id]);
    const after = (afterRows as UserRow[])[0];
    const [shopAfterRows] = await conn.query("SELECT * FROM shops WHERE userId = ?", [before.id]);
    const shopAfter = (shopAfterRows as Array<Record<string, unknown>>)[0];
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const changed = Object.keys(before).filter((key) => key !== "passwordHash" && !same(before[key], after[key]));
    if (changed.length) throw new Error(`Colonnes modifiées de façon inattendue : ${changed.join(", ")}`);
    if (!same(shopBefore, shopAfter)) throw new Error("La boutique a été modifiée de façon inattendue");
    if (!(await bcrypt.compare(newPassword, after.passwordHash ?? ""))) throw new Error("Le nouveau mot de passe ne correspond pas au hash enregistré");
    if (bcrypt.getRounds(after.passwordHash!) !== BCRYPT_ROUNDS) throw new Error("Coût bcrypt inattendu");

    await conn.commit();
    show("APRÈS", after, shopAfter);
    console.log(`Mot de passe mis à jour (bcrypt, coût ${BCRYPT_ROUNDS}). Seule la colonne passwordHash a changé.`);
  } catch (error) {
    await conn.rollback().catch(() => {});
    console.error("Échec, aucune modification enregistrée :", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((error) => {
  console.error("Échec :", error);
  process.exit(1);
});
