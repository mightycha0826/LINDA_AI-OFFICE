// 전환표 (DESIGN.md 5장): 표에 없는 전환 거부, 반려 횟수, 요청 주체, 멈춘 이유별 재개.
import { describe, expect, it } from 'vitest';
import { TICKET_STATUSES, type TicketStatus } from '@ai-office/shared';
import { decide, SAME_FAIL_LIMIT, TRANSITIONS, type Actor, type TicketEvent, type TicketSnapshot } from '../src/core/transitions.ts';
import { TransitionRejected } from '../src/errors.ts';
import { CEO, STRANGER } from './helpers.ts';

const ctx = { ceoDiscordId: CEO, systemStopped: false };
const assignee: Actor = { kind: 'employee', id: 'developer' };
const reviewer: Actor = { kind: 'employee', id: 'reviewer' };
const ceo: Actor = { kind: 'approval-bot', discordUserId: CEO };
const stranger: Actor = { kind: 'approval-bot', discordUserId: STRANGER };
const orch: Actor = { kind: 'orchestrator' };

function snap(status: TicketStatus, over: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return { status, reworkCount: 0, needsCeoApproval: false, assigneeId: 'developer', reviewerId: 'reviewer', pausedFrom: null, pauseReason: null, lastFailedCriteria: null, sameFailCount: 0, ...over };
}

const SAMPLE_EVENTS: TicketEvent[] = [
  { type: 'plan.approved' },
  { type: 'ticket.submitted' },
  { type: 'review.passed' },
  { type: 'review.failed', reasonCategory: 'criteria-unmet', failedCriteria: ['조건 1'] },
  { type: 'rework.started' },
  { type: 'meeting.agreed' },
  { type: 'meeting.failed' },
  { type: 'meeting.escalated' },
  { type: 'approval.approved' },
  { type: 'approval.rejected' },
  { type: 'ceo.retry' },
  { type: 'ceo.direct', note: '방향' },
  { type: 'ceo.cancel' },
  { type: 'guard.pingpong' },
  { type: 'guard.repeat' },
  { type: 'system.pause', reason: 'budget' },
  { type: 'system.resume', cause: 'budget-refilled' },
];

function rejectCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof TransitionRejected) return e.code;
    throw e;
  }
  return 'accepted';
}

describe('표에 없는 전환은 거부한다', () => {
  for (const status of TICKET_STATUSES) {
    for (const ev of SAMPLE_EVENTS) {
      const inTable = TRANSITIONS.some((r) => r.event === ev.type && r.from.includes(status));
      if (inTable) continue;
      it(`${status} --${ev.type}--> 거부`, () => {
        // 누가 요청하든 거부
        for (const actor of [assignee, reviewer, ceo, orch]) {
          expect(rejectCode(() => decide(snap(status, { pauseReason: 'budget', pausedFrom: 'in_progress' }), ev, actor, ctx))).toBe('no-transition');
        }
      });
    }
  }

  it('in_review를 거치지 않고 done으로 가는 길은 없다', () => {
    const toDone = TRANSITIONS.filter((r) => r.to === 'done');
    expect(toDone.every((r) => r.from.every((f) => f === 'in_review' || f === 'awaiting_approval'))).toBe(true);
    const toAwaiting = TRANSITIONS.filter((r) => r.to === 'awaiting_approval');
    expect(toAwaiting.every((r) => r.from.every((f) => f === 'in_review'))).toBe(true);
  });

  it('done, cancelled에서는 어떤 이벤트도 받지 않는다', () => {
    for (const status of ['done', 'cancelled'] as const) {
      for (const ev of SAMPLE_EVENTS) {
        expect(rejectCode(() => decide(snap(status), ev, orch, ctx))).not.toBe('accepted');
      }
    }
  });
});

