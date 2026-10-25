-- Catégories propres à chaque boutique.
-- Migration ADDITIVE uniquement (une table + une colonne nullable). Appliquée de façon idempotente
-- par `npm run db:migrate` (server/migrations.ts vérifie chaque élément dans information_schema).

CREATE TABLE IF NOT EXISTS `shop_categories` (
  `id` int NOT NULL AUTO_INCREMENT,
  `shopId` int NOT NULL,
  `name` varchar(50) NOT NULL,
  `slug` varchar(64) NOT NULL,
  `position` int NOT NULL DEFAULT 0,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `shop_categories_shop_name_unique` (`shopId`, `name`),
  UNIQUE KEY `shop_categories_shop_slug_unique` (`shopId`, `slug`),
  KEY `shop_categories_shop_position_idx` (`shopId`, `position`),
  CONSTRAINT `shop_categories_shop_fk` FOREIGN KEY (`shopId`) REFERENCES `shops` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `products`
  ADD COLUMN `shopCategoryId` int NULL AFTER `categoryId`,
  ADD KEY `products_shop_category_idx` (`shopCategoryId`);

ALTER TABLE `products`
  ADD CONSTRAINT `products_shop_category_fk` FOREIGN KEY (`shopCategoryId`)
    REFERENCES `shop_categories` (`id`) ON DELETE SET NULL;

-- + la réparation des catégories globales orphelines ne concerne plus que les categoryId NON NULL
--   (la catégorie globale devient facultative), voir server/migrations.ts
