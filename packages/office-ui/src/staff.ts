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

/** 3D 캐릭터 목록 (12장, 2026-10-22 CEO 요청): 정규 직원(지도의 방 순서) → Git 고양이 → 보조 직원 → 방문. 나간 직원은 뺀다 */
export function characterList(employees: ScreenEmployee[]): { title: string; members: ScreenEmployee[] }[] {
  const flat = staffGroups(employees).flatMap((g) => g.members);
  const regular = flat.filter((e) => (e.rank === 'lead' || e.rank === 'member') && e.id !== 'git-cat');
  const cat = flat.filter((e) => e.id === 'git-cat');
  return [
    { title: '직원', members: [...regular, ...cat] },
    { title: '보조 직원', members: flat.filter((e) => e.rank === 'assistant') },
    { title: '방문', members: flat.filter((e) => e.rank === 'temp') },
  ].filter((g) => g.members.length > 0);
}
