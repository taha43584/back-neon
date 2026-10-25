import "dotenv/config";
import mysql from "mysql2/promise";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { assertTestSafeDatabase } from "./testDbGuard";

const MYSQLD_PATH = "C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysqld.exe";
const DATA_DIR = "C:\\Users\\MSI\\mysql_data";
const DEFAULT_URL = "mysql://root:@localhost:3306/elegance_deco";
const STARTUP_TIMEOUT_S = 60;

/** Colonnes indispensables au code actuel (migrations 0009 à 0011 incluses). */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  users: ["id", "openId", "email", "firstName", "lastName", "phone", "city", "address", "passwordHash", "role", "suspended"],
  shops: ["id", "userId", "name", "slug", "phone", "whatsapp", "showWhatsapp", "showPhone", "deliveryInfo", "city", "status", "rejectionReason", "termsAccepted", "termsVersion", "termsAcceptedAt"],
  products: ["id", "shopId", "status", "stock", "promoPriceTnd", "sku", "variants", "availability", "preparationTime", "extraInfo", "videoUrl", "moderationNote"],
  categories: ["id", "name", "slug", "description", "parentId", "status", "active", "proposedByShopId", "sortOrder"],
  order_items: ["id", "orderId", "shopId", "fulfillmentStatus"],
  order_status_history: ["id", "orderId", "toStatus", "changedByRole"],
  marketplace_settings: ["key", "value"],
  media: ["id", "ownerUserId", "productId", "kind", "storageKey", "mimeType", "sizeBytes", "position", "isPrimary"],
  orders: ["id", "userId", "shippingName", "shippingPhone", "shippingAddress", "shippingCity"],
  addresses: ["id", "userId", "isDefault"],
};

function describeError(err: unknown) {
  const e = err as { code?: string; message?: string };
  return e?.code ? `${e.code} — ${e.message}` : String(err);
}

export async function checkMySQLReachable(databaseUrl?: string): Promise<boolean> {
  const url = databaseUrl || process.env.DATABASE_URL || DEFAULT_URL;
  assertTestSafeDatabase(url);
  try {
    const conn = await mysql.createConnection(url);
    await conn.query("SELECT 1;");
    await conn.end();
    return true;
  } catch {
    return false;
  }
}

/** Indique si un mysqld utilise déjà le datadir (fichier .pid d'un processus vivant). */
function isLocalMySQLAlreadyRunning(): boolean {
  try {
    for (const file of fs.readdirSync(DATA_DIR)) {
      if (!file.endsWith(".pid")) continue;
      const pid = Number(fs.readFileSync(path.join(DATA_DIR, file), "utf8").trim());
      if (!pid) continue;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        // processus mort : fichier .pid obsolète
      }
    }
  } catch {
    // datadir illisible
  }
  return false;
}

async function waitForMySQL(seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (await checkMySQLReachable()) return true;
  }
  return false;
}

export async function tryStartLocalMySQL(): Promise<boolean> {
  if (!fs.existsSync(MYSQLD_PATH) || !fs.existsSync(DATA_DIR)) {
    return false;
  }

  // Ne jamais lancer un second mysqld sur le même datadir : il resterait bloqué
  // sur le verrou InnoDB et l'instance principale pourrait être perturbée.
  if (isLocalMySQLAlreadyRunning()) {
    console.log("[Database] Un mysqld utilise déjà le datadir, attente de sa disponibilité...");
    return waitForMySQL(STARTUP_TIMEOUT_S);
  }

  console.log("[Database] Démarrage automatique de MySQL local...");
  try {
    const proc = spawn(MYSQLD_PATH, [`--datadir=${DATA_DIR}`, "--port=3306", "--console"], {
      detached: true,
      stdio: "ignore",
    });
    proc.unref();
  } catch (err) {
    console.warn("[Database] Impossible de démarrer mysqld:", err);
    return false;
  }

  const ready = await waitForMySQL(STARTUP_TIMEOUT_S);
  if (ready) console.log("[Database] MySQL local démarré et prêt à accepter des connexions.");
  return ready;
}

/** Vérifie que les tables/colonnes attendues par le code existent, sans rien modifier. */
export async function verifyDatabaseSchema(): Promise<string[]> {
  const url = process.env.DATABASE_URL || DEFAULT_URL;
  assertTestSafeDatabase(url);
  const conn = await mysql.createConnection(url);
  const missing: string[] = [];
  try {
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      const [rows] = await conn.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [table]);
      const existing = new Set((rows as Array<{ COLUMN_NAME: string }>).map((r) => r.COLUMN_NAME));
      if (existing.size === 0) {
        missing.push(`table ${table}`);
        continue;
      }
      for (const column of columns) {
        if (!existing.has(column)) missing.push(`${table}.${column}`);
      }
    }
  } finally {
    await conn.end();
  }
  return missing;
}

export async function ensureDatabaseConnection(options: { skipSchemaCheck?: boolean } = {}): Promise<void> {
  assertTestSafeDatabase(process.env.DATABASE_URL || DEFAULT_URL);
  let isUp = await checkMySQLReachable();

  if (!isUp) {
    console.warn("[Database] MySQL n'est pas joignable sur le port 3306. Tentative de démarrage...");
    isUp = await tryStartLocalMySQL();
  }

  if (!isUp) {
    let detail = "";
    try {
      const conn = await mysql.createConnection(process.env.DATABASE_URL || DEFAULT_URL);
      await conn.end();
    } catch (err) {
      detail = ` Cause : ${describeError(err)}.`;
    }
    const errorMsg =
      "[Database] ERREUR CRITIQUE: Impossible de se connecter à MySQL (" +
      (process.env.DATABASE_URL || "inconnu") +
      ")." + detail + " Vérifiez que le serveur MySQL est démarré.";
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  console.log("[Database] Connexion MySQL établie avec succès.");
  if (options.skipSchemaCheck) return;

  const missing = await verifyDatabaseSchema();
  if (missing.length) {
    const errorMsg =
      `[Database] Schéma incomplet, éléments manquants : ${missing.join(", ")}. ` +
      "Lancez `npm run db:migrate` (migration additive, sans perte de données).";
    console.error(errorMsg);
    throw new Error(errorMsg);
  }
}
