// 상시 직원과 Git 고양이 (DESIGN.md 2장, 2-0 개편 조직도). 이름은 나중에 정하므로 지금은 직함을 쓴다.
import { eq } from 'drizzle-orm';
import { LOCAL_MODEL, type Brain, type EmployeeRole } from '@ai-office/shared';
import { inTx, type Ctx } from './context.ts';
import { employees } from './db/schema.ts';

interface Seed {
  id: string;
  displayName: string;
  role: EmployeeRole;
  department: string;
  brain: Brain;
  canSearchWeb: boolean;
  /** 캐릭터 그림. 비우면 id. 그림이 아직 없는 직원은 비슷한 직원 그림을 빌린다 */
  spriteSet?: string;
}

export const STANDING_STAFF: readonly Seed[] = [
  // 비서실장 두뇌는 헤르메스 설정이 정한다. 여기 값은 화면 표시용 (2026-10-19 Qwen3-14B → Gemma 4 12B, 헤르메스 64K 문맥 하한)
  { id: 'chief-of-staff', displayName: '비서실장', role: 'chief-of-staff', department: 'CEO실', brain: { provider: 'ollama', model: LOCAL_MODEL }, canSearchWeb: false },
  // 기획실장: 7-1부터 Claude(기획 몫 = 리서치 몫). 로컬 PM은 규칙 위반·관문 반려가 잦았다 (2-0, 2026-10-19)
  { id: 'pm', displayName: '기획실장', role: 'pm', department: '기획실', brain: { provider: 'claude-code', budget: 'research' }, canSearchWeb: false },
  // 개발팀장(테크 리드): 어려운 티켓 구현, GPT 개발자 코드의 최종 리뷰 (2-0, 7-3)
  { id: 'developer', displayName: '개발팀장', role: 'developer', department: '개발팀', brain: { provider: 'claude-code', budget: 'dev' }, canSearchWeb: true },
  // 개발자 A·B: Codex, 그 티켓 worktree 안에서만 쓰기, 네트워크 없음 (7장 7-3)
  { id: 'dev-a', displayName: '개발자 A', role: 'developer', department: '개발팀', brain: { provider: 'codex' }, canSearchWeb: false, spriteSet: 'developer' },
  { id: 'dev-b', displayName: '개발자 B', role: 'developer', department: '개발팀', brain: { provider: 'codex' }, canSearchWeb: false, spriteSet: 'developer' },
  { id: 'reviewer', displayName: '리뷰어 · 감사관', role: 'reviewer', department: '개발팀', brain: { provider: 'codex' }, canSearchWeb: false },
  // 카피라이터·전략가: 7-4부터 GPT(Codex, 읽기 전용). 웹은 오케스트레이터가 대신 검색해 넘긴다(15장)
  { id: 'marketing', displayName: '카피라이터', role: 'marketing', department: '마케팅 · 콘텐츠팀', brain: { provider: 'codex' }, canSearchWeb: true },
  { id: 'strategy', displayName: '전략가', role: 'strategy', department: '리서치 · 전략팀', brain: { provider: 'codex' }, canSearchWeb: true },
  // 교정 담당(예전 검토 담당): 문서 1차 점검, 문서 검토, 회고 초안 (7-1, 7-4)
  { id: 'qa-local', displayName: '교정 담당', role: 'qa-local', department: '품질보증팀', brain: { provider: 'ollama', model: LOCAL_MODEL }, canSearchWeb: true },
  { id: 'git-cat', displayName: 'Git 고양이', role: 'git-cat', department: 'Git 코너', brain: { provider: 'none' }, canSearchWeb: false },
];

/** 없는 직원만 넣는다. 이미 있는 직원은 건드리지 않는다. */
export function seedStaff(c: Ctx): void {
  inTx(c, (t) => {
    for (const s of STANDING_STAFF) {
      t.db
        .insert(employees)
        .values({ ...s, spriteSet: s.spriteSet ?? s.id, isTemporary: false })
        .onConflictDoNothing()
        .run();
    }
    // 이미 만든 DB의 두뇌도 설계에 맞춘다: 비서실장(예전 qwen3:14b), 기획실장(7-1 Claude), 로컬 직원(7-2 Gemma 64K), 개발팀장(7-3 이름)
    for (const id of ['chief-of-staff', 'pm', 'marketing', 'strategy', 'qa-local', 'developer']) {
      const s = STANDING_STAFF.find((x) => x.id === id)!;
      t.db.update(employees).set({ brain: s.brain, displayName: s.displayName, department: s.department }).where(eq(employees.id, id)).run();
    }
  });
}
