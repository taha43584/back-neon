import mysql from "mysql2/promise";
import { assertTestSafeDatabase } from "./testDbGuard";
import { authorDisplayNameOf, isCustomLine, purchasedVariantOf, type PurchasedLine } from "../shared/reviewRules";
import { splitCity } from "../shared/tunisia";

/**
 * Migrations additives et idempotentes : chaque étape vérifie l'état réel de la base
 * avant d'agir. Rien n'est jamais supprimé ni réinitialisé.
 * (Le journal drizzle-kit n'est pas synchronisé avec cette base : ne pas utiliser `db:push`.)
 */

type Column = { table: string; name: string; ddl: string };

const COLUMNS: Column[] = [
  { table: "categories", name: "parentId", ddl: "ADD COLUMN `parentId` int NULL AFTER `slug`" },
  { table: "categories", name: "status", ddl: "ADD COLUMN `status` enum('approved','pending','rejected') NOT NULL DEFAULT 'approved' AFTER `parentId`" },
  { table: "categories", name: "proposedByShopId", ddl: "ADD COLUMN `proposedByShopId` int NULL AFTER `status`" },
  { table: "categories", name: "sortOrder", ddl: "ADD COLUMN `sortOrder` int NOT NULL DEFAULT 0 AFTER `proposedByShopId`" },
  { table: "products", name: "promoPriceTnd", ddl: "ADD COLUMN `promoPriceTnd` decimal(10,2) NULL AFTER `customization`" },
  { table: "products", name: "sku", ddl: "ADD COLUMN `sku` varchar(64) NULL AFTER `promoPriceTnd`" },
  { table: "products", name: "variants", ddl: "ADD COLUMN `variants` text NULL AFTER `sku`" },
  { table: "products", name: "availability", ddl: "ADD COLUMN `availability` enum('in_stock','made_to_order','out_of_stock') NOT NULL DEFAULT 'in_stock' AFTER `variants`" },
  { table: "products", name: "preparationTime", ddl: "ADD COLUMN `preparationTime` varchar(128) NULL AFTER `availability`" },
  { table: "products", name: "extraInfo", ddl: "ADD COLUMN `extraInfo` text NULL AFTER `preparationTime`" },
  { table: "products", name: "videoUrl", ddl: "ADD COLUMN `videoUrl` varchar(500) NULL AFTER `extraInfo`" },
  // 0013 : console d'administration
  { table: "products", name: "moderationNote", ddl: "ADD COLUMN `moderationNote` text NULL AFTER `videoUrl`" },
  { table: "categories", name: "description", ddl: "ADD COLUMN `description` text NULL AFTER `slug`" },
  { table: "categories", name: "active", ddl: "ADD COLUMN `active` int NOT NULL DEFAULT 1 AFTER `status`" },
  { table: "shops", name: "showWhatsapp", ddl: "ADD COLUMN `showWhatsapp` int NOT NULL DEFAULT 0 AFTER `whatsapp`" },
  { table: "shops", name: "showPhone", ddl: "ADD COLUMN `showPhone` int NOT NULL DEFAULT 0 AFTER `showWhatsapp`" },
  { table: "shops", name: "deliveryInfo", ddl: "ADD COLUMN `deliveryInfo` text NULL AFTER `openingHours`" },
  { table: "order_items", name: "fulfillmentStatus", ddl: "ADD COLUMN `fulfillmentStatus` enum('pending','processing','shipped','delivered','cancelled') NOT NULL DEFAULT 'pending' AFTER `personalization`" },
  // 0015 : prix sur mesure (les produits existants reçoivent pricingMode = 'fixed' et gardent leur prix)
  { table: "products", name: "pricingMode", ddl: "ADD COLUMN `pricingMode` enum('fixed','per_m2','per_linear_m') NOT NULL DEFAULT 'fixed' AFTER `promoPriceTnd`" },
  { table: "products", name: "unitPriceTnd", ddl: "ADD COLUMN `unitPriceTnd` decimal(10,3) NULL AFTER `pricingMode`" },
  { table: "products", name: "minWidthCm", ddl: "ADD COLUMN `minWidthCm` int NULL AFTER `unitPriceTnd`" },
  { table: "products", name: "maxWidthCm", ddl: "ADD COLUMN `maxWidthCm` int NULL AFTER `minWidthCm`" },
  { table: "products", name: "minHeightCm", ddl: "ADD COLUMN `minHeightCm` int NULL AFTER `maxWidthCm`" },
  { table: "products", name: "maxHeightCm", ddl: "ADD COLUMN `maxHeightCm` int NULL AFTER `minHeightCm`" },
  { table: "products", name: "minBillableArea", ddl: "ADD COLUMN `minBillableArea` decimal(8,3) NULL AFTER `maxHeightCm`" },
  { table: "products", name: "minPriceTnd", ddl: "ADD COLUMN `minPriceTnd` decimal(10,3) NULL AFTER `minBillableArea`" },
  { table: "products", name: "promoPercent", ddl: "ADD COLUMN `promoPercent` decimal(5,2) NULL AFTER `minPriceTnd`" },
  { table: "order_items", name: "pricingMode", ddl: "ADD COLUMN `pricingMode` varchar(16) NULL AFTER `personalization`" },
  { table: "order_items", name: "widthCm", ddl: "ADD COLUMN `widthCm` int NULL AFTER `pricingMode`" },
  { table: "order_items", name: "heightCm", ddl: "ADD COLUMN `heightCm` int NULL AFTER `widthCm`" },
  { table: "order_items", name: "areaM2", ddl: "ADD COLUMN `areaM2` decimal(10,4) NULL AFTER `heightCm`" },
  { table: "order_items", name: "billedAreaM2", ddl: "ADD COLUMN `billedAreaM2` decimal(10,4) NULL AFTER `areaM2`" },
  { table: "order_items", name: "appliedUnitPriceTnd", ddl: "ADD COLUMN `appliedUnitPriceTnd` decimal(10,3) NULL AFTER `billedAreaM2`" },
  { table: "order_items", name: "optionsJson", ddl: "ADD COLUMN `optionsJson` text NULL AFTER `appliedUnitPriceTnd`" },
  { table: "order_items", name: "lineTotalTnd", ddl: "ADD COLUMN `lineTotalTnd` decimal(10,2) NULL AFTER `optionsJson`" },
  // 0017 : néon personnalisé — copie FIGÉE de la ligne au moment de la commande
  { table: "order_items", name: "neonText", ddl: "ADD COLUMN `neonText` varchar(255) NULL AFTER `lineTotalTnd`" },
  { table: "order_items", name: "neonScript", ddl: "ADD COLUMN `neonScript` varchar(8) NULL AFTER `neonText`" },
  { table: "order_items", name: "neonFont", ddl: "ADD COLUMN `neonFont` varchar(32) NULL AFTER `neonScript`" },
  { table: "order_items", name: "neonColorName", ddl: "ADD COLUMN `neonColorName` varchar(32) NULL AFTER `neonFont`" },
  { table: "order_items", name: "neonColorHex", ddl: "ADD COLUMN `neonColorHex` varchar(7) NULL AFTER `neonColorName`" },
  { table: "order_items", name: "neonSize", ddl: "ADD COLUMN `neonSize` varchar(8) NULL AFTER `neonColorHex`" },
  { table: "order_items", name: "neonSupport", ddl: "ADD COLUMN `neonSupport` varchar(16) NULL AFTER `neonSize`" },
  { table: "order_items", name: "neonOutdoor", ddl: "ADD COLUMN `neonOutdoor` int NULL AFTER `neonSupport`" },
  { table: "order_items", name: "neonDetailsJson", ddl: "ADD COLUMN `neonDetailsJson` text NULL AFTER `neonOutdoor`" },
  // A-10c : avis clients avec photos (colonnes NULL ou avec défaut : avis existants et site React inchangés)
  { table: "reviews", name: "orderItemId", ddl: "ADD COLUMN `orderItemId` int NULL AFTER `orderId`" },
  { table: "reviews", name: "qualityRating", ddl: "ADD COLUMN `qualityRating` tinyint NULL AFTER `rating`" },
  { table: "reviews", name: "conformityRating", ddl: "ADD COLUMN `conformityRating` tinyint NULL AFTER `qualityRating`" },
  { table: "reviews", name: "deliveryRating", ddl: "ADD COLUMN `deliveryRating` tinyint NULL AFTER `conformityRating`" },
  { table: "reviews", name: "purchasedVariant", ddl: "ADD COLUMN `purchasedVariant` varchar(255) NULL AFTER `deliveryRating`" },
  { table: "reviews", name: "isCustom", ddl: "ADD COLUMN `isCustom` int NOT NULL DEFAULT 0 AFTER `purchasedVariant`" },
  { table: "reviews", name: "authorDisplayName", ddl: "ADD COLUMN `authorDisplayName` varchar(64) NULL AFTER `isCustom`" },
  { table: "reviews", name: "authorGovernorate", ddl: "ADD COLUMN `authorGovernorate` varchar(64) NULL AFTER `authorDisplayName`" },
  { table: "reviews", name: "vendorReply", ddl: "ADD COLUMN `vendorReply` text NULL AFTER `body`" },
  { table: "reviews", name: "vendorReplyAt", ddl: "ADD COLUMN `vendorReplyAt` timestamp NULL AFTER `vendorReply`" },
  { table: "reviews", name: "vendorReplyUserId", ddl: "ADD COLUMN `vendorReplyUserId` int NULL AFTER `vendorReplyAt`" },
];