describe('반려 횟수: 먼저 올리고 판정한다', () => {
  const fail: TicketEvent = { type: 'review.failed', reasonCategory: 'test-failed', failedCriteria: ['조건 1'] };

  it('첫 반려 → rework, 횟수 1', () => {
    const d = decide(snap('in_review', { reworkCount: 0 }), fail, reviewer, ctx);
    expect(d.to).toBe('rework');
    expect(d.patch.reworkCount).toBe(1);
  });

  it('두 번째 반려 → meeting, 횟수 2', () => {
    const d = decide(snap('in_review', { reworkCount: 1 }), fail, reviewer, ctx);
    expect(d.to).toBe('meeting');
    expect(d.patch.reworkCount).toBe(2);
  });

  it('회의 합의 뒤 또 반려 → 다시 meeting (매번 회의)', () => {
    for (const n of [2, 3, 7]) {
      const d = decide(snap('in_review', { reworkCount: n }), fail, reviewer, ctx);
      expect(d.to).toBe('meeting');
      expect(d.patch.reworkCount).toBe(n + 1);
    }
  });

  it('CEO 결재 반려는 횟수에 넣지 않는다', () => {
    const d = decide(snap('awaiting_approval', { reworkCount: 1 }), { type: 'approval.rejected' }, ceo, ctx);
    expect(d.to).toBe('rework');
    expect(d.patch.reworkCount).toBeUndefined();
  });

  it('결재 필요 여부에 따라 통과 길이 갈린다', () => {
    expect(decide(snap('in_review'), { type: 'review.passed' }, reviewer, ctx).to).toBe('done');
    expect(decide(snap('in_review', { needsCeoApproval: true }), { type: 'review.passed' }, reviewer, ctx).to).toBe('awaiting_approval');
  });
});

describe('요청 주체', () => {
  it('검토 결과는 그 티켓의 검토자만 낸다', () => {
    expect(rejectCode(() => decide(snap('in_review'), { type: 'review.passed' }, assignee, ctx))).toBe('actor');
    expect(rejectCode(() => decide(snap('in_review'), { type: 'review.passed' }, { kind: 'employee', id: 'strategy' }, ctx))).toBe('actor');
    expect(rejectCode(() => decide(snap('in_review'), { type: 'review.passed' }, orch, ctx))).toBe('actor');
  });

  it('제출은 담당자만 한다', () => {
    expect(rejectCode(() => decide(snap('in_progress'), { type: 'ticket.submitted' }, reviewer, ctx))).toBe('actor');
    expect(decide(snap('in_progress'), { type: 'ticket.submitted' }, assignee, ctx).to).toBe('in_review');
  });

  it('CEO 결정은 CEO 계정의 결재 봇 클릭만 인정한다', () => {
    for (const [status, ev] of [
      ['planned', { type: 'plan.approved' }],
      ['awaiting_approval', { type: 'approval.approved' }],
      ['blocked', { type: 'ceo.retry' }],
      ['blocked', { type: 'ceo.cancel' }],
    ] as [TicketStatus, TicketEvent][]) {
      expect(rejectCode(() => decide(snap(status), ev, stranger, ctx))).toBe('actor');
      expect(rejectCode(() => decide(snap(status), ev, orch, ctx))).toBe('actor');
      expect(rejectCode(() => decide(snap(status), ev, assignee, ctx))).toBe('actor');
      expect(rejectCode(() => decide(snap(status), ev, ceo, ctx))).toBe('accepted');
    }
  });

  it('/정지와 /재개 사유는 CEO만 쓸 수 있다', () => {
    expect(rejectCode(() => decide(snap('in_progress'), { type: 'system.pause', reason: 'ceo-stop' }, orch, ctx))).toBe('actor');
    expect(decide(snap('in_progress'), { type: 'system.pause', reason: 'ceo-stop' }, ceo, ctx).to).toBe('paused');
    const paused = snap('paused', { pausedFrom: 'in_review', pauseReason: 'ceo-stop' });
    expect(rejectCode(() => decide(paused, { type: 'system.resume', cause: 'ceo-resume' }, orch, ctx))).toBe('actor');
    expect(decide(paused, { type: 'system.resume', cause: 'ceo-resume' }, ceo, ctx).to).toBe('in_review');
  });
});

