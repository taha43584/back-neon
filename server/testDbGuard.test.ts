import { describe, expect, it } from "vitest";
import { assertTestSafeDatabase, databaseNameOf } from "./testDbGuard";
import { resolveTestDatabaseUrl } from "./test/testEnv";
import { getDb } from "./db";

/** Les tests ne peuvent jamais viser la base réelle. */
describe("Garde-fou de la base de test", () => {
  const REAL = "mysql://root:@localhost:3306/elegance_deco";
  const TEST = "mysql://root:@localhost:3306/elegance_deco_test";

  it("sans DATABASE_URL_TEST, les tests refusent de démarrer (aucun repli sur DATABASE_URL)", () => {
    expect(() => resolveTestDatabaseUrl({}, { DATABASE_URL: REAL })).toThrow("DATABASE_URL_TEST n'est pas définie");
  });

  it("refuse une DATABASE_URL_TEST qui n'est pas une base *_test ou qui est la base réelle", () => {
    expect(() => resolveTestDatabaseUrl({ DATABASE_URL_TEST: REAL }, { DATABASE_URL: REAL })).toThrow("_test");
    expect(() => resolveTestDatabaseUrl({}, { DATABASE_URL_TEST: TEST, DATABASE_URL: TEST })).toThrow("même base");
    expect(resolveTestDatabaseUrl({}, { DATABASE_URL_TEST: TEST, DATABASE_URL: REAL })).toBe(TEST);
  });

  it("pendant les tests, toute connexion à une base non *_test est refusée", () => {
    expect(databaseNameOf(REAL)).toBe("elegance_deco");
    expect(() => assertTestSafeDatabase(REAL)).toThrow("Accès refusé");
    expect(() => assertTestSafeDatabase("")).toThrow("Accès refusé");
    expect(() => assertTestSafeDatabase(TEST)).not.toThrow();
  });

  it("la base utilisée par le code pendant les tests est la base de test", async () => {
    expect(databaseNameOf(process.env.DATABASE_URL)).toMatch(/_test$/);
    expect(await getDb()).not.toBeNull();
  });
});
