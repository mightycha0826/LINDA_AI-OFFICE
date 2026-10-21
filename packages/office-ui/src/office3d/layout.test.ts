import { describe, expect, it } from 'vitest';
import type { ScreenEmployee, ScreenTicket } from '@ai-office/shared';
import { DESK_SEATS, GUEST_DEPARTMENT, GUEST_SEATS, MEETING_SEATS, VISITOR_SEATS, place3d } from './layout.ts';

const emp = (id: string, over: Partial<ScreenEmployee> = {}): ScreenEmployee => ({
  id,
  displayName: id,
  role: 'developer',
  department: '개발팀',
  rank: 'member',
  job: '',
  personalName: null,
  portrait: null,
  brainLabel: 'Claude',
  spriteSet: id,
  isTemporary: false,
  tempKind: null,
  leftAt: null,
  ...over,
});
const ticket = (id: string, status: ScreenTicket['status'], assigneeId: string, reviewerId = 'reviewer'): ScreenTicket => ({
  id,
  title: id,
  type: 'coding',
  status,
  pausedFrom: null,
  pauseReason: null,
  assigneeId,
  reviewerId,
  reworkCount: 0,
  needsCeoApproval: false,
  branch: null,
  startedAt: null,
  finishedAt: null,
  tokensUsed: 0,
  turnsUsed: 0,
  lowPrecision: false,
});
const byId = (placed: ReturnType<typeof place3d>) => new Map(placed.map((p) => [p.id, p]));

describe('3D 자리 배치', () => {
  it('상시 직원은 자기 책상, 일하면 타이핑, 이름표는 개인 이름', () => {
    const p = byId(place3d([emp('dev-a', { personalName: '한주아' }), emp('pm')], [ticket('T-1', 'in_progress', 'dev-a')]));
    expect(p.get('dev-a')).toMatchObject({ seat: DESK_SEATS['dev-a'], status: 'working', act: 'type', name: '한주아' });
    expect(p.get('pm')).toMatchObject({ seat: DESK_SEATS['pm'], status: 'idle', act: 'idle', name: 'pm' });
  });

  it('회의 중이면 담당자와 검토자 모두 회의실 의자로 옮긴다', () => {
    const p = byId(place3d([emp('dev-a'), emp('reviewer')], [ticket('T-1', 'meeting', 'dev-a', 'reviewer')]));
    expect(MEETING_SEATS).toContain(p.get('dev-a')!.seat);
    expect(MEETING_SEATS).toContain(p.get('reviewer')!.seat);
    expect(p.get('dev-a')!.seat).not.toBe(p.get('reviewer')!.seat);
    expect(p.get('dev-a')!.act).toBe('talk');
  });

  it('파견 직원은 파견 라운지, 자리(2개)가 모자라면 그리지 않는다', () => {
    const guests = ['guest-a', 'guest-b', 'guest-c'].map((id) => emp(id, { department: GUEST_DEPARTMENT }));
    const placed = place3d(guests, []);
    expect(placed.map((p) => p.seat)).toEqual([...GUEST_SEATS]);
    expect(placed).toHaveLength(2);
  });

  it('임시 직원은 커피 바(작게), 나간 직원·Git 고양이는 빠진다', () => {
    const placed = place3d(
      [emp('temp-1', { isTemporary: true, rank: 'temp' }), emp('gone', { leftAt: '2026-10-20T00:00:00Z' }), emp('git-cat'), emp('dev-b', { leftAt: '2026-10-20T00:00:00Z' })],
      [],
    );
    expect(placed.map((p) => p.id)).toEqual(['temp-1']);
    expect(placed[0]).toMatchObject({ seat: VISITOR_SEATS[0], helper: true });
  });

  it('보조 직원은 작은 이름표, 같은 입력이면 같은 배치(ID 순)', () => {
    const list = [emp('diff-summarizer', { rank: 'assistant' }), emp('developer', { rank: 'lead' })];
    const a = place3d(list, []);
    expect(a.map((p) => p.id)).toEqual(['developer', 'diff-summarizer']);
    expect(a[1]!.helper).toBe(true);
    expect(place3d([...list].reverse(), [])).toEqual(a);
  });

  it('자리 좌표는 서로 겹치지 않는다', () => {
    const all = [...Object.values(DESK_SEATS), ...MEETING_SEATS, ...GUEST_SEATS, ...VISITOR_SEATS].map((s) => `${s.x},${s.z}`);
    expect(new Set(all).size).toBe(all.length);
  });
});
