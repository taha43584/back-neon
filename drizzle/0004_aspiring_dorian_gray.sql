ALTER TABLE `commissions` MODIFY COLUMN `shopId` int;--> statement-breakpoint
ALTER TABLE `order_items` MODIFY COLUMN `productId` int;--> statement-breakpoint
ALTER TABLE `order_items` MODIFY COLUMN `shopId` int;--> statement-breakpoint
ALTER TABLE `commissions` ADD `shopSlug` varchar(191) NOT NULL;--> statement-breakpoint
ALTER TABLE `order_items` ADD `productSlug` varchar(191) NOT NULL;--> statement-breakpoint
ALTER TABLE `order_items` ADD `productName` varchar(191) NOT NULL;--> statement-breakpoint
ALTER TABLE `order_items` ADD `shopSlug` varchar(191) NOT NULL;--> statement-breakpoint
ALTER TABLE `order_items` ADD `shopName` varchar(191) NOT NULL;