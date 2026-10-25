import fs from "fs";
import path from "path";
import { parse } from "dotenv";
import { databaseNameOf, TEST_DATABASE_SUFFIX } from "../testDbGuard";

/**
 * Configuration des tests : base de données et dossier de fichiers DÉDIÉS aux tests.
 * Aucun repli sur la base réelle : sans DATABASE_URL_TEST valide, les tests refusent de démarrer.
 */

export const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
/** Fichiers envoyés pendant les tests (jamais le dossier des vrais médias). */
export const TEST_UPLOAD_DIR = path.join(PROJECT_ROOT, "storage", "uploads-test");

function readDotEnv(): Record<string, string> {
  const file = path.join(PROJECT_ROOT, ".env");
  return fs.existsSync(file) ? parse(fs.readFileSync(file)) : {};
}

/** URL de la base de test, vérifiée ; lève une erreur explicite sinon. */
export function resolveTestDatabaseUrl(processEnv: NodeJS.ProcessEnv = process.env, env: Record<string, string> = readDotEnv()): string {
  const url = processEnv.DATABASE_URL_TEST || env.DATABASE_URL_TEST;
  if (!url) {
    throw new Error("[Tests] DATABASE_URL_TEST n'est pas définie dans .env : les tests refusent de démarrer (aucun repli sur la base réelle).");
  }
  const name = databaseNameOf(url);
  if (!name.endsWith(TEST_DATABASE_SUFFIX)) {
    throw new Error(`[Tests] DATABASE_URL_TEST doit viser une base dont le nom se termine par « ${TEST_DATABASE_SUFFIX} » (reçu : « ${name || url} »).`);
  }
  const realName = databaseNameOf(env.DATABASE_URL);
  if (realName && realName === name) {
    throw new Error("[Tests] DATABASE_URL_TEST et DATABASE_URL désignent la même base : refus.");
  }
  return url;
}
