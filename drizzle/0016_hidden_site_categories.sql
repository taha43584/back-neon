-- Catégories du site masquées par l'administration (nom inapproprié). Aucune suppression :
-- masquer / réafficher bascule `hidden`. Clé = categorySlug(nom) (shared/categoryKey.ts).
-- Migration ADDITIVE, appliquée de façon idempotente par `npm run db:migrate` (server/migrations.ts).

CREATE TABLE IF NOT EXISTS `hidden_site_categories` (
  `slug` varchar(120) NOT NULL,
  `label` varchar(120) NOT NULL,
  `hidden` int NOT NULL DEFAULT 1,
  `reason` varchar(255) NULL,
  `hiddenByUserId` int NULL,
  `hiddenAt` timestamp NOT NULL DEFAULT (now()),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
