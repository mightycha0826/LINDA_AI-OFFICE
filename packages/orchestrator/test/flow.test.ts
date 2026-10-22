// MockLLM으로 돌리는 전체 흐름 (16장 1단계): 지시 → 계획 → 티켓 → 검토 → 재작업·회의 → 완료.
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { failReview, passReview, planOutput, type TicketInput } from '../src/brains/mock.ts';
import type { BrainRequest } from '../src/brains/brain.ts';
import { approvals, meetingMinutes, messages, orders, usage } from '../src/db/schema.ts';
import { CEO, approvedTickets, eventsOf, setup, statusTrail, ticket } from './helpers.ts';

const criteriaOf = (req: BrainRequest) => (req.input as TicketInput).ticket.acceptanceCriteria;

describe('전체 흐름', () => {
  it('바로 통과: in_progress → in_review → done, 지시도 done', async () => {
    const s = setup();
    const { order, tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(statusTrail(s, tk!.id)).toEqual(['planned', 'in_progress', 'in_review', 'done']);
    expect(s.db.select().from(orders).where(eq(orders.id, order.id)).get()!.status).toBe('done');
    // 리뷰어는 오케스트레이터가 직접 돌린 테스트 결과를 받았다
    expect(s.mock.callsFor('review')[0]!.input).toMatchObject({ tests: { passed: true, summary: 'mock: 12 passed' } });
    // 사용량은 호출마다 한 행
    expect(s.db.select().from(usage).all().length).toBe(s.mock.calls.length);
  });

  it('한 번 반려 → rework → 다시 제출 → 통과', async () => {
    const s = setup({ handlers: { review: (req, n) => (n === 1 ? failReview(criteriaOf(req), 'test-failed', '테스트 2개 실패') : passReview(criteriaOf(req))) } });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(statusTrail(s, tk!.id)).toEqual(['planned', 'in_progress', 'in_review', 'rework', 'in_progress', 'in_review', 'done']);
    expect(ticket(s, tk!.id).reworkCount).toBe(1);
    // 재작업 때 개발자는 리뷰어의 수정 요청을 받았다
    expect(JSON.stringify(s.mock.callsFor('work')[1]!.input)).toContain('테스트 2개 실패');
  });

  it('두 번째 반려 → 회의 → 합의 → 재작업 → 통과, 회의록은 코드가 채운다', async () => {
    const s = setup({
      handlers: {
        review: (req, n) => (n <= 2 ? failReview(criteriaOf(req), 'criteria-unmet', `반려 ${n}`) : passReview(criteriaOf(req))),
        meeting: (req) => ({ claim: `${req.employee.id}의 주장`, agree: true, nextActions: [`${req.employee.id} 할 일`] }),
      },
    });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(statusTrail(s, tk!.id)).toEqual([
      'planned', 'in_progress', 'in_review', 'rework', 'in_progress', 'in_review', 'meeting', 'in_progress', 'in_review', 'done',
    ]);
    const [m] = s.db.select().from(meetingMinutes).all();
    expect(m).toMatchObject({
      ticketId: tk!.id,
      kind: 'ticket-meeting',
      participants: ['developer', 'reviewer'],
      outcome: 'agreed',
      nextActions: ['developer 할 일', 'reviewer 할 일'],
      agenda: [{ criterion: '단위 테스트 통과', reason: '반려 2', reasonCategory: 'criteria-unmet' }],
      rounds: [{ round: 1, positions: [{ employeeId: 'developer', claim: 'developer의 주장' }, { employeeId: 'reviewer', claim: 'reviewer의 주장' }] }],
    });
    // 회의록을 만들려고 AI를 따로 부르지 않았다 (회의 발언 2번뿐)
    expect(s.mock.callsFor('meeting')).toHaveLength(2);
    expect(new Set(s.mock.calls.map((c) => c.task))).toEqual(new Set(['clarify', 'plan', 'gate', 'work', 'review', 'meeting']));
  });

  it('회의 2라운드 불합의 → blocked → CEO 다시 시도 → in_progress', async () => {
    const s = setup({
      handlers: {
        review: (req, n) => (n <= 2 ? failReview(criteriaOf(req)) : passReview(criteriaOf(req))),
        meeting: (req) => ({ claim: '입장 유지', agree: req.employee.id === 'developer', nextActions: [] }),
      },
    });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('blocked');
    expect(s.mock.callsFor('meeting')).toHaveLength(4); // 2명 × 최대 2라운드
    expect(s.db.select().from(meetingMinutes).get()).toMatchObject({ outcome: 'disagreed' });

    s.engine.ceoTicketAction(tk!.id, CEO, 'direct', '인터페이스만 먼저 만들어');
    expect(ticket(s, tk!.id).status).toBe('in_progress');
    expect(s.db.select().from(messages).all().some((m) => m.content.includes('인터페이스만 먼저'))).toBe(true);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('done');
  });

  it('회의 뒤 또 반려되면 다시 회의를 연다', async () => {
    const s = setup({ handlers: { review: (req, n) => (n <= 3 ? failReview(criteriaOf(req)) : passReview(criteriaOf(req))) } });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(statusTrail(s, tk!.id).filter((x) => x === 'meeting')).toHaveLength(2);
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'done', reworkCount: 3 });
  });

  it('결재가 필요한 티켓은 검토 통과 뒤 CEO 결재를 기다린다. 반려하면 rework(반려 횟수는 그대로)', async () => {
    const s = setup({ handlers: { plan: () => planOutput({ tickets: [{ ...planOutput().tickets[0]!, needsCeoApproval: true }] }) } });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('awaiting_approval');
    const a1 = s.db.select().from(approvals).where(eq(approvals.targetId, tk!.id)).get()!;
    expect(a1).toMatchObject({ kind: 'deploy', status: 'pending', reversible: 'partial' });

    s.engine.decide({ approvalId: a1.id, discordUserId: CEO, decision: 'rejected' });
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'rework', reworkCount: 0 });
    await s.engine.runUntilIdle();
    const a2 = s.db.select().from(approvals).where(eq(approvals.status, 'pending')).get()!;
    s.engine.decide({ approvalId: a2.id, discordUserId: CEO, decision: 'approved' });
    expect(ticket(s, tk!.id).status).toBe('done');
  });

  it('검토자가 완료 조건에 없는 기준으로 판정하면 받지 않는다', async () => {
    const s = setup({
      handlers: { review: (req, n) => (n === 1 ? failReview(['코드가 깔끔함'], 'criteria-unmet') : passReview(criteriaOf(req))) },
    });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(s.mock.callsFor('review')[1]).toMatchObject({ attempt: 2, previousError: expect.stringContaining('완료 조건에 없는 기준') });
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'done', reworkCount: 0 });
  });

  it('작업 출력 형식이 두 번 틀리면 티켓을 멈추고(system-error) /재개로 이어간다', async () => {
    const s = setup({ handlers: { work: (req, n) => (n <= 2 ? { summary: '' } : { summary: '됨', changedFiles: [], criteriaSelfCheck: [] }) } });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'paused', pauseReason: 'system-error', pausedFrom: 'in_progress' });
    expect(s.mock.callsFor('work')).toHaveLength(2);
    s.engine.resume(CEO);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('done');
  });

  it('티켓 6개짜리 계획도 모두 끝난다', async () => {
    const t = planOutput().tickets[0]!;
    const s = setup({
      handlers: {
        plan: () =>
          planOutput({
            tickets: [
              { ...t, title: '코드 1' },
              { ...t, title: '코드 2' },
              { ...t, title: '문구', type: 'marketing', assignee: 'marketing', reviewer: 'qa-local' },
              { ...t, title: '시장 조사', type: 'research', assignee: 'strategy', reviewer: 'qa-local' },
              { ...t, title: '설명서', type: 'writing', assignee: 'pm', reviewer: 'qa-local' },
              { ...t, title: '코드 3' },
            ],
          }),
      },
    });
    const { order, tickets: all } = await approvedTickets(s);
    expect(all).toHaveLength(6);
    await s.engine.runUntilIdle();
    expect(all.map((x) => ticket(s, x.id).status)).toEqual(Array(6).fill('done'));
    expect(s.db.select().from(orders).where(eq(orders.id, order.id)).get()!.status).toBe('done');
    // 이벤트 순번은 빈틈 없이 늘어난다 (SSE Last-Event-ID 기준)
    const seqs = eventsOf(s).map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });
});
