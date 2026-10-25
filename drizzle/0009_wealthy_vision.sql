ALTER TABLE `users` ADD `phone` varchar(64);--> statement-breakpoint
ALTER TABLE `users` ADD `passwordHash` varchar(255);--> statement-breakpoint
ALTER TABLE `users` ADD `suspended` int DEFAULT 0 NOT NULL;