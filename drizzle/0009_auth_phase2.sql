-- Phase 2: Native auth fields
ALTER TABLE `users`
  ADD COLUMN `phone` varchar(64) NULL AFTER `email`,
  ADD COLUMN `passwordHash` varchar(255) NULL AFTER `phone`,
  ADD COLUMN `suspended` tinyint(1) NOT NULL DEFAULT 0 AFTER `role`;