describe('일시정지와 재개', () => {
  it('정지는 원래 상태와 이유를 기록하고, 재개는 원래 상태로 돌아간다', () => {
    const d = decide(snap('meeting'), { type: 'system.pause', reason: 'offline' }, orch, ctx);
    expect(d).toMatchObject({ to: 'paused', patch: { pausedFrom: 'meeting', pauseReason: 'offline' } });
    const r = decide(snap('paused', { pausedFrom: 'meeting', pauseReason: 'offline' }), { type: 'system.resume', cause: 'online' }, orch, ctx);
    expect(r).toMatchObject({ to: 'meeting', patch: { pausedFrom: null, pauseReason: null } });
  });

  it('이미 paused인 티켓은 다시 멈추지 않는다', () => {
    expect(rejectCode(() => decide(snap('paused', { pausedFrom: 'in_progress', pauseReason: 'budget' }), { type: 'system.pause', reason: 'ceo-stop' }, ceo, ctx))).toBe('no-transition');
  });

  it('멈춘 이유에 맞는 원인만 티켓을 푼다', () => {
    const cases = [
      ['budget', 'ceo-resume', 'condition'],
      ['budget', 'budget-refilled', 'accepted'],
      ['cap', 'budget-refilled', 'condition'],
      ['cap', 'ceo-resume', 'accepted'],
      ['cap', 'cap-raised', 'accepted'],
      ['ceo-stop', 'budget-refilled', 'condition'],
      ['offline', 'online', 'accepted'],
      ['system-error', 'recovered', 'accepted'],
      ['system-error', 'ceo-resume', 'accepted'],
    ] as const;
    for (const [reason, cause, expected] of cases) {
      const actor = cause === 'ceo-resume' ? ceo : orch;
      const t = snap('paused', { pausedFrom: 'in_progress', pauseReason: reason });
      expect(rejectCode(() => decide(t, { type: 'system.resume', cause }, actor, ctx)), `${reason} ← ${cause}`).toBe(expected);
    }
  });

  it('/정지 중에는 /재개 말고는 아무것도 티켓을 깨우지 못한다', () => {
    const stopped = { ...ctx, systemStopped: true };
    const t = snap('paused', { pausedFrom: 'in_progress', pauseReason: 'budget' });
    expect(rejectCode(() => decide(t, { type: 'system.resume', cause: 'budget-refilled' }, orch, stopped))).toBe('condition');
  });
});

describe('핑퐁 차단 전환', () => {
  it('작업·검토·재작업 중이면 meeting, 회의 중이면 blocked', () => {
    for (const s of ['in_progress', 'in_review', 'rework'] as const) {
      expect(decide(snap(s), { type: 'guard.pingpong' }, orch, ctx).to).toBe('meeting');
    }
    expect(decide(snap('meeting'), { type: 'guard.pingpong' }, orch, ctx).to).toBe('blocked');
  });

  it('핑퐁 차단은 오케스트레이터만 건다', () => {
    expect(rejectCode(() => decide(snap('in_progress'), { type: 'guard.pingpong' }, reviewer, ctx))).toBe('actor');
  });
});