// A-10c : photos, votes « Utile » et signalements des avis
const CREATE_REVIEW_PHOTOS = `CREATE TABLE IF NOT EXISTS \`review_photos\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`reviewId\` int NULL,
  \`ownerUserId\` int NOT NULL,
  \`storageKey\` varchar(191) NOT NULL,
  \`mimeType\` varchar(64) NOT NULL,
  \`sizeBytes\` int NOT NULL,
  \`position\` int NOT NULL DEFAULT 0,
  \`hiddenAt\` timestamp NULL,
  \`hiddenByUserId\` int NULL,
  \`createdAt\` timestamp NOT NULL DEFAULT (now()),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`review_photos_storage_key\` (\`storageKey\`),
  KEY \`review_photos_review\` (\`reviewId\`),
  KEY \`review_photos_owner\` (\`ownerUserId\`, \`reviewId\`),
  CONSTRAINT \`review_photos_review_fk\` FOREIGN KEY (\`reviewId\`) REFERENCES \`reviews\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const CREATE_REVIEW_VOTES = `CREATE TABLE IF NOT EXISTS \`review_votes\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`reviewId\` int NOT NULL,
  \`userId\` int NOT NULL,
  \`createdAt\` timestamp NOT NULL DEFAULT (now()),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`review_votes_unique\` (\`reviewId\`, \`userId\`),
  CONSTRAINT \`review_votes_review_fk\` FOREIGN KEY (\`reviewId\`) REFERENCES \`reviews\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const CREATE_REVIEW_REPORTS = `CREATE TABLE IF NOT EXISTS \`review_reports\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`reviewId\` int NOT NULL,
  \`userId\` int NOT NULL,
  \`reason\` varchar(500) NOT NULL,
  \`status\` enum('open','resolved') NOT NULL DEFAULT 'open',
  \`resolvedAt\` timestamp NULL,
  \`resolvedByUserId\` int NULL,
  \`createdAt\` timestamp NOT NULL DEFAULT (now()),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`review_reports_unique\` (\`reviewId\`, \`userId\`),
  KEY \`review_reports_status\` (\`status\`),
  CONSTRAINT \`review_reports_review_fk\` FOREIGN KEY (\`reviewId\`) REFERENCES \`reviews\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

// 0017 : offre « Néon personnalisé » d'une boutique (une ligne par boutique)
const CREATE_NEON_OFFERS = `CREATE TABLE IF NOT EXISTS \`neon_offers\` (
  \`shopId\` int NOT NULL,
  \`enabled\` int NOT NULL DEFAULT 0,
  \`sizesJson\` text NOT NULL,
  \`includedLetters\` int NOT NULL DEFAULT 10,
  \`extraLetterPriceTnd\` decimal(10,3) NOT NULL DEFAULT 0,
  \`colorsJson\` text NOT NULL,
  \`supportsJson\` text NOT NULL,
  \`outdoorEnabled\` int NOT NULL DEFAULT 0,
  \`outdoorSurchargeType\` enum('percent','fixed') NOT NULL DEFAULT 'percent',
  \`outdoorSurchargeValue\` decimal(10,3) NOT NULL DEFAULT 0,
  \`arabicEnabled\` int NOT NULL DEFAULT 0,
  \`productionDaysMin\` int NULL,
  \`productionDaysMax\` int NULL,
  \`createdAt\` timestamp NOT NULL DEFAULT (now()),
  \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`shopId\`),
  CONSTRAINT \`neon_offers_shop_fk\` FOREIGN KEY (\`shopId\`) REFERENCES \`shops\` (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

// 0017 : « Envoyer mon logo pour un devis » (clients connectés)
const CREATE_NEON_QUOTE_REQUESTS = `CREATE TABLE IF NOT EXISTS \`neon_quote_requests\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`shopId\` int NOT NULL,
  \`userId\` int NOT NULL,
  \`mediaId\` int NULL,
  \`message\` text NULL,
  \`phone\` varchar(64) NULL,
  \`sizeCode\` varchar(8) NULL,
  \`outdoor\` int NOT NULL DEFAULT 0,
  \`status\` enum('new','seen','answered','closed') NOT NULL DEFAULT 'new',
  \`createdAt\` timestamp NOT NULL DEFAULT (now()),
  \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`neon_quote_requests_shop_idx\` (\`shopId\`),
  KEY \`neon_quote_requests_user_idx\` (\`userId\`),
  CONSTRAINT \`neon_quote_requests_shop_fk\` FOREIGN KEY (\`shopId\`) REFERENCES \`shops\` (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

// 0016 : catégories du site masquées par l'administration (aucune suppression, bascule de `hidden`)
const CREATE_HIDDEN_SITE_CATEGORIES = `CREATE TABLE IF NOT EXISTS \`hidden_site_categories\` (
  \`slug\` varchar(120) NOT NULL,
  \`label\` varchar(120) NOT NULL,
  \`hidden\` int NOT NULL DEFAULT 1,
  \`reason\` varchar(255) NULL,
  \`hiddenByUserId\` int NULL,
  \`hiddenAt\` timestamp NOT NULL DEFAULT (now()),
  \`createdAt\` timestamp NOT NULL DEFAULT (now()),
  \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`slug\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const CREATE_PRODUCT_OPTIONS = `CREATE TABLE IF NOT EXISTS \`product_options\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`productId\` int NOT NULL,
  \`name\` varchar(100) NOT NULL,
  \`surchargeType\` enum('per_m2','fixed') NOT NULL,
  \`amountTnd\` decimal(10,3) NOT NULL,
  \`position\` int NOT NULL DEFAULT 0,
  \`createdAt\` timestamp NOT NULL DEFAULT (now()),
  PRIMARY KEY (\`id\`),
  KEY \`product_options_product_idx\` (\`productId\`, \`position\`),
  CONSTRAINT \`product_options_product_fk\` FOREIGN KEY (\`productId\`) REFERENCES \`products\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const CREATE_ORDER_HISTORY = `CREATE TABLE IF NOT EXISTS \`order_status_history\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`orderId\` int NOT NULL,
  \`shopId\` int NULL,
  \`fromStatus\` varchar(32) NULL,
  \`toStatus\` varchar(32) NOT NULL,
  \`changedByUserId\` int NULL,
  \`changedByRole\` varchar(16) NOT NULL,
  \`note\` text NULL,
  \`createdAt\` timestamp NOT NULL DEFAULT (now()),
  PRIMARY KEY (\`id\`),
  KEY \`order_history_order_idx\` (\`orderId\`)
)`;

