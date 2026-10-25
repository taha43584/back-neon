CREATE TABLE `addresses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`label` varchar(64) NOT NULL,
	`recipientName` varchar(191) NOT NULL,
	`phone` varchar(64) NOT NULL,
	`addressLine` text NOT NULL,
	`city` varchar(128) NOT NULL,
	`postalCode` varchar(32),
	`isDefault` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `addresses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`orderId` int NOT NULL,
	`productId` int,
	`productSlug` varchar(191) NOT NULL,
	`productName` varchar(191) NOT NULL,
	`shopSlug` varchar(191) NOT NULL,
	`rating` int NOT NULL,
	`body` text NOT NULL,
	`status` enum('pending','published','rejected') NOT NULL DEFAULT 'pending',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `reviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `reviews_user_order_product` UNIQUE(`userId`,`orderId`,`productSlug`)
);
