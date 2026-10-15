-- DB에서도 지키는 안전 장치. 코드가 틀려도 이 선은 넘지 못한다.
-- events는 추가만 한다 (DESIGN.md 4장).
CREATE TRIGGER `events_no_update` BEFORE UPDATE ON `events`
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `events_no_delete` BEFORE DELETE ON `events`
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
--> statement-breakpoint
-- 결재는 pending에서 한 번만 결정된다 (7장).
CREATE TRIGGER `approvals_decide_once` BEFORE UPDATE OF `status` ON `approvals`
WHEN OLD.`status` <> 'pending'
BEGIN SELECT RAISE(ABORT, 'approval already decided'); END;
--> statement-breakpoint
-- 결재는 지우지 않는다.
CREATE TRIGGER `approvals_no_delete` BEFORE DELETE ON `approvals`
BEGIN SELECT RAISE(ABORT, 'approvals cannot be deleted'); END;
--> statement-breakpoint
-- 끝난 티켓(done, cancelled)의 상태는 다시 바뀌지 않는다.
CREATE TRIGGER `tickets_terminal_frozen` BEFORE UPDATE OF `status` ON `tickets`
WHEN OLD.`status` IN ('done', 'cancelled') AND NEW.`status` <> OLD.`status`
BEGIN SELECT RAISE(ABORT, 'ticket is already finished'); END;
