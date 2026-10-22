import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { planOutput } from '../src/brains/mock.ts';
import { answerClarification, clarificationOf } from '../src/core/clarifications.ts';
import { approvals, orders, plans, tickets } from '../src/db/schema.ts';
import { InteractionHandler } from '../src/discord/interactions.ts';
import { Notifier } from '../src/discord/notifier.ts';
import { FakeDiscord } from './fakes/fake-discord.ts';
import { CEO, STRANGER, pendingPlanApproval, setup } from './helpers.ts';

describe('PM 요구사항 대화', () => {
  it('질문 → 불충분한 답변 → 추가 질문 → 이해 확인 → 질문 없는 계획서만 결재', async () => {
    const s = setup({ handlers: { clarify: (_req, n) => ({ understanding: '예약 도구', questions: n === 1 ? ['누가 사용하나요?'] : n === 2 ? ['관리자는 예약을 취소할 수 있나요?'] : [] }) } });
    const { order } = s.engine.submitOrder({ discordMessageId: '123456789012345678', rawText: '예약 도구를 만들어줘', projectId: 'demo', channelId: 'project-work' });
    const port = new FakeDiscord();
    const notify = new Notifier(s.ctx, port);
    const handler = new InteractionHandler(s.ctx, s.engine);
    await s.engine.runUntilIdle();
    await notify.tick();
    expect(s.mock.callsFor('plan')).toHaveLength(0);
    expect(s.db.select().from(plans).all()).toHaveLength(0);
    expect(port.in('approvals')).toHaveLength(0);
    expect(port.in('secretary')[0]).toMatchObject({ channelId: 'project-work', content: expect.stringContaining('누가 사용하나요?') });
    const button = `cq:${order.id}:1`;
    expect(await handler.handle({ type: 'button', userId: STRANGER, customId: button })).toEqual({ kind: 'ignore' });
    expect(await handler.handle({ type: 'button', userId: CEO, customId: button })).toMatchObject({ kind: 'modal', customId: `cqm:${order.id}:1` });
    expect(await handler.handle({ type: 'modal', userId: CEO, customId: `cqm:${order.id}:1`, fields: { note: '관리자요' } })).toMatchObject({ kind: 'update' });
    await s.engine.runUntilIdle();
    await notify.tick();
    expect(s.mock.callsFor('plan')).toHaveLength(0);
    expect(port.in('secretary')).toHaveLength(2);
    expect(await handler.handle({ type: 'modal', userId: CEO, customId: `cqm:${order.id}:1`, fields: { note: '중복 답변' } })).toMatchObject({ kind: 'reply', ephemeral: true });
    answerClarification(s.ctx, order.id, 2, '관리자는 취소할 수 있어야 해요', CEO);
    await s.engine.runUntilIdle();
    await notify.tick();
    expect(s.mock.callsFor('clarify')).toHaveLength(3);
    expect(s.mock.callsFor('plan')[0]!.prompt.user).toContain('관리자는 취소할 수 있어야 해요');
    expect(port.in('approvals')).toHaveLength(1);
    expect(port.in('approvals')[0]!.content).not.toContain('PM 질문');
    expect(s.db.select().from(tickets).all()).toHaveLength(0);
    expect(pendingPlanApproval(s)).toBeDefined();
  });

  it('작성 중 질문이 생겨도 계획·결재를 저장하지 않고 질문부터 한다', async () => {
    const s = setup({ handlers: { plan: (_req, n) => planOutput({ questions: n === 1 ? ['알림도 필요한가요?'] : [] }) } });
    const { order } = s.engine.submitOrder({ discordMessageId: '123456789012345679', rawText: '예약 도구' });
    await s.engine.runUntilIdle();
    expect(s.db.select().from(plans).all()).toHaveLength(0);
    expect(pendingPlanApproval(s)).toBeUndefined();
    expect(clarificationOf(s.ctx, order.id).rounds[0]!.questions).toEqual(['알림도 필요한가요?']);
    expect(() => answerClarification(s.ctx, order.id, 1, '', CEO)).toThrow('답변을 입력');
    expect(() => answerClarification(s.ctx, order.id, 1, '예', STRANGER)).toThrow();
    // 새 Notifier/InteractionHandler에서도 DB에 저장된 질문에 이어서 답할 수 있다.
    await new InteractionHandler(s.ctx, s.engine).handle({ type: 'modal', userId: CEO, customId: `cqm:${order.id}:1`, fields: { note: '이메일로 보내줘' } });
    await s.engine.runUntilIdle();
    expect(pendingPlanApproval(s)).toBeDefined();
  });

  it('이전 방식의 질문 포함 결재를 회수하고 오래된 승인도 막는다', async () => {
    const s = setup();
    const { order } = s.engine.submitOrder({ discordMessageId: '123456789012345680', rawText: '예약 도구' });
    await s.engine.runUntilIdle();
    const approval = pendingPlanApproval(s)!;
    s.db.update(plans).set({ questions: ['기존에 미해결인 질문'] }).where(eq(plans.id, approval.targetId)).run();
    expect(() => s.engine.decide({ approvalId: approval.id, discordUserId: CEO, decision: 'approved' })).toThrow('답변을 먼저');
    await s.engine.runUntilIdle();
    expect(s.db.select().from(approvals).where(eq(approvals.id, approval.id)).get()!.status).toBe('expired');
    expect(s.db.select().from(orders).where(eq(orders.id, order.id)).get()!.status).toBe('planning');
    expect(clarificationOf(s.ctx, order.id).rounds[0]!.questions).toEqual(['기존에 미해결인 질문']);
  });
});
