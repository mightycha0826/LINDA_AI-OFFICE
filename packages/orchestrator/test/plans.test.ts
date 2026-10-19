// 계획서와 GPT 관문 (DESIGN.md 5장, 6장).
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { planOutput } from '../src/brains/mock.ts';
import { checkPlanRules } from '../src/core/plans.ts';
import { meetingMinutes, orders, plans } from '../src/db/schema.ts';
import { eventsOf, orderUntilPlanApproval, setup } from './helpers.ts';

const failGate = (issue: string) => ({ passed: false, issues: [issue], objection: null });

describe('GPT 관문', () => {
  it('반려 2회 뒤에도 반려면 반대 의견을 붙여 CEO에게 올린다', async () => {
    const s = setup({ handlers: { gate: (_r, n) => failGate(`문제 ${n}: 완료 조건 '깔끔한 UI'는 확인할 수 없음`) } });
    const { order, approval } = await orderUntilPlanApproval(s);
    const all = s.db.select().from(plans).where(eq(plans.orderId, order.id)).orderBy(plans.version).all();
    expect(all.map((p) => [p.version, p.status, p.gateAttempts])).toEqual([
      [1, 'superseded', 1],
      [2, 'superseded', 2],
      [3, 'awaiting-ceo', 3],
    ]);
    expect(all[2]!.gateResult).toMatchObject({ passed: false, objection: expect.stringContaining('문제 3') });
    expect(approval).toMatchObject({ kind: 'plan', targetId: all[2]!.id, targetVersion: 3 });
    expect(s.mock.callsFor('gate')).toHaveLength(3);
    // PM은 관문 지적을 받아 고쳤다
    expect(JSON.stringify(s.mock.callsFor('plan')[1]!.input)).toContain('문제 1');
  });

  it('관문 반려 기록은 회의록(gate-review)으로 남는다. 코드가 계획서 JSON에서 채운다', async () => {
    const s = setup({ handlers: { gate: (_r, n) => failGate(`문제 ${n}`) } });
    await orderUntilPlanApproval(s);
    const [m] = s.db.select().from(meetingMinutes).all();
    expect(m).toMatchObject({ kind: 'gate-review', outcome: 'disagreed', participants: ['pm', 'reviewer'] });
    expect(m!.rounds).toHaveLength(3);
    expect(m!.rounds.map((r) => r.positions[1]!.claim)).toEqual(['문제 1', '문제 2', '문제 3']);
    expect(m!.agenda.map((a) => a.reason)).toEqual(['문제 1', '문제 2', '문제 3']);
    expect(eventsOf(s, 'meeting.minutes')).toHaveLength(1);
  });

  it('한 번 반려 뒤 통과하면 합의 회의록 2라운드', async () => {
    const s = setup({ handlers: { gate: (_r, n) => (n === 1 ? failGate('조건이 모호함') : { passed: true, issues: [], objection: null }) } });
    await orderUntilPlanApproval(s);
    const [m] = s.db.select().from(meetingMinutes).all();
    expect(m).toMatchObject({ outcome: 'agreed' });
    expect(m!.rounds).toHaveLength(2);
  });

  it('바로 통과하면 회의록을 만들지 않는다', async () => {
    const s = setup();
    await orderUntilPlanApproval(s);
    expect(s.db.select().from(meetingMinutes).all()).toHaveLength(0);
  });

  it('CEO 수정 요청 뒤에는 관문 반려 횟수를 새로 센다', async () => {
    const s = setup({ handlers: { gate: (_r, n) => (n <= 2 ? failGate(`문제 ${n}`) : { passed: true, issues: [], objection: null }) } });
    const { order, approval } = await orderUntilPlanApproval(s);
    s.engine.decide({ approvalId: approval!.id, discordUserId: s.config.ceoDiscordId, decision: 'revision', note: '범위를 줄여 주세요' });
    await s.engine.runUntilIdle();
    const latest = s.db.select().from(plans).where(eq(plans.orderId, order.id)).orderBy(plans.version).all().at(-1)!;
    expect(latest).toMatchObject({ version: 4, status: 'awaiting-ceo', gateAttempts: 0 });
  });

  it('GPT 한도가 떨어지면 관문 검사는 기다린다 (계획서는 gate-review에 머묾)', async () => {
    const s = setup({ config: { limits: { gpt: { fiveHour: { review: 0.5 } } } } });
    const { recordUsage } = await import('../src/core/budget.ts');
    recordUsage(s.ctx, { budget: 'review', inputTokens: 1, outputTokens: 1, estimatedPct: 1, estimatedWeeklyPct: 0.2, source: 'estimated' });
    const { order } = await orderUntilPlanApproval(s);
    expect(s.db.select().from(plans).where(eq(plans.orderId, order.id)).get()!.status).toBe('gate-review');
    expect(s.mock.callsFor('gate')).toHaveLength(0);
    // 5시간이 지나 한도가 다시 차면 이어간다
    s.clock.advanceHours(5.1);
    await s.engine.runUntilIdle();
    expect(s.db.select().from(plans).where(eq(plans.orderId, order.id)).get()!.status).toBe('awaiting-ceo');
  });
});

