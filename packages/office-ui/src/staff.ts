// 직원 탭의 묶음 (DESIGN 12장 직원 탭): 지도의 방 순서대로 부서를 묶고, 부서 안에서는 팀장 → 팀원 → 보조 → 방문 순.
// 방에 속하지 않는 직원(임시 직원 등)은 맨 끝 "방문 · 기타". 나간 직원은 뺀다.
import type { ScreenEmployee } from '@ai-office/shared';
import { ROOMS } from './map.ts';

const RANK_ORDER = { lead: 0, member: 1, assistant: 2, temp: 3 } as const;

export function staffGroups(employees: ScreenEmployee[]): { title: string; members: ScreenEmployee[] }[] {
  const here = employees.filter((e) => !e.leftAt);
  const sorted = (xs: ScreenEmployee[]) => [...xs].sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank] || a.displayName.localeCompare(b.displayName, 'ko'));
  const groups = ROOMS.filter((r) => r.departments.length > 0).map((r) => ({ title: r.name, members: sorted(here.filter((e) => !e.isTemporary && r.departments.includes(e.department))) }));
  const placed = new Set(groups.flatMap((g) => g.members.map((e) => e.id)));
  const rest = sorted(here.filter((e) => !placed.has(e.id)));
  return [...groups, { title: '방문 · 기타', members: rest }].filter((g) => g.members.length > 0);
}