const CREATE_SETTINGS = `CREATE TABLE IF NOT EXISTS \`marketplace_settings\` (
  \`key\` varchar(64) NOT NULL,
  \`value\` text NOT NULL,
  \`updatedByUserId\` int NULL,
  \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`key\`)
)`;

/** Index utiles aux listes paginées (créés uniquement s'ils n'existent pas). */
const INDEXES: Array<{ table: string; name: string; columns: string }> = [
  { table: "products", name: "products_shop_idx", columns: "`shopId`" },
  { table: "products", name: "products_status_idx", columns: "`status`" },
  { table: "products", name: "products_category_idx", columns: "`categoryId`" },
  { table: "order_items", name: "order_items_order_idx", columns: "`orderId`" },
  { table: "order_items", name: "order_items_shop_idx", columns: "`shopId`" },
  { table: "orders", name: "orders_user_idx", columns: "`userId`" },
  { table: "orders", name: "orders_created_idx", columns: "`createdAt`" },
  { table: "shops", name: "shops_user_idx", columns: "`userId`" },
  { table: "commissions", name: "commissions_order_idx", columns: "`orderId`" },
  { table: "reviews", name: "reviews_product_idx", columns: "`productSlug`" },
  // A-10c : listes et moyennes des avis publiés (fiche produit, atelier)
  { table: "reviews", name: "reviews_product_status", columns: "`productSlug`, `status`" },
  { table: "reviews", name: "reviews_shop_status", columns: "`shopSlug`, `status`" },
];

