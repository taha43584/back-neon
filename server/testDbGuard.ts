/**
 * Garde-fou des tests : pendant une exécution vitest, aucune connexion n'est permise vers une base
 * dont le nom ne se termine pas par « _test » (jamais de repli sur la base réelle).
 * Hors tests, ces fonctions ne font rien.
 */

export const TEST_DATABASE_SUFFIX = "_test";

/** Nom de la base dans une URL mysql://… (chaîne vide si l'URL est invalide). */
export function databaseNameOf(url: string | undefined | null): string {
  if (!url) return "";
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ""));
  } catch {
    return "";
  }
}

export function isTestRun() {
  return Boolean(process.env.VITEST);
}

/** Pendant les tests : lève une erreur si `url` ne vise pas une base *_test. */
export function assertTestSafeDatabase(url: string | undefined | null) {
  if (!isTestRun()) return;
  const name = databaseNameOf(url);
  if (!name.endsWith(TEST_DATABASE_SUFFIX)) {
    throw new Error(
      `[Tests] Accès refusé à la base « ${name || "inconnue"} » : les tests n'utilisent que DATABASE_URL_TEST (base *${TEST_DATABASE_SUFFIX}).`,
    );
  }
}
