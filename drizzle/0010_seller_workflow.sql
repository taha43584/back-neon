-- Phase 3: Seller Workflow and Shop Profile Enhancements
ALTER TABLE `shops`
  ADD COLUMN `logoUrl` text NULL AFTER `coverUrl`,
  ADD COLUMN `phone` varchar(64) NULL AFTER `logoUrl`,
  ADD COLUMN `address` text NULL AFTER `phone`,
  ADD COLUMN `city` varchar(128) NULL AFTER `address`,
  ADD COLUMN `socialInstagram` varchar(191) NULL AFTER `city`,
  ADD COLUMN `socialFacebook` varchar(191) NULL AFTER `socialInstagram`,
  ADD COLUMN `socialWebsite` varchar(191) NULL AFTER `socialFacebook`,
  ADD COLUMN `openingHours` varchar(191) NULL AFTER `socialWebsite`,
  MODIFY COLUMN `status` enum('pending','active','suspended','rejected') NOT NULL DEFAULT 'pending',
  ADD COLUMN `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `createdAt`;

ALTER TABLE `products`
  ADD COLUMN `status` enum('draft','pending','published') NOT NULL DEFAULT 'published' AFTER `tint`,
  ADD COLUMN `stock` int NOT NULL DEFAULT 1 AFTER `status`,
  ADD COLUMN `customization` text NULL AFTER `stock`,
  ADD COLUMN `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `createdAt`;
