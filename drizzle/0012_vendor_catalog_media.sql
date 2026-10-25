-- Phase 5 : espace vendeur professionnel (catégories hiérarchiques, médias, promo, variantes, disponibilité)
-- Migration ADDITIVE uniquement. Appliquée de façon idempotente par `npm run db:migrate`
-- (server/migrations.ts vérifie chaque colonne / table avant de l'ajouter).

ALTER TABLE `categories`
  ADD COLUMN `parentId` int NULL AFTER `slug`,
  ADD COLUMN `status` enum('approved','pending','rejected') NOT NULL DEFAULT 'approved' AFTER `parentId`,
  ADD COLUMN `proposedByShopId` int NULL AFTER `status`,
  ADD COLUMN `sortOrder` int NOT NULL DEFAULT 0 AFTER `proposedByShopId`;

ALTER TABLE `products`
  ADD COLUMN `promoPriceTnd` decimal(10,2) NULL AFTER `customization`,
  ADD COLUMN `sku` varchar(64) NULL AFTER `promoPriceTnd`,
  ADD COLUMN `variants` text NULL AFTER `sku`,
  ADD COLUMN `availability` enum('in_stock','made_to_order','out_of_stock') NOT NULL DEFAULT 'in_stock' AFTER `variants`,
  ADD COLUMN `preparationTime` varchar(128) NULL AFTER `availability`,
  ADD COLUMN `extraInfo` text NULL AFTER `preparationTime`,
  ADD COLUMN `videoUrl` varchar(500) NULL AFTER `extraInfo`;

CREATE TABLE IF NOT EXISTS `media` (
  `id` int NOT NULL AUTO_INCREMENT,
  `ownerUserId` int NOT NULL,
  `shopId` int NULL,
  `productId` int NULL,
  `kind` enum('image','video') NOT NULL,
  `storageKey` varchar(191) NOT NULL,
  `mimeType` varchar(64) NOT NULL,
  `sizeBytes` int NOT NULL,
  `originalName` varchar(191) NULL,
  `position` int NOT NULL DEFAULT 0,
  `isPrimary` int NOT NULL DEFAULT 0,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `media_storageKey_unique` (`storageKey`),
  KEY `media_product_idx` (`productId`),
  KEY `media_owner_idx` (`ownerUserId`)
);

-- + insertion (INSERT IGNORE sur le slug) des catégories de décoration de référence, voir server/migrations.ts
