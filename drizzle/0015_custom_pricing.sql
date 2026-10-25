-- Prix selon les dimensions (sur mesure).
-- Migration ADDITIVE uniquement : colonnes nullables (ou avec valeur par défaut) et une nouvelle table.
-- Les produits existants reçoivent pricingMode = 'fixed' et gardent leur prix fixe.
-- Appliquée de façon idempotente par `npm run db:migrate` (server/migrations.ts).

ALTER TABLE `products`
  ADD COLUMN `pricingMode` enum('fixed','per_m2','per_linear_m') NOT NULL DEFAULT 'fixed' AFTER `promoPriceTnd`,
  ADD COLUMN `unitPriceTnd` decimal(10,3) NULL AFTER `pricingMode`,
  ADD COLUMN `minWidthCm` int NULL AFTER `unitPriceTnd`,
  ADD COLUMN `maxWidthCm` int NULL AFTER `minWidthCm`,
  ADD COLUMN `minHeightCm` int NULL AFTER `maxWidthCm`,
  ADD COLUMN `maxHeightCm` int NULL AFTER `minHeightCm`,
  ADD COLUMN `minBillableArea` decimal(8,3) NULL AFTER `maxHeightCm`,
  ADD COLUMN `minPriceTnd` decimal(10,3) NULL AFTER `minBillableArea`,
  ADD COLUMN `promoPercent` decimal(5,2) NULL AFTER `minPriceTnd`;

CREATE TABLE IF NOT EXISTS `product_options` (
  `id` int NOT NULL AUTO_INCREMENT,
  `productId` int NOT NULL,
  `name` varchar(100) NOT NULL,
  `surchargeType` enum('per_m2','fixed') NOT NULL,
  `amountTnd` decimal(10,3) NOT NULL,
  `position` int NOT NULL DEFAULT 0,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  PRIMARY KEY (`id`),
  KEY `product_options_product_idx` (`productId`, `position`),
  CONSTRAINT `product_options_product_fk` FOREIGN KEY (`productId`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `order_items`
  ADD COLUMN `pricingMode` varchar(16) NULL AFTER `personalization`,
  ADD COLUMN `widthCm` int NULL AFTER `pricingMode`,
  ADD COLUMN `heightCm` int NULL AFTER `widthCm`,
  ADD COLUMN `areaM2` decimal(10,4) NULL AFTER `heightCm`,
  ADD COLUMN `billedAreaM2` decimal(10,4) NULL AFTER `areaM2`,
  ADD COLUMN `appliedUnitPriceTnd` decimal(10,3) NULL AFTER `billedAreaM2`,
  ADD COLUMN `optionsJson` text NULL AFTER `appliedUnitPriceTnd`,
  ADD COLUMN `lineTotalTnd` decimal(10,2) NULL AFTER `optionsJson`;
