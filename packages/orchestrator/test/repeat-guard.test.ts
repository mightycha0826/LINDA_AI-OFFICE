// 같은 반려 반복 막기 (DESIGN.md 5장, 2026-10-23 CEO 결정): 같은 조건 4회째 막힘, 회의의 사장님 판단 요청, 기존 기록 채우기.
import { describe, expect, it } from 'vitest';
import { failReview, passReview, planOutput, type TicketInput } from '../src/brains/mock.ts';
import type { BrainRequest } from '../src/brains/brain.ts';
import { emit } from '../src/context.ts';
import { recordMessage } from '../src/core/guards.ts';
import { concludeMeeting } from '../src/core/meeting.ts';
import { backfillRepeatCounts, blockRepeatedFailures, repeatFromHistory } from '../src/core/repeat-guard.ts';
import { meetingMinutes, messages } from '../src/db/schema.ts';
import { Notifier } from '../src/discord/notifier.ts';
import { buildReportData, formatReportData } from '../src/reports.ts';
import { FakeDiscord } from './fakes/fake-discord.ts';
import { approvedTickets, CEO, setup, statusTrail, ticket, type Setup } from './helpers.ts';

const criteriaOf = (req: BrainRequest) => (req.input as TicketInput).ticket.acceptanceCriteria;
const agreeOnly = () => ({ claim: '반려가 맞아요', agree: true, nextActions: ['다시 고친다'] });

describe('같은 완료 조건 반복 반려 (엔진)', () => {
  it('같은 조건이 4번 연속 반려되면 회의 두 번 뒤 막히고, #막힘에 이유가 붙는다', async () => {
    const s = setup({ handlers: { review: (req) => failReview(criteriaOf(req)), meeting: agreeOnly } });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(statusTrail(s, tk!.id)).toEqual([
      'planned', 'in_progress', 'in_review', 'rework', 'in_progress', 'in_review', 'meeting', 'in_progress', 'in_review', 'meeting', 'in_progress', 'in_review', 'blocked',
    ]);
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'blocked', reworkCount: 4, sameFailCount: 4, lastFailedCriteria: [criteriaOf(s.mock.callsFor('review')[0]!)[0]] });
    expect(s.mock.callsFor('review')).toHaveLength(4);

    const discord = new FakeDiscord();
    await new Notifier(s.ctx, discord).tick();
    const [blocked] = discord.in('blocked');
    expect(blocked!.content).toContain('같은 완료 조건이 4번 연속 반려됐어요');
    expect(blocked!.content).toContain(`- ${ticket(s, tk!.id).acceptanceCriteria[0]}`);
    expect(blocked!.buttons!.flat().map((b) => b.label)).toEqual(['다시 시도', '방향 지시', '취소']);
    // 정기 보고의 '막힌 것'에 이유가 붙는다
    expect(formatReportData(buildReportData(s.ctx, '2026-10-01T00:00:00Z'))).toContain(`${tk!.id} ${tk!.title} (같은 조건 반복 반려)`);
  });

  it('조건 묶음이 바뀌며 고쳐 나가면 막지 않는다', async () => {
    // 1번 조건 → 1·2번 → 1번 → 1번 → 통과 (T-10처럼 묶음 연속 횟수가 3을 넘지 않음)
    const failing = (req: BrainRequest, n: number) => {
      const all = criteriaOf(req);
      const which = n === 2 ? all : all.slice(0, 1);
      return { verdict: 'fail', criteria: all.map((criterion) => ({ criterion, pass: !which.includes(criterion), ...(which.includes(criterion) ? { reason: 'x' } : {}) })), reasonCategory: 'criteria-unmet', fixRequests: ['x'] };
    };
    const s = setup({
      handlers: {
        plan: () => planOutput({ tickets: [{ ...planOutput().tickets[0]!, acceptanceCriteria: ['단위 테스트 통과', '빌드 성공'] }] }),
        review: (req, n) => (n <= 4 ? failing(req, n) : passReview(criteriaOf(req))),
        meeting: agreeOnly,
      },
    });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'done', reworkCount: 4, sameFailCount: 0, lastFailedCriteria: null });
  });

  it('사장님이 다시 시도하면 처음부터 다시 센다', async () => {
    const s = setup({ handlers: { review: (req, n) => (n <= 4 ? failReview(criteriaOf(req)) : passReview(criteriaOf(req))), meeting: agreeOnly } });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('blocked');
    s.engine.ceoTicketAction(tk!.id, CEO, 'retry');
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'in_progress', sameFailCount: 0, lastFailedCriteria: null });
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('done');
  });
});