describe('같은 반려 반복 → 막힘 (2026-10-23)', () => {
  const failOn = (failedCriteria: string[]): TicketEvent => ({ type: 'review.failed', reasonCategory: 'criteria-unmet', failedCriteria });

  /** 반려 묶음을 차례로 넣어 본다. 반려 뒤에는 (재작업·회의를 거쳐) 다시 검토 중으로 돌아왔다고 본다 */
  function replay(sets: string[][], start: Partial<TicketSnapshot> = {}): string[] {
    let t = snap('in_review', start);
    const trail: string[] = [];
    for (const set of sets) {
      const d = decide(t, failOn(set), reviewer, ctx);
      trail.push(d.to);
      if (d.to === 'blocked') break;
      t = { ...t, ...d.patch, status: 'in_review' };
    }
    return trail;
  }

  it(`같은 완료 조건 묶음이 연속 ${SAME_FAIL_LIMIT}회째 반려되면 회의 없이 막힘 (1회 재작업 → 2·3회 회의 → 4회 막힘)`, () => {
    expect(SAME_FAIL_LIMIT).toBe(4);
    const same = Array.from({ length: 6 }, () => ['조건 1']);
    expect(replay(same)).toEqual(['rework', 'meeting', 'meeting', 'blocked']);
  });

  it('막힘으로 갈 때도 반려 횟수와 묶음을 기록한다', () => {
    const d = decide(snap('in_review', { reworkCount: 3, lastFailedCriteria: ['조건 1'], sameFailCount: 3 }), failOn(['조건 1']), reviewer, ctx);
    expect(d).toMatchObject({ to: 'blocked', rule: '같은 조건 반복 반려 → 막힘', patch: { reworkCount: 4, sameFailCount: 4, lastFailedCriteria: ['조건 1'] } });
  });

  it('묶음이 바뀌면 1부터 다시 센다: T-10 기록(묶음 연속 1·1·1·2·3)은 막히지 않는다', () => {
    const one = ['빌드 성공'];
    const four = ['빌드 성공', '테스트 통과', '언어 전환', '변환 기록'];
    expect(replay([one, four, one, one, one])).toEqual(['rework', 'meeting', 'meeting', 'meeting', 'meeting']);
  });

  it('묶음은 순서와 중복에 상관없이 같은지 본다', () => {
    expect(replay([['가', '나'], ['나', '가'], ['가', '나', '가'], ['나', '가']])).toEqual(['rework', 'meeting', 'meeting', 'blocked']);
  });

  it('반려 2회 미만에서는 막히지 않는다(연속 횟수는 반려 횟수를 넘지 못한다)', () => {
    expect(replay([['조건 1']])).toEqual(['rework']);
  });

  it('통과하거나 사장님이 손대면 처음부터 다시 센다', () => {
    const counted = { lastFailedCriteria: ['조건 1'], sameFailCount: 3 };
    const cases: [TicketStatus, TicketEvent, Actor, Partial<TicketSnapshot>][] = [
      ['in_review', { type: 'review.passed' }, reviewer, {}],
      ['in_review', { type: 'review.passed' }, reviewer, { needsCeoApproval: true }],
      ['awaiting_approval', { type: 'approval.rejected' }, ceo, {}],
      ['blocked', { type: 'ceo.retry' }, ceo, {}],
      ['blocked', { type: 'ceo.direct', note: '이렇게 해' }, ceo, {}],
      ['in_review', { type: 'ceo.revise' }, ceo, {}],
    ];
    for (const [status, ev, actor, over] of cases) {
      expect(decide(snap(status, { ...counted, ...over }), ev, actor, ctx).patch, `${status} --${ev.type}`).toMatchObject({ sameFailCount: 0, lastFailedCriteria: null });
    }
  });

  it('사장님이 다시 시도한 뒤에는 같은 조건이라도 기준만큼 다시 기회를 준다', () => {
    const afterRetry = decide(snap('blocked', { reworkCount: 4, lastFailedCriteria: ['조건 1'], sameFailCount: 4 }), { type: 'ceo.retry' }, ceo, ctx);
    const trail = replay(Array.from({ length: 5 }, () => ['조건 1']), { reworkCount: 4, ...afterRetry.patch });
    expect(trail).toEqual(['meeting', 'meeting', 'meeting', 'blocked']);
  });
});

describe('회의 사장님 판단 요청 → 막힘 (2026-10-23)', () => {
  it('회의 중에만, 오케스트레이터만 낼 수 있다', () => {
    expect(decide(snap('meeting'), { type: 'meeting.escalated' }, orch, ctx)).toMatchObject({ to: 'blocked', rule: '회의 사장님 판단 요청' });
    for (const actor of [assignee, reviewer, ceo]) expect(rejectCode(() => decide(snap('meeting'), { type: 'meeting.escalated' }, actor, ctx))).toBe('actor');
    expect(rejectCode(() => decide(snap('in_progress'), { type: 'meeting.escalated' }, orch, ctx))).toBe('no-transition');
  });
});

describe('기준을 넘긴 진행 중 티켓 막기 guard.repeat (기존 기록으로 채운 티켓)', () => {
  it(`같은 반려가 ${SAME_FAIL_LIMIT}회 이상이면 작업·검토·재작업·회의 어디서든 막힘`, () => {
    for (const s of ['in_progress', 'in_review', 'rework', 'meeting'] as const) {
      expect(decide(snap(s, { sameFailCount: SAME_FAIL_LIMIT }), { type: 'guard.repeat' }, orch, ctx).to).toBe('blocked');
    }
  });

  it('기준보다 적으면 거부한다', () => {
    expect(rejectCode(() => decide(snap('meeting', { sameFailCount: SAME_FAIL_LIMIT - 1 }), { type: 'guard.repeat' }, orch, ctx))).toBe('condition');
  });

  it('오케스트레이터만 건다', () => {
    expect(rejectCode(() => decide(snap('meeting', { sameFailCount: 9 }), { type: 'guard.repeat' }, ceo, ctx))).toBe('actor');
  });
});
