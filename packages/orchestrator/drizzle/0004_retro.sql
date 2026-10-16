CREATE TABLE `retros` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`ticket_id` text,
	`week` text,
	`what_wrong` text,
	`why` text,
	`prevent_at` text,
	`confirmed` integer,
	`check_note` text,
	`summary` text,
	`stats` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "retros_kind_check" CHECK("retros"."kind" IN ('ticket', 'weekly')),
	CONSTRAINT "retros_prevent_check" CHECK("retros"."prevent_at" IS NULL OR "retros"."prevent_at" IN ('plan', 'work', 'review', 'test')),
	CONSTRAINT "retros_shape_check" CHECK(("retros"."kind" = 'ticket' AND "retros"."ticket_id" IS NOT NULL) OR ("retros"."kind" = 'weekly' AND "retros"."week" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `retros_ticket_unique` ON `retros` (`ticket_id`) WHERE "retros"."kind" = 'ticket';--> statement-breakpoint
CREATE UNIQUE INDEX `retros_week_unique` ON `retros` (`week`) WHERE "retros"."kind" = 'weekly';--> statement-breakpoint
CREATE TABLE `rule_applications` (
	`rule_id` text NOT NULL,
	`target_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `rules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rule_applications_unique` ON `rule_applications` (`rule_id`,`target_id`);--> statement-breakpoint
ALTER TABLE `rules` ADD `activated_at` text;--> statement-breakpoint
ALTER TABLE `rules` ADD `baseline_rate` real;--> statement-breakpoint
ALTER TABLE `rules` ADD `retired_reason` text;--> statement-breakpoint
ALTER TABLE `rules` ADD `source` text;