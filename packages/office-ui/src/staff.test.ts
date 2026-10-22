import { describe, expect, it } from 'vitest';
import type { ScreenEmployee } from '@ai-office/shared';
import { characterList, staffGroups } from './staff.ts';

const emp = (id: string, department: string, rank: ScreenEmployee['rank'], over: Partial<ScreenEmployee> = {}): ScreenEmployee => ({
  id,
  displayName: id,
  role: 'developer',
  department,
  rank,
  job: '',
  personalName: null,
  portrait: null,
  model: null,
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

describe('3D 캐릭터 목록 (2026-10-22)', () => {
  it('정규 직원(방 순서) → Git 고양이 → 보조 직원 → 방문, 나간 직원은 뺀다', () => {
    const list = characterList([
      emp('t1', '임시', 'temp'),
      emp('helper', '개발팀', 'assistant'),
      emp('git-cat', '운영지원', 'member'),
      emp('pm', '기획실', 'lead'),
      emp('dev-b', '개발팀', 'member'),
      emp('gone', '개발팀', 'member', { leftAt: '2026-10-20T00:00:00Z' }),
    ]);
    expect(list.map((g) => [g.title, g.members.map((e) => e.id)])).toEqual([
      ['직원', ['dev-b', 'pm', 'git-cat']],
      ['보조 직원', ['helper']],
      ['방문', ['t1']],
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
