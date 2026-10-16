-- 회사 규칙은 제안 → CEO 승인 → 적용 순서로만 생긴다 (14장). 코드가 틀려도 DB가 이 선을 지킨다.
-- 규칙은 proposed로만 들어온다.
CREATE TRIGGER `rules_insert_proposed` BEFORE INSERT ON `rules`
WHEN NEW.`status` <> 'proposed'
BEGIN SELECT RAISE(ABORT, 'rules start as proposed'); END;
--> statement-breakpoint
-- active가 되려면 CEO가 승인한 규칙 결재가 있어야 한다.
CREATE TRIGGER `rules_activate_needs_approval` BEFORE UPDATE OF `status` ON `rules`
WHEN NEW.`status` = 'active' AND OLD.`status` <> 'active'
  AND NOT EXISTS (SELECT 1 FROM `approvals` WHERE `kind` = 'rule' AND `target_id` = NEW.`id` AND `status` = 'approved')
BEGIN SELECT RAISE(ABORT, 'rule activation needs CEO approval'); END;
--> statement-breakpoint
-- 쓰던 규칙을 내리는 것(active → retired)도 CEO 승인으로 한다: 활성화 승인 + 삭제 승인, 승인된 결재가 두 건 있어야 한다.
CREATE TRIGGER `rules_retire_needs_approval` BEFORE UPDATE OF `status` ON `rules`
WHEN OLD.`status` = 'active' AND NEW.`status` <> 'active'
  AND (SELECT count(*) FROM `approvals` WHERE `kind` = 'rule' AND `target_id` = NEW.`id` AND `status` = 'approved') < 2
BEGIN SELECT RAISE(ABORT, 'retiring an active rule needs CEO approval'); END;
--> statement-breakpoint
-- 내린 규칙은 다시 살리지 않는다(필요하면 새 후보로 올린다).
CREATE TRIGGER `rules_retired_frozen` BEFORE UPDATE OF `status` ON `rules`
WHEN OLD.`status` = 'retired' AND NEW.`status` <> 'retired'
BEGIN SELECT RAISE(ABORT, 'retired rule cannot come back'); END;
--> statement-breakpoint
-- 규칙 문장과 범위는 바꾸지 않는다(수정은 새 후보로).
CREATE TRIGGER `rules_text_frozen` BEFORE UPDATE OF `text`, `scope`, `reason_category` ON `rules`
BEGIN SELECT RAISE(ABORT, 'rule text is immutable; propose a new rule'); END;
--> statement-breakpoint
CREATE TRIGGER `rules_no_delete` BEFORE DELETE ON `rules`
BEGIN SELECT RAISE(ABORT, 'rules cannot be deleted'); END;