const CREATE_MEDIA = `CREATE TABLE IF NOT EXISTS \`media\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`ownerUserId\` int NOT NULL,
  \`shopId\` int NULL,
  \`productId\` int NULL,
  \`kind\` enum('image','video') NOT NULL,
  \`storageKey\` varchar(191) NOT NULL,
  \`mimeType\` varchar(64) NOT NULL,
  \`sizeBytes\` int NOT NULL,
  \`originalName\` varchar(191) NULL,
  \`position\` int NOT NULL DEFAULT 0,
  \`isPrimary\` int NOT NULL DEFAULT 0,
  \`createdAt\` timestamp NOT NULL DEFAULT (now()),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`media_storageKey_unique\` (\`storageKey\`),
  KEY \`media_product_idx\` (\`productId\`),
  KEY \`media_owner_idx\` (\`ownerUserId\`)
)`;

// 0014 : catégories propres à chaque boutique (collation explicite : le serveur utilise utf8mb4_0900_ai_ci par défaut)
const CREATE_SHOP_CATEGORIES = `CREATE TABLE IF NOT EXISTS \`shop_categories\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`shopId\` int NOT NULL,
  \`name\` varchar(50) NOT NULL,
  \`slug\` varchar(64) NOT NULL,
  \`position\` int NOT NULL DEFAULT 0,
  \`createdAt\` timestamp NOT NULL DEFAULT (now()),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`shop_categories_shop_name_unique\` (\`shopId\`, \`name\`),
  UNIQUE KEY \`shop_categories_shop_slug_unique\` (\`shopId\`, \`slug\`),
  KEY \`shop_categories_shop_position_idx\` (\`shopId\`, \`position\`),
  CONSTRAINT \`shop_categories_shop_fk\` FOREIGN KEY (\`shopId\`) REFERENCES \`shops\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

/** Catégories de référence du marketplace (nom, slug, sous-catégories). Les noms reprennent ceux du catalogue éditorial. */
export const REFERENCE_CATEGORIES: Array<{ name: string; slug: string; children?: Array<{ name: string; slug: string }> }> = [
  { name: "Décoration murale", slug: "decoration-murale", children: [
    { name: "Art mural en métal", slug: "art-mural-metal" },
    { name: "Panneaux décoratifs", slug: "panneaux-decoratifs" },
  ] },
  { name: "Tableaux", slug: "tableaux", children: [
    { name: "Tableaux sur toile", slug: "tableaux-toile" },
    { name: "Tableaux en relief", slug: "tableaux-relief" },
  ] },
  { name: "Enseignes lumineuses", slug: "enseignes-lumineuses", children: [
    { name: "Lettres boîtiers", slug: "lettres-boitiers" },
    { name: "Enseignes LED", slug: "enseignes-led" },
  ] },
  { name: "LED Néon", slug: "led-neon" },
  { name: "Miroirs", slug: "miroirs", children: [
    { name: "Miroirs LED", slug: "miroirs-led" },
    { name: "Miroirs décoratifs", slug: "miroirs-decoratifs" },
  ] },
  { name: "Cafés & restaurants", slug: "cafes-restaurants" },
  { name: "Salons de coiffure", slug: "salons-de-coiffure" },
  { name: "Hôtels", slug: "hotels" },
  { name: "Décoration salons", slug: "decoration-salons" },
  { name: "Décoration bureaux", slug: "decoration-bureaux" },
  { name: "Mobilier", slug: "mobilier", children: [
    { name: "Tables", slug: "tables" },
    { name: "Étagères", slug: "etageres" },
  ] },
  { name: "MDF / CNC", slug: "mdf-cnc" },
  { name: "Vases", slug: "vases" },
  { name: "Autres", slug: "autres" },
];

export async function applyMigrations(databaseUrl = process.env.DATABASE_URL ?? "mysql://root:@localhost:3306/elegance_deco") {
  assertTestSafeDatabase(databaseUrl);
  const conn = await mysql.createConnection(databaseUrl);
  const applied: string[] = [];
  try {
    for (const column of COLUMNS) {
      const [rows] = await conn.query(
        "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
        [column.table, column.name],
      );
      if ((rows as unknown[]).length === 0) {
        await conn.query(`ALTER TABLE \`${column.table}\` ${column.ddl}`);
        applied.push(`${column.table}.${column.name}`);
        // Les lignes de commande existantes reprennent le statut de leur commande
        if (column.table === "order_items" && column.name === "fulfillmentStatus") {
          await conn.query("UPDATE order_items oi INNER JOIN orders o ON o.id = oi.orderId SET oi.fulfillmentStatus = o.status");
        }
      }
    }

    // Statut « refusé » pour la modération des produits (ajout d'une valeur, aucune donnée modifiée)
    const [statusType] = await conn.query(
      "SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'status'",
    );
    if (!String((statusType as Array<{ type: string }>)[0]?.type ?? "").includes("'rejected'")) {
      await conn.query("ALTER TABLE `products` MODIFY COLUMN `status` enum('draft','pending','published','rejected') NOT NULL DEFAULT 'published'");
      applied.push("products.status + rejected");
    }

    for (const [name, ddl] of [["order_status_history", CREATE_ORDER_HISTORY], ["marketplace_settings", CREATE_SETTINGS]] as const) {
      const [exists] = await conn.query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [name]);
      if ((exists as unknown[]).length === 0) {
        await conn.query(ddl);
        applied.push(`table ${name}`);
      }
    }

    for (const index of INDEXES) {
      const [exists] = await conn.query(
        "SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?",
        [index.table, index.name],
      );
      if ((exists as unknown[]).length === 0) {
        await conn.query(`CREATE INDEX \`${index.name}\` ON \`${index.table}\` (${index.columns})`);
        applied.push(`index ${index.name}`);
      }
    }

    const [mediaTable] = await conn.query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'media'");
    if ((mediaTable as unknown[]).length === 0) {
      await conn.query(CREATE_MEDIA);
      applied.push("table media");
    }

    const [hiddenCategoriesTable] = await conn.query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hidden_site_categories'");
    if ((hiddenCategoriesTable as unknown[]).length === 0) {
      await conn.query(CREATE_HIDDEN_SITE_CATEGORIES);
      applied.push("table hidden_site_categories");
    }

    const [productOptionsTable] = await conn.query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_options'");
    if ((productOptionsTable as unknown[]).length === 0) {
      await conn.query(CREATE_PRODUCT_OPTIONS);
      applied.push("table product_options");
    }

    const [shopCategoriesTable] = await conn.query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shop_categories'");
    if ((shopCategoriesTable as unknown[]).length === 0) {
      await conn.query(CREATE_SHOP_CATEGORIES);
      applied.push("table shop_categories");
    }
    // 0017 : tables du néon personnalisé (créées seulement si absentes ; shops doit déjà exister)
    for (const [name, ddl] of [["neon_offers", CREATE_NEON_OFFERS], ["neon_quote_requests", CREATE_NEON_QUOTE_REQUESTS]] as const) {
      const [exists] = await conn.query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [name]);
      if (!(exists as unknown[]).length) {
        await conn.query(ddl);
        applied.push(`table ${name}`);
      }
    }

    const [shopCategoryColumn] = await conn.query("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'shopCategoryId'");
    if ((shopCategoryColumn as unknown[]).length === 0) {
      await conn.query("ALTER TABLE `products` ADD COLUMN `shopCategoryId` int NULL AFTER `categoryId`, ADD KEY `products_shop_category_idx` (`shopCategoryId`)");
      applied.push("products.shopCategoryId");
    }
    const [shopCategoryFk] = await conn.query("SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND CONSTRAINT_NAME = 'products_shop_category_fk'");
    if ((shopCategoryFk as unknown[]).length === 0) {
      // Suppression d'une catégorie de boutique : ses produits passent à « Sans catégorie »
      await conn.query("ALTER TABLE `products` ADD CONSTRAINT `products_shop_category_fk` FOREIGN KEY (`shopCategoryId`) REFERENCES `shop_categories` (`id`) ON DELETE SET NULL");
      applied.push("contrainte products_shop_category_fk");
    }

    // Catégories de référence : réutilise une catégorie existante de même slug (aucun doublon)
    let order = 0;
    for (const category of REFERENCE_CATEGORIES) {
      order += 10;
      const [insert] = await conn.query(
        "INSERT IGNORE INTO categories (name, slug, parentId, status, sortOrder) VALUES (?, ?, NULL, 'approved', ?)",
        [category.name, category.slug, order],
      );
      if ((insert as { affectedRows: number }).affectedRows) applied.push(`catégorie ${category.name}`);
      const [parentRows] = await conn.query("SELECT id FROM categories WHERE slug = ?", [category.slug]);
      const parentId = (parentRows as Array<{ id: number }>)[0]?.id;
      let childOrder = 0;
      for (const child of category.children ?? []) {
        childOrder += 10;
        const [childInsert] = await conn.query(
          "INSERT IGNORE INTO categories (name, slug, parentId, status, sortOrder) VALUES (?, ?, ?, 'approved', ?)",
          [child.name, child.slug, parentId, childOrder],
        );
        if ((childInsert as { affectedRows: number }).affectedRows) applied.push(`sous-catégorie ${child.name}`);
      }
    }

    // A-10c : un avis par ligne de commande (index UNIQUE : plusieurs NULL permis pour les avis anciens)
    const [reviewLineIndex] = await conn.query("SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reviews' AND INDEX_NAME = 'reviews_order_item_unique'");
    if ((reviewLineIndex as unknown[]).length === 0) {
      await conn.query("CREATE UNIQUE INDEX `reviews_order_item_unique` ON `reviews` (`orderItemId`)");
      applied.push("index reviews_order_item_unique");
    }
    for (const [name, ddl] of [["review_photos", CREATE_REVIEW_PHOTOS], ["review_votes", CREATE_REVIEW_VOTES], ["review_reports", CREATE_REVIEW_REPORTS]] as const) {
      const [exists] = await conn.query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [name]);
      if ((exists as unknown[]).length === 0) {
        await conn.query(ddl);
        applied.push(`table ${name}`);
      }
    }
    // Avis déjà existants : seules les NOUVELLES colonnes sont complétées, et seulement si la ligne de commande
    // est retrouvée sans ambiguïté (une seule ligne de ce produit dans la commande). Les anciennes colonnes ne changent pas.
    const [legacy] = await conn.query(`
      SELECT r.id, oi.id AS orderItemId, oi.pricingMode, oi.widthCm, oi.heightCm, oi.selectedColor, oi.neonText, oi.neonColorName, oi.neonSize,
        u.name AS userName, o.shippingName, o.shippingCity
      FROM reviews r
      INNER JOIN order_items oi ON oi.orderId = r.orderId AND oi.productSlug = r.productSlug
      INNER JOIN orders o ON o.id = r.orderId
      LEFT JOIN users u ON u.id = r.userId
      WHERE r.orderItemId IS NULL
        AND (SELECT COUNT(*) FROM order_items x WHERE x.orderId = r.orderId AND x.productSlug = r.productSlug) = 1
        AND NOT EXISTS (SELECT 1 FROM reviews y WHERE y.orderItemId = oi.id)`);
    for (const row of legacy as Array<PurchasedLine & { id: number; orderItemId: number; userName: string | null; shippingName: string; shippingCity: string }>) {
      await conn.query(
        "UPDATE reviews SET orderItemId = ?, purchasedVariant = ?, isCustom = ?, authorDisplayName = ?, authorGovernorate = ? WHERE id = ? AND orderItemId IS NULL",
        [row.orderItemId, purchasedVariantOf(row), isCustomLine(row) ? 1 : 0, authorDisplayNameOf(row.userName || row.shippingName), splitCity(row.shippingCity).governorate || null, row.id],
      );
    }
    if ((legacy as unknown[]).length) applied.push(`${(legacy as unknown[]).length} avis existant(s) rattaché(s) à leur ligne de commande`);

    // Produits dont la catégorie globale n'existe plus : rattachement par nom si possible, sinon « Autres ».
    // La catégorie globale est facultative : un categoryId NULL est laissé tel quel.
    const [orphanFix] = await conn.query(`
      UPDATE products p
      LEFT JOIN categories c ON c.id = p.categoryId
      LEFT JOIN categories byName ON LOWER(byName.name) = LOWER(p.category)
      SET p.categoryId = COALESCE(byName.id, (SELECT id FROM (SELECT id FROM categories WHERE slug = 'autres') AS a))
      WHERE p.categoryId IS NOT NULL AND c.id IS NULL`);
    const fixed = (orphanFix as { affectedRows: number }).affectedRows;
    if (fixed) applied.push(`${fixed} produit(s) rattaché(s) à une catégorie valide`);
  } finally {
    await conn.end();
  }
  return applied;
}
