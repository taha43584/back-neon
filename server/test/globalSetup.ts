import { spawnSync } from "child_process";
import mysql from "mysql2/promise";
import { applyMigrations } from "../migrations";
import { databaseNameOf } from "../testDbGuard";
import { cleanupTestData } from "./cleanupTestData";
import { PROJECT_ROOT, resolveTestDatabaseUrl, TEST_UPLOAD_DIR } from "./testEnv";

/**
 * Avant la suite : prépare la base de TEST (création si besoin, schéma Drizzle si elle est vide,
 * migrations idempotentes) puis retire les restes d'une exécution interrompue.
 * Après la suite (même en cas d'échec ou de délai dépassé) : supprime tout ce qui est en @elegancedeco.test.
 */

async function prepareTestDatabase(url: string) {
  const name = databaseNameOf(url);
  const server = new URL(url);
  server.pathname = "/";
  const conn = await mysql.createConnection(server.toString());
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    const [rows] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'", [name]);
    if (Number((rows as Array<{ n: number }>)[0].n) === 0) {
      // Base vide : tables de base depuis drizzle/schema.ts (uniquement sur la base de test)
      const push = spawnSync("npx", ["drizzle-kit", "push"], { cwd: PROJECT_ROOT, env: { ...process.env, DATABASE_URL: url }, shell: true, encoding: "utf8" });
      if (push.status !== 0) throw new Error(`[Tests] Création du schéma de test impossible : ${push.stderr || push.stdout}`);
    }
  } finally {
    await conn.end();
  }
  await applyMigrations(url);
}

export default async function setup() {
  const url = resolveTestDatabaseUrl();
  await prepareTestDatabase(url);
  const leftovers = await cleanupTestData(url, TEST_UPLOAD_DIR);
  if (leftovers.users) console.log("[Tests] Restes d'une exécution précédente supprimés :", leftovers);

  return async function teardown() {
    const removed = await cleanupTestData(url, TEST_UPLOAD_DIR);
    console.log(`[Tests] Nettoyage final de ${databaseNameOf(url)} :`, removed);
  };
}
