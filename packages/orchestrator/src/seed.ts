// 상시 직원 7명과 Git 고양이 (DESIGN.md 2장). 이름은 나중에 정하므로 지금은 직함을 쓴다.
import type { Brain, EmployeeRole } from '@ai-office/shared';
import { inTx, type Ctx } from './context.ts';
import { employees } from './db/schema.ts';

interface Seed {
  id: string;
  displayName: string;
  role: EmployeeRole;
  department: string;
  brain: Brain;
  canSearchWeb: boolean;
}

export const STANDING_STAFF: readonly Seed[] = [
  { id: 'chief-of-staff', displayName: '비서실장', role: 'chief-of-staff', department: 'CEO실', brain: { provider: 'ollama', model: 'qwen3:14b' }, canSearchWeb: false },
  { id: 'pm', displayName: 'PM', role: 'pm', department: '기획', brain: { provider: 'ollama', model: 'qwen3:14b' }, canSearchWeb: false },
  { id: 'developer', displayName: '개발자', role: 'developer', department: '개발팀', brain: { provider: 'claude-code', budget: 'dev' }, canSearchWeb: true },
  { id: 'reviewer', displayName: '리뷰어 · 감사관', role: 'reviewer', department: '개발팀', brain: { provider: 'codex' }, canSearchWeb: false },
  { id: 'marketing', displayName: '마케팅', role: 'marketing', department: '마케팅 · 경영', brain: { provider: 'ollama', model: 'qwen3:14b' }, canSearchWeb: true },
  { id: 'strategy', displayName: '경영전략 · 리서치', role: 'strategy', department: '마케팅 · 경영', brain: { provider: 'claude-code', budget: 'research' }, canSearchWeb: true },
  { id: 'qa-local', displayName: '검토 담당', role: 'qa-local', department: '기획 · 검토', brain: { provider: 'ollama', model: 'gemma4:12b' }, canSearchWeb: true },
  { id: 'git-cat', displayName: 'Git 고양이', role: 'git-cat', department: 'Git 코너', brain: { provider: 'none' }, canSearchWeb: false },
];

/** 없는 직원만 넣는다. 이미 있는 직원은 건드리지 않는다. */
export function seedStaff(c: Ctx): void {
  inTx(c, (t) => {
    for (const s of STANDING_STAFF) {
      t.db
        .insert(employees)
        .values({ ...s, spriteSet: s.id, isTemporary: false })
        .onConflictDoNothing()
        .run();
    }
  });
}
