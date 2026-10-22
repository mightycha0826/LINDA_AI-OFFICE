PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_meeting_minutes` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text,
	`plan_id` text,
	`kind` text NOT NULL,
	`participants` text NOT NULL,
	`agenda` text NOT NULL,
	`rounds` text NOT NULL,
	`outcome` text NOT NULL,
	`next_actions` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "minutes_kind_check" CHECK("__new_meeting_minutes"."kind" IN ('ticket-meeting', 'gate-review')),
	CONSTRAINT "minutes_outcome_check" CHECK("__new_meeting_minutes"."outcome" IN ('agreed', 'disagreed', 'needs-ceo')),
	CONSTRAINT "minutes_target_check" CHECK("__new_meeting_minutes"."ticket_id" IS NOT NULL OR "__new_meeting_minutes"."plan_id" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_meeting_minutes`("id", "ticket_id", "plan_id", "kind", "participants", "agenda", "rounds", "outcome", "next_actions", "created_at") SELECT "id", "ticket_id", "plan_id", "kind", "participants", "agenda", "rounds", "outcome", "next_actions", "created_at" FROM `meeting_minutes`;--> statement-breakpoint
DROP TABLE `meeting_minutes`;--> statement-breakpoint
ALTER TABLE `__new_meeting_minutes` RENAME TO `meeting_minutes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `tickets` ADD `last_failed_criteria` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `same_fail_count` integer DEFAULT 0 NOT NULL;