describe('계획서 코드 규칙', () => {
  it('검토자는 담당자와 다른 모델이어야 한다', () => {
    const s = setup();
    const sameModel = planOutput({
      tickets: [{ ...planOutput().tickets[0]!, type: 'research', assignee: 'strategy', reviewer: 'developer' }],
    });
    expect(checkPlanRules(s.ctx, sameModel)).toEqual([expect.stringContaining('같은 모델(claude)')]);
  });

  it('로컬 작성 → GPT 검토는 허용되고, 로컬끼리는 같은 모델이라 안 된다 (7-2부터 로컬은 Gemma 하나)', () => {
    const s = setup();
    const ok = planOutput({ tickets: [{ ...planOutput().tickets[0]!, type: 'marketing', assignee: 'marketing', reviewer: 'reviewer' }] });
    expect(checkPlanRules(s.ctx, ok)).toEqual([]);
    const local = planOutput({ tickets: [{ ...planOutput().tickets[0]!, type: 'marketing', assignee: 'marketing', reviewer: 'qa-local' }] });
    expect(checkPlanRules(s.ctx, local)).toEqual([expect.stringContaining('같은 모델(gemma4:12b-64k)')]);
  });

  it('Git 고양이는 담당자·검토자가 될 수 없고, 없는 직원도 안 된다', () => {
    const s = setup();
    const base = planOutput().tickets[0]!;
    expect(checkPlanRules(s.ctx, planOutput({ tickets: [{ ...base, assignee: 'git-cat' }] }))).toEqual([expect.stringContaining('AI 직원이 아니라')]);
    expect(checkPlanRules(s.ctx, planOutput({ tickets: [{ ...base, reviewer: 'ghost' }] }))).toEqual([expect.stringContaining('ghost')]);
  });

  it('PM이 규칙을 어기면 오류를 붙여 한 번 다시 시킨다', async () => {
    // 같은 모델 검토자는 코드가 고치므로(fixReviewers) 고치지 않는 위반(없는 직원)으로 본다
    const bad = planOutput({ tickets: [{ ...planOutput().tickets[0]!, assignee: 'developer', reviewer: 'ghost' }] });
    const s = setup({ handlers: { plan: (_r, n) => (n === 1 ? bad : planOutput()) } });
    const { approval } = await orderUntilPlanApproval(s);
    expect(approval).toBeDefined();
    const calls = s.mock.callsFor('plan');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ attempt: 2, previousError: expect.stringContaining('검토자 ghost') });
  });

  it('PM 출력이 두 번 틀리면 계획 작성을 멈추고 CEO의 다시 시도를 기다린다', async () => {
    const s = setup({ handlers: { plan: (_r, n) => (n <= 2 ? { goal: '' } : planOutput()) } });
    const { order, approval } = await orderUntilPlanApproval(s);
    expect(approval).toBeUndefined();
    expect(s.mock.callsFor('plan')).toHaveLength(2); // 무한 재시도 없음
    expect(s.db.select().from(orders).where(eq(orders.id, order.id)).get()!.status).toBe('planning');
    s.engine.retryPlanning(order.id, s.config.ceoDiscordId);
    await s.engine.runUntilIdle();
    expect(s.db.select().from(orders).where(eq(orders.id, order.id)).get()!.status).toBe('awaiting-plan-approval');
  });

  it('티켓은 최대 6개', async () => {
    const t = planOutput().tickets[0]!;
    const s = setup({ handlers: { plan: () => planOutput({ tickets: Array.from({ length: 7 }, (_, i) => ({ ...t, title: `티켓 ${i}` })) }) } });
    const { approval } = await orderUntilPlanApproval(s);
    expect(approval).toBeUndefined();
    expect(s.mock.callsFor('plan')[1]!.previousError).toContain('6');
  });
});
