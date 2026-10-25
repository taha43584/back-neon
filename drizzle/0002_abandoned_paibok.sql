CREATE TABLE `favorite_products` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`productId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `favorite_products_id` PRIMARY KEY(`id`),
	CONSTRAINT `favorites_user_product` UNIQUE(`userId`,`productId`)
);
--> statement-breakpoint
CREATE TABLE `followed_shops` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`shopId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `followed_shops_id` PRIMARY KEY(`id`),
	CONSTRAINT `followed_user_shop` UNIQUE(`userId`,`shopId`)
);
