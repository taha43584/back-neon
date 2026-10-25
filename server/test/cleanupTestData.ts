import fs from "fs";
import path from "path";
import mysql from "mysql2/promise";
import { databaseNameOf, TEST_DATABASE_SUFFIX } from "../testDbGuard";

/**
 * Supprime de la base de TEST tout ce qui appartient aux comptes @elegancedeco.test
 * (boutiques, produits, commandes, médias et leurs fichiers, conversations, favoris…).
 * Refuse de s'exécuter sur une base qui n'est pas *_test.
 */

const TEST_EMAILS = "%@elegancedeco.test";

export async function cleanupTestData(databaseUrl: string, uploadDir: string) {
  const name = databaseNameOf(databaseUrl);
  if (!name.endsWith(TEST_DATABASE_SUFFIX)) throw new Error(`[Tests] Nettoyage refusé sur la base « ${name} » (pas une base de test).`);

  const c = await mysql.createConnection(databaseUrl);
  const ids = async (query: string, params: unknown[] = []) => ((await c.query(query, params))[0] as Array<{ id: number }>).map((r) => r.id);
  const del = async (table: string, where: string, params: unknown[]) => ((await c.query(`DELETE FROM \`${table}\` WHERE ${where}`, params))[0] as { affectedRows: number }).affectedRows;
  const removeFile = (key: string | null | undefined) => {
    if (!key) return;
    const file = path.resolve(uploadDir, key);
    if (file.startsWith(path.resolve(uploadDir) + path.sep)) fs.rmSync(file, { force: true });
  };

  try {
    const userIds = await ids("SELECT id FROM users WHERE email LIKE ?", [TEST_EMAILS]);
    if (!userIds.length) return { users: 0 };
    const shopIds = await ids("SELECT id FROM shops WHERE userId IN (?)", [userIds]);
    const S = shopIds.length ? shopIds : [0];
    const productIds = await ids("SELECT id FROM products WHERE shopId IN (?)", [S]);
    const P = productIds.length ? productIds : [0];
    const orderIds = await ids("SELECT id FROM orders WHERE userId IN (?) UNION SELECT orderId AS id FROM order_items WHERE shopId IN (?)", [userIds, S]);
    const O = orderIds.length ? orderIds : [0];
    const conversationIds = await ids("SELECT id FROM conversations WHERE clientId IN (?) OR vendorId IN (?) OR shopId IN (?)", [userIds, userIds, S]);

    const counts: Record<string, number> = {};
    // A-10c : photos (et leurs fichiers), votes et signalements des avis de test, ou faits par des comptes de test
    const [reviewTables] = await c.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('review_photos', 'review_votes', 'review_reports')");
    if ((reviewTables as unknown[]).length === 3) {
      const testReviews = "SELECT id FROM reviews WHERE orderId IN (?) OR userId IN (?) OR productId IN (?)";
      const [photoRows] = await c.query(`SELECT id, storageKey FROM review_photos WHERE ownerUserId IN (?) OR reviewId IN (${testReviews})`, [userIds, O, userIds, P]);
      for (const p of photoRows as Array<{ storageKey: string }>) removeFile(p.storageKey);
      counts.review_photos = (photoRows as unknown[]).length ? await del("review_photos", "id IN (?)", [(photoRows as Array<{ id: number }>).map((p) => p.id)]) : 0;
      counts.review_votes = await del("review_votes", `userId IN (?) OR reviewId IN (${testReviews})`, [userIds, O, userIds, P]);
      counts.review_reports = await del("review_reports", `userId IN (?) OR reviewId IN (${testReviews})`, [userIds, O, userIds, P]);
    }
    counts.reviews = await del("reviews", "orderId IN (?) OR userId IN (?) OR productId IN (?)", [O, userIds, P]);
    counts.order_status_history = await del("order_status_history", "orderId IN (?)", [O]);
    counts.order_items = await del("order_items", "orderId IN (?)", [O]);
    counts.commissions = await del("commissions", "orderId IN (?) OR shopId IN (?)", [O, S]);
    counts.orders = await del("orders", "id IN (?)", [O]);
    if (conversationIds.length) {
      counts.messages = await del("messages", "conversationId IN (?)", [conversationIds]);
      counts.conversations = await del("conversations", "id IN (?)", [conversationIds]);
    }
    counts.neon_quote_requests = await del("neon_quote_requests", "userId IN (?) OR shopId IN (?)", [userIds, S]);
    counts.neon_offers = await del("neon_offers", "shopId IN (?)", [S]);
    const [mediaRows] = await c.query("SELECT id, storageKey FROM media WHERE ownerUserId IN (?) OR shopId IN (?) OR productId IN (?)", [userIds, S, P]);
    for (const m of mediaRows as Array<{ storageKey: string }>) removeFile(m.storageKey);
    counts.media = (mediaRows as unknown[]).length ? await del("media", "id IN (?)", [(mediaRows as Array<{ id: number }>).map((m) => m.id)]) : 0;
    counts.cart_items = await del("cart_items", "userId IN (?) OR productId IN (?)", [userIds, P]);
    counts.favorite_products = await del("favorite_products", "userId IN (?) OR productId IN (?)", [userIds, P]);
    counts.followed_shops = await del("followed_shops", "userId IN (?) OR shopId IN (?)", [userIds, S]);
    counts.product_options = await del("product_options", "productId IN (?)", [P]);
    counts.products = await del("products", "id IN (?)", [P]);
    counts.categories = await del("categories", "proposedByShopId IN (?)", [S]);
    counts.shop_categories = await del("shop_categories", "shopId IN (?)", [S]);
    const [shopImages] = await c.query("SELECT logoUrl, coverUrl FROM shops WHERE id IN (?)", [S]);
    for (const row of shopImages as Array<{ logoUrl: string | null; coverUrl: string | null }>) {
      for (const url of [row.logoUrl, row.coverUrl]) removeFile(/^\/media\/([a-z0-9]{24}\.(?:jpg|png|webp))$/.exec(url ?? "")?.[1]);
    }
    counts.shops = await del("shops", "id IN (?)", [S]);
    counts.hidden_site_categories = await del("hidden_site_categories", "hiddenByUserId IN (?)", [userIds]);
    counts.addresses = await del("addresses", "userId IN (?)", [userIds]);
    counts.users = await del("users", "id IN (?)", [userIds]);
    return counts;
  } finally {
    await c.end();
  }
}