describe('회의에서 사장님 판단 요청', () => {
  it('한 명만 요청해도 합의 여부와 관계없이 막힘. 회의록과 #막힘에 질문이 남는다', async () => {
    const s = setup({
      handlers: {
        review: (req) => failReview(criteriaOf(req)),
        meeting: (req) =>
          req.employee.id === 'developer'
            ? { claim: '자료가 없어 고칠 수 없어요', agree: true, nextActions: [], needsCeo: { kind: 'missing-input', question: '승인된 문구 초안을 주실 수 있나요?' } }
            : { claim: '담당자가 고쳐 주세요', agree: true, nextActions: ['다시 제출'] },
      },
    });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(statusTrail(s, tk!.id).slice(-2)).toEqual(['meeting', 'blocked']);
    expect(s.mock.callsFor('meeting')).toHaveLength(2); // 둘 다 동의해서 1라운드로 끝남
    const m = s.db.select().from(meetingMinutes).get()!;
    expect(m.outcome).toBe('needs-ceo');
    expect(m.rounds[0]!.positions[0]).toMatchObject({ employeeId: 'developer', needsCeo: { kind: 'missing-input', question: '승인된 문구 초안을 주실 수 있나요?' } });
    expect(m.rounds[0]!.positions[1]).not.toHaveProperty('needsCeo');
    expect(s.db.select().from(messages).all().some((x) => x.content.includes(': 사장님 판단 요청 · 다음 할 일'))).toBe(true);

    const discord = new FakeDiscord();
    await new Notifier(s.ctx, discord).tick();
    const [blocked] = discord.in('blocked');
    expect(blocked!.content).toContain('회의에서 사장님 판단을 요청했어요');
    expect(blocked!.content).toContain('- [자료 없음] developer: 승인된 문구 초안을 주실 수 있나요?');
    expect(blocked!.content).toContain('**회의 결론**: 사장님 판단 요청');
    expect(buildReportData(s.ctx, '2026-10-01T00:00:00Z').blocked).toEqual([{ id: tk!.id, title: tk!.title, cause: 'needs-ceo' }]);
  });

  it('판정 순서: 사장님 판단 요청 > 합의 > 불합의 (마지막 라운드 기준)', () => {
    const pos = (agree: boolean, ask = false) => ({ claim: 'c', agree, nextActions: [], ...(ask ? { needsCeo: { kind: 'workspace' as const, question: 'q' } } : {}) });
    const one = (...p: ReturnType<typeof pos>[]) => [{ round: 1, positions: p.map((position, i) => ({ employeeId: `e${i}`, position })) }];
    expect(concludeMeeting(one(pos(true), pos(true))).outcome).toBe('agreed');
    expect(concludeMeeting(one(pos(true), pos(false))).outcome).toBe('disagreed');
    expect(concludeMeeting(one(pos(false, true), pos(false))).outcome).toBe('needs-ceo');
    expect(concludeMeeting(one(pos(true), pos(true, true))).outcome).toBe('needs-ceo');
    // 앞 라운드의 요청은 보지 않는다
    expect(concludeMeeting([...one(pos(false, true), pos(false)), { round: 2, positions: [{ employeeId: 'e0', position: pos(true) }, { employeeId: 'e1', position: pos(true) }] }]).outcome).toBe('agreed');
  });
});

