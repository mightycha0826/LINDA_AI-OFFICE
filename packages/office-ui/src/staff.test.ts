import { describe, expect, it } from 'vitest';
import type { ScreenEmployee } from '@ai-office/shared';
import { staffGroups } from './staff.ts';

const emp = (id: string, department: string, rank: ScreenEmployee['rank'], over: Partial<ScreenEmployee> = {}): ScreenEmployee => ({
  id,
  displayName: id,
  role: 'developer',
  department,
  rank,
  job: '',
  personalName: null,
  portrait: null,
  brainLabel: 'GPT',
  spriteSet: id,
  isTemporary: rank === 'temp',
  tempKind: null,
  leftAt: null,
  ...over,
});

describe('직원 탭 묶음', () => {
  it('지도의 방 순서로 부서를 묶고, 부서 안에서는 팀장 → 팀원 → 보조', () => {
    const groups = staffGroups([emp('helper', '개발팀', 'assistant'), emp('dev-b', '개발팀', 'member'), emp('lead', '개발팀', 'lead'), emp('pm', '기획실', 'lead')]);
    expect(groups.map((g) => g.title)).toEqual(['개발팀', '기획실']);
    expect(groups[0]!.members.map((e) => e.id)).toEqual(['lead', 'dev-b', 'helper']);
  });

  it('방이 없는 직원(임시 직원)은 맨 끝 "방문 · 기타", 나간 직원은 뺀다', () => {
    const groups = staffGroups([emp('t1', '임시', 'temp'), emp('gone', '임시', 'temp', { leftAt: '2026-10-20T00:00:00Z' }), emp('pm', '기획실', 'lead')]);
    expect(groups.map((g) => [g.title, g.members.map((e) => e.id)])).toEqual([
      ['기획실', ['pm']],
      ['방문 · 기타', ['t1']],
    ]);
  });
});

describe('캐릭터 이름', () => {
  it('이름이 있으면 `이름 · 직함`, 없으면 직함만', async () => {
    const { fullName } = await import('./format.ts');
    expect(fullName({ displayName: '개발자 A', personalName: '한주아' })).toBe('한주아 · 개발자 A');
    expect(fullName({ displayName: '기획실장', personalName: null })).toBe('기획실장');
  });
});
