PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_employees` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`department` text NOT NULL,
	`brain` text NOT NULL,
	`sprite_set` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`can_search_web` integer DEFAULT false NOT NULL,
	`is_temporary` integer DEFAULT false NOT NULL,
	`temp_kind` text,
	`order_id` text,
	`left_at` text,
	CONSTRAINT "employees_role_check" CHECK("__new_employees"."role" IN ('chief-of-staff', 'pm', 'developer', 'reviewer', 'marketing', 'strategy', 'qa-local', 'git-cat', 'temp', 'assistant')),
	CONSTRAINT "employees_status_check" CHECK("__new_employees"."status" IN ('idle', 'working', 'meeting', 'blocked', 'paused'))
);
--> statement-breakpoint
INSERT INTO `__new_employees`("id", "display_name", "role", "department", "brain", "sprite_set", "status", "can_search_web", "is_temporary", "temp_kind", "order_id", "left_at") SELECT "id", "display_name", "role", "department", "brain", "sprite_set", "status", "can_search_web", "is_temporary", "temp_kind", "order_id", "left_at" FROM `employees`;--> statement-breakpoint
DROP TABLE `employees`;--> statement-breakpoint
ALTER TABLE `__new_employees` RENAME TO `employees`;--> statement-breakpoint
PRAGMA foreign_keys=ON;