CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`target_version` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`reversible` text NOT NULL,
	`summary` text NOT NULL,
	`decided_by_discord_id` text,
	`choice` text,
	`note` text,
	`discord_message_id` text,
	`created_at` text NOT NULL,
	`decided_at` text,
	CONSTRAINT "approvals_kind_check" CHECK("approvals"."kind" IN ('plan', 'push', 'main-merge', 'deploy', 'delete', 'external-send', 'budget', 'rule', 'revert')),
	CONSTRAINT "approvals_status_check" CHECK("approvals"."status" IN ('pending', 'approved', 'rejected', 'revision', 'expired')),
	CONSTRAINT "approvals_reversible_check" CHECK("approvals"."reversible" IN ('reversible', 'partial', 'irreversible')),
	CONSTRAINT "approvals_decider_check" CHECK(("approvals"."status" IN ('approved', 'rejected', 'revision')) = ("approvals"."decided_by_discord_id" IS NOT NULL AND "approvals"."decided_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_one_pending` ON `approvals` (`kind`,`target_id`) WHERE "approvals"."status" = 'pending';--> statement-breakpoint
CREATE TABLE `employees` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`department` text NOT NULL,
	`brain` text NOT NULL,
	`sprite_set` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`can_search_web` integer DEFAULT false NOT NULL,
	`is_temporary` integer DEFAULT false NOT NULL,
	CONSTRAINT "employees_role_check" CHECK("employees"."role" IN ('chief-of-staff', 'pm', 'developer', 'reviewer', 'marketing', 'strategy', 'qa-local', 'git-cat', 'temp')),
	CONSTRAINT "employees_status_check" CHECK("employees"."status" IN ('idle', 'working', 'meeting', 'blocked', 'paused'))
);
--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "events_type_check" CHECK("events"."type" IN ('order.created', 'plan.status', 'ticket.status', 'message.sent', 'approval.requested', 'approval.decided', 'meeting.minutes', 'employee.status', 'employee.move', 'model.loaded', 'usage.updated', 'git.commit', 'git.push', 'system.paused', 'system.resumed', 'ceo.presence'))
);
--> statement-breakpoint
CREATE TABLE `meeting_minutes` (
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
	CONSTRAINT "minutes_kind_check" CHECK("meeting_minutes"."kind" IN ('ticket-meeting', 'gate-review')),
	CONSTRAINT "minutes_outcome_check" CHECK("meeting_minutes"."outcome" IN ('agreed', 'disagreed')),
	CONSTRAINT "minutes_target_check" CHECK("meeting_minutes"."ticket_id" IS NOT NULL OR "meeting_minutes"."plan_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text,
	`order_id` text,
	`from_id` text NOT NULL,
	`to_id` text,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`review_verdict` text,
	`reason_category` text,
	`tokens` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "messages_kind_check" CHECK("messages"."kind" IN ('chat', 'review', 'handoff', 'system', 'gate')),
	CONSTRAINT "messages_verdict_check" CHECK("messages"."review_verdict" IS NULL OR "messages"."review_verdict" IN ('pass', 'fail')),
	CONSTRAINT "messages_reason_check" CHECK("messages"."reason_category" IS NULL OR "messages"."reason_category" IN ('criteria-unmet', 'test-failed', 'no-evidence', 'format-error', 'out-of-scope', 'security')),
	CONSTRAINT "messages_fail_needs_reason" CHECK("messages"."review_verdict" IS NOT 'fail' OR "messages"."reason_category" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `messages_ticket_idx` ON `messages` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`discord_message_id` text NOT NULL,
	`raw_text` text NOT NULL,
	`category` text,
	`project_id` text,
	`status` text DEFAULT 'planning' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "orders_status_check" CHECK("orders"."status" IN ('planning', 'awaiting-plan-approval', 'in-progress', 'done', 'rejected', 'cancelled')),
	CONSTRAINT "orders_category_check" CHECK("orders"."category" IS NULL OR "orders"."category" IN ('coding', 'research', 'marketing', 'strategy', 'mixed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_discord_message_id_unique` ON `orders` (`discord_message_id`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`version` integer NOT NULL,
	`goal` text NOT NULL,
	`questions` text NOT NULL,
	`tickets` text NOT NULL,
	`temp_staff` text NOT NULL,
	`estimate` text NOT NULL,
	`gate_result` text,
	`gate_attempts` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`ceo_note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "plans_status_check" CHECK("plans"."status" IN ('draft', 'gate-review', 'awaiting-ceo', 'approved', 'revision-requested', 'rejected', 'superseded')),
	CONSTRAINT "plans_gate_attempts_check" CHECK("plans"."gate_attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plans_order_version_unique` ON `plans` (`order_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `plans_one_live_per_order` ON `plans` (`order_id`) WHERE "plans"."status" IN ('draft', 'gate-review', 'awaiting-ceo', 'revision-requested');--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_url` text NOT NULL,
	`local_path` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`test_command` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`text` text NOT NULL,
	`evidence` text NOT NULL,
	`reason_category` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`applied_count` integer DEFAULT 0 NOT NULL,
	`recurrence_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "rules_status_check" CHECK("rules"."status" IN ('proposed', 'active', 'retired')),
	CONSTRAINT "rules_reason_check" CHECK("rules"."reason_category" IN ('criteria-unmet', 'test-failed', 'no-evidence', 'format-error', 'out-of-scope', 'security'))
);
--> statement-breakpoint
CREATE TABLE `system_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`assignee_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`acceptance_criteria` text NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`paused_from` text,
	`pause_reason` text,
	`rework_count` integer DEFAULT 0 NOT NULL,
	`branch` text,
	`worktree_path` text,
	`needs_ceo_approval` integer NOT NULL,
	`estimated_tokens` integer NOT NULL,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`turns_used` integer DEFAULT 0 NOT NULL,
	`token_cap` integer NOT NULL,
	`turn_cap` integer NOT NULL,
	`pingpong_count` integer DEFAULT 0 NOT NULL,
	`low_precision` integer DEFAULT false NOT NULL,
	`started_at` text,
	`finished_at` text,
	`version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tickets_status_check" CHECK("tickets"."status" IN ('planned', 'in_progress', 'in_review', 'rework', 'meeting', 'blocked', 'awaiting_approval', 'done', 'cancelled', 'paused')),
	CONSTRAINT "tickets_type_check" CHECK("tickets"."type" IN ('coding', 'research', 'marketing', 'strategy', 'writing')),
	CONSTRAINT "tickets_reviewer_not_assignee" CHECK("tickets"."reviewer_id" <> "tickets"."assignee_id"),
	CONSTRAINT "tickets_pause_fields" CHECK(("tickets"."status" = 'paused') = ("tickets"."paused_from" IS NOT NULL) AND ("tickets"."status" = 'paused') = ("tickets"."pause_reason" IS NOT NULL)),
	CONSTRAINT "tickets_paused_from_check" CHECK("tickets"."paused_from" IS NULL OR ("tickets"."paused_from" <> 'paused' AND "tickets"."paused_from" IN ('planned', 'in_progress', 'in_review', 'rework', 'meeting', 'blocked', 'awaiting_approval', 'done', 'cancelled', 'paused'))),
	CONSTRAINT "tickets_pause_reason_check" CHECK("tickets"."pause_reason" IS NULL OR "tickets"."pause_reason" IN ('ceo-stop', 'budget', 'offline', 'system-error', 'cap')),
	CONSTRAINT "tickets_counts_check" CHECK("tickets"."rework_count" >= 0 AND "tickets"."tokens_used" >= 0 AND "tickets"."turns_used" >= 0 AND "tickets"."pingpong_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `tickets_status_idx` ON `tickets` (`status`);--> statement-breakpoint
CREATE INDEX `tickets_order_idx` ON `tickets` (`order_id`);--> statement-breakpoint
CREATE TABLE `usage` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`budget` text NOT NULL,
	`ticket_id` text,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`estimated_pct` real NOT NULL,
	`estimated_weekly_pct` real NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "usage_provider_check" CHECK("usage"."provider" IN ('claude', 'gpt', 'ollama')),
	CONSTRAINT "usage_budget_check" CHECK("usage"."budget" IN ('dev', 'research', 'review', 'local')),
	CONSTRAINT "usage_source_check" CHECK("usage"."source" IN ('reported', 'estimated')),
	CONSTRAINT "usage_numbers_check" CHECK("usage"."input_tokens" >= 0 AND "usage"."output_tokens" >= 0 AND "usage"."estimated_pct" >= 0 AND "usage"."estimated_weekly_pct" >= 0)
);
--> statement-breakpoint
CREATE INDEX `usage_budget_time_idx` ON `usage` (`budget`,`created_at`);