ALTER TABLE `favorite_products` DROP INDEX `favorites_user_product`;--> statement-breakpoint
ALTER TABLE `followed_shops` DROP INDEX `followed_user_shop`;--> statement-breakpoint
ALTER TABLE `favorite_products` MODIFY COLUMN `productId` int;--> statement-breakpoint
ALTER TABLE `followed_shops` MODIFY COLUMN `shopId` int;--> statement-breakpoint
ALTER TABLE `favorite_products` ADD `productSlug` varchar(191) NOT NULL;--> statement-breakpoint
ALTER TABLE `favorite_products` ADD `productName` varchar(191) NOT NULL;--> statement-breakpoint
ALTER TABLE `favorite_products` ADD `imageUrl` text NOT NULL;--> statement-breakpoint
ALTER TABLE `favorite_products` ADD `priceTnd` decimal(10,2) NOT NULL;--> statement-breakpoint
ALTER TABLE `followed_shops` ADD `shopSlug` varchar(191) NOT NULL;--> statement-breakpoint
ALTER TABLE `followed_shops` ADD `shopName` varchar(191) NOT NULL;--> statement-breakpoint
ALTER TABLE `favorite_products` ADD CONSTRAINT `favorites_user_product` UNIQUE(`userId`,`productSlug`);--> statement-breakpoint
ALTER TABLE `followed_shops` ADD CONSTRAINT `followed_user_shop` UNIQUE(`userId`,`shopSlug`);