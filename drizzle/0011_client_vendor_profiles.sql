-- Phase 4: Client and Vendor distinct profiles, WhatsApp and Terms acceptance
ALTER TABLE `users`
  ADD COLUMN `firstName` varchar(128) NULL AFTER `name`,
  ADD COLUMN `lastName` varchar(128) NULL AFTER `firstName`,
  ADD COLUMN `city` varchar(128) NULL AFTER `phone`,
  ADD COLUMN `address` text NULL AFTER `city`;

ALTER TABLE `shops`
  ADD COLUMN `whatsapp` varchar(64) NULL AFTER `phone`,
  ADD COLUMN `rejectionReason` text NULL AFTER `status`,
  ADD COLUMN `termsAccepted` int NOT NULL DEFAULT 0 AFTER `rejectionReason`,
  ADD COLUMN `termsVersion` varchar(32) NULL AFTER `termsAccepted`,
  ADD COLUMN `termsAcceptedAt` timestamp NULL AFTER `termsVersion`;
