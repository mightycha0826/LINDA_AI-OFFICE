ALTER TABLE `projects` ADD `discord_category_id` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `discord_channel_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_discord_channel_id_unique` ON `projects` (`discord_channel_id`);