describe('기존 기록으로 같은 반려 횟수 채우기 (업데이트 전부터 돌던 티켓)', () => {
  const review = (s: Setup, ticketId: string, out: object) => {
    recordMessage(s.ctx, { ticketId, fromId: 'reviewer', toId: 'developer', kind: 'review', content: JSON.stringify(out), reviewVerdict: (out as { verdict: 'pass' | 'fail' }).verdict, reasonCategory: 'criteria-unmet', countsForPingpong: false });
    s.clock.advance(60_000);
  };

  it('반려 기록으로 횟수를 한 번만 채우고, 기준을 넘긴 진행 중 티켓은 다음 바퀴에 막힘', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    const crit = tk!.acceptanceCriteria;
    for (let i = 0; i < 5; i++) review(s, tk!.id, failReview(crit));
    expect(repeatFromHistory(s.ctx, tk!.id)).toEqual({ lastFailedCriteria: [crit[0]], sameFailCount: 5, failStreaks: { [crit[0]!]: 5 } });

    expect(backfillRepeatCounts(s.ctx)).toEqual([{ ticketId: tk!.id, sameFailCount: 5, maxStreak: 5 }]);
    expect(backfillRepeatCounts(s.ctx)).toEqual([]); // 한 번만
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'in_progress', sameFailCount: 5 });

    await s.engine.step();
    expect(ticket(s, tk!.id).status).toBe('blocked');
    expect(s.mock.callsFor('work')).toHaveLength(0); // 더 일하지 않았다
    const discord = new FakeDiscord();
    await new Notifier(s.ctx, discord).tick();
    expect(discord.in('blocked')[0]!.content).toContain('같은 완료 조건이 5번 연속 반려됐어요');
  });

  it('통과·사장님 결정·읽지 못한 반려가 끼면 그 뒤부터 센다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    const crit = tk!.acceptanceCriteria;
    review(s, tk!.id, failReview(crit));
    review(s, tk!.id, failReview(crit));
    emit(s.ctx, 'ticket.status', { ticketId: tk!.id, from: 'blocked', to: 'in_progress', event: 'ceo.retry' });
    s.clock.advance(60_000);
    review(s, tk!.id, failReview(crit));
    expect(repeatFromHistory(s.ctx, tk!.id).sameFailCount).toBe(1);
    recordMessage(s.ctx, { ticketId: tk!.id, fromId: 'reviewer', kind: 'review', content: '읽을 수 없는 글', reviewVerdict: 'fail', reasonCategory: 'criteria-unmet', countsForPingpong: false });
    s.clock.advance(60_000);
    expect(repeatFromHistory(s.ctx, tk!.id)).toEqual({ lastFailedCriteria: null, sameFailCount: 0, failStreaks: null });
    review(s, tk!.id, failReview(crit));
    review(s, tk!.id, passReview(crit));
    expect(repeatFromHistory(s.ctx, tk!.id).sameFailCount).toBe(0);
  });

  it('기준보다 적으면 막지 않는다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    for (let i = 0; i < 3; i++) review(s, tk!.id, failReview(tk!.acceptanceCriteria));
    backfillRepeatCounts(s.ctx);
    expect(blockRepeatedFailures(s.ctx)).toEqual([]);
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'in_progress', sameFailCount: 3 });
  });
});

describe('같은 조건 하나가 연속 6회 반려 (2026-10-23 보강)', () => {
  const twoCriteria = () => planOutput({ tickets: [{ ...planOutput().tickets[0]!, acceptanceCriteria: ['선행 티켓 통과', '병합 보고'] }] });
  /** 홀수 번째는 두 조건 모두, 짝수 번째는 '병합 보고'만 반려 (T-19처럼 묶음이 번갈아 바뀜) */
  const alternating = (req: BrainRequest, n: number) => {
    const all = criteriaOf(req);
    const failing = n % 2 ? all : all.slice(1);
    return { verdict: 'fail', criteria: all.map((criterion) => ({ criterion, pass: !failing.includes(criterion), ...(failing.includes(criterion) ? { reason: 'x' } : {}) })), reasonCategory: 'criteria-unmet', fixRequests: ['x'] };
  };

  it('묶음이 번갈아 바뀌어도 6번째 반려에서 막히고, #막힘에 그 조건과 횟수가 붙는다', async () => {
    const s = setup({ handlers: { plan: twoCriteria, review: alternating, meeting: agreeOnly } });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'blocked', reworkCount: 6, sameFailCount: 1, failStreaks: { '병합 보고': 6 } });
    const discord = new FakeDiscord();
    await new Notifier(s.ctx, discord).tick();
    const [blocked] = discord.in('blocked');
    expect(blocked!.content).toContain('같은 완료 조건이 6번 연속 반려됐어요 (다른 조건은 반려와 통과를 오감)');
    expect(blocked!.content).toContain('- 병합 보고 (6번)');
  });

  it('기존 기록으로 조건별 횟수도 채워서, 재개하면 바로 막힌다', async () => {
    const s = setup({ handlers: { plan: twoCriteria } });
    const { tickets: [tk] } = await approvedTickets(s);
    const req = { input: { ticket: { acceptanceCriteria: tk!.acceptanceCriteria } } } as unknown as BrainRequest;
    for (let n = 1; n <= 7; n++) {
      recordMessage(s.ctx, { ticketId: tk!.id, fromId: 'reviewer', toId: 'developer', kind: 'review', content: JSON.stringify(alternating(req, n)), reviewVerdict: 'fail', reasonCategory: 'criteria-unmet', countsForPingpong: false });
      s.clock.advance(60_000);
    }
    expect(repeatFromHistory(s.ctx, tk!.id)).toMatchObject({ sameFailCount: 1, failStreaks: { '선행 티켓 통과': 1, '병합 보고': 7 } });
    expect(backfillRepeatCounts(s.ctx)).toEqual([{ ticketId: tk!.id, sameFailCount: 1, maxStreak: 7 }]);
    expect(blockRepeatedFailures(s.ctx)).toEqual([tk!.id]);
    expect(ticket(s, tk!.id).status).toBe('blocked');
  });
});
