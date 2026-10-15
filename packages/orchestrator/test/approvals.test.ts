// 결재 (DESIGN.md 7장, 9장): 두 번 클릭, CEO 외 계정, 오래된 버튼, 자동 승인 없음.
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { approvals, orders, plans, tickets } from '../src/db/schema.ts';
import { AlreadyDecidedError, NotCeoError, OfficeError, StaleApprovalError } from '../src/errors.ts';
import { CEO, STRANGER, eventsOf, orderUntilPlanApproval, pendingPlanApproval, setup } from './helpers.ts';

describe('결재 버튼', () => {
  it('같은 결재를 두 번 눌러도 한 번만 처리된다', async () => {
    const s = setup();
    const { approval } = await orderUntilPlanApproval(s);
    s.engine.decide({ approvalId: approval!.id, discordUserId: CEO, decision: 'approved' });
    expect(() => s.engine.decide({ approvalId: approval!.id, discordUserId: CEO, decision: 'approved' })).toThrow(AlreadyDecidedError);
    expect(() => s.engine.decide({ approvalId: approval!.id, discordUserId: CEO, decision: 'rejected' })).toThrow(AlreadyDecidedError);
    // 티켓은 한 번만 만들어진다
    expect(s.db.select().from(tickets).all()).toHaveLength(1);
    expect(eventsOf(s, 'approval.decided').filter((e) => (e.payload as { approvalId: string }).approvalId === approval!.id)).toHaveLength(1);
  });

  it('CEO 계정이 아니면 아무것도 바뀌지 않는다', async () => {
    const s = setup();
    const { approval } = await orderUntilPlanApproval(s);
    const before = eventsOf(s).length;
    expect(() => s.engine.decide({ approvalId: approval!.id, discordUserId: STRANGER, decision: 'approved' })).toThrow(NotCeoError);
    expect(eventsOf(s).length).toBe(before);
    expect(s.db.select().from(approvals).where(eq(approvals.id, approval!.id)).get()!.status).toBe('pending');
    expect(s.db.select().from(tickets).all()).toHaveLength(0);
  });

  it('계획서 v2가 올라오면 v1 버튼은 막힌다 ("새 버전이 있어요")', async () => {
    const s = setup();
    const { order, approval: v1 } = await orderUntilPlanApproval(s);
    s.engine.decide({ approvalId: v1!.id, discordUserId: CEO, decision: 'revision', note: '만료 시간은 24시간으로' });
    await s.engine.runUntilIdle();
    const v2 = pendingPlanApproval(s)!;
    expect(v2.targetVersion).toBe(2);

    // v1 버튼은 이미 결정됨. 다른 경로로 v1 계획서 결재가 남아 있었다면 expired → 새 버전 안내
    expect(() => s.engine.decide({ approvalId: v1!.id, discordUserId: CEO, decision: 'approved' })).toThrow(AlreadyDecidedError);
    const all = s.db.select().from(plans).where(eq(plans.orderId, order.id)).all();
    expect(all.map((p) => [p.version, p.status])).toEqual([
      [1, 'superseded'],
      [2, 'awaiting-ceo'],
    ]);
    // PM은 CEO 수정 요청을 입력으로 받았다
    const lastPlanCall = s.mock.callsFor('plan').at(-1)!;
    expect(JSON.stringify(lastPlanCall.input)).toContain('만료 시간은 24시간으로');
  });

  it('대기 중이던 결재가 새 버전에 밀리면 expired가 되고, 누르면 "새 버전이 있어요"', async () => {
    const s = setup();
    const { order, approval: v1 } = await orderUntilPlanApproval(s);
    // CEO가 v1을 누르기 전에 PM이 v2를 냈다 (예: CEO 접속 중 즉답을 반영)
    const { createPlanVersion, startGateReview, recordGateResult } = await import('../src/core/plans.ts');
    const { planOutput } = await import('../src/brains/mock.ts');
    const v2 = createPlanVersion(s.ctx, order.id, planOutput({ goal: 'v2 목표' }), { afterGateRejection: false });
    startGateReview(s.ctx, v2.id);
    recordGateResult(s.ctx, v2.id, { passed: true, issues: [], objection: null });

    expect(s.db.select().from(approvals).where(eq(approvals.id, v1!.id)).get()!.status).toBe('expired');
    expect(() => s.engine.decide({ approvalId: v1!.id, discordUserId: CEO, decision: 'approved' })).toThrow(StaleApprovalError);
    expect(s.db.select().from(tickets).all()).toHaveLength(0);
    const v2Approval = pendingPlanApproval(s)!;
    s.engine.decide({ approvalId: v2Approval.id, discordUserId: CEO, decision: 'approved' });
    expect(s.db.select().from(tickets).all()).toHaveLength(1);
  });

  it('시간이 아무리 지나도 자동 승인은 없다', async () => {
    const s = setup();
    const { order, approval } = await orderUntilPlanApproval(s);
    for (let day = 0; day < 30; day++) {
      s.clock.advanceHours(24);
      await s.engine.runUntilIdle();
    }
    expect(s.db.select().from(approvals).where(eq(approvals.id, approval!.id)).get()!.status).toBe('pending');
    expect(s.db.select().from(orders).where(eq(orders.id, order.id)).get()!.status).toBe('awaiting-plan-approval');
    expect(s.db.select().from(tickets).all()).toHaveLength(0);
    expect(eventsOf(s, 'approval.decided')).toHaveLength(0);
  });

  it('승인하면 티켓이 만들어지고 planned → in_progress로 간다', async () => {
    const s = setup();
    const { order, approval } = await orderUntilPlanApproval(s);
    s.engine.decide({ approvalId: approval!.id, discordUserId: CEO, decision: 'approved' });
    const [tk] = s.db.select().from(tickets).all();
    expect(tk).toMatchObject({ id: 'T-1', status: 'in_progress', orderId: order.id, assigneeId: 'developer', reviewerId: 'reviewer' });
    expect(tk!.tokenCap).toBe(60_000); // 예상 30,000 × 2
    expect(tk!.turnCap).toBe(40);
    expect(s.db.select().from(orders).where(eq(orders.id, order.id)).get()!.status).toBe('in-progress');
  });

  it('반려하면 지시가 rejected로 끝난다', async () => {
    const s = setup();
    const { order, approval } = await orderUntilPlanApproval(s);
    s.engine.decide({ approvalId: approval!.id, discordUserId: CEO, decision: 'rejected' });
    await s.engine.runUntilIdle();
    expect(s.db.select().from(orders).where(eq(orders.id, order.id)).get()!.status).toBe('rejected');
    expect(s.db.select().from(tickets).all()).toHaveLength(0);
  });

  it('수정 요청은 계획서와 규칙 결재에만 있다', async () => {
    const s = setup();
    const { requestApproval } = await import('../src/core/approvals.ts');
    const a = requestApproval(s.ctx, { kind: 'push', targetId: 'T-1', reversible: 'partial', summary: '푸시' });
    expect(() => s.engine.decide({ approvalId: a.id, discordUserId: CEO, decision: 'revision' })).toThrow(OfficeError);
    expect(s.db.select().from(approvals).where(eq(approvals.id, a.id)).get()!.status).toBe('pending');
  });

  it('결재 요청에는 되돌릴 수 있는지가 꼭 적힌다', async () => {
    const s = setup();
    const { approval } = await orderUntilPlanApproval(s);
    expect(approval!.reversible).toBe('reversible');
  });
});
