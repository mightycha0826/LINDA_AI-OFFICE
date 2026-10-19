// 사용량 한도 칸막이 (DESIGN.md 8장).
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { planOutput } from '../src/brains/mock.ts';
import { budgetOf, budgetStatus, enforceBudgets, recordUsage } from '../src/core/budget.ts';
import { employees, messages, usage } from '../src/db/schema.ts';
import { approvedTickets, setup, ticket } from './helpers.ts';

/** 5시간 한도를 pct만큼, 주간 한도를 weekly만큼 쓴다 (기본: 5시간의 0.2배) */
const spend = (s: ReturnType<typeof setup>, budget: 'dev' | 'research' | 'review', pct: number, weekly = pct * 0.2) =>
  recordUsage(s.ctx, { budget, inputTokens: 1000, outputTokens: 500, estimatedPct: pct, estimatedWeeklyPct: weekly, source: 'estimated' });

describe('몫 칸막이', () => {
  it('개발 몫이 소진되면 개발 티켓을 멈추고, 5시간 창이 지나면 이어간다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    spend(s, 'dev', 55);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'paused', pauseReason: 'budget', pausedFrom: 'in_progress' });
    expect(s.mock.callsFor('work')).toHaveLength(0);

    s.clock.advanceHours(5.1);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('done');
  });

  it('주간 몫도 따로 본다 (5시간 창이 비어도 주간이 차 있으면 멈춤)', async () => {
    const s = setup();
    await approvedTickets(s);
    for (let i = 0; i < 4; i++) {
      spend(s, 'dev', 10, 10);
      s.clock.advanceHours(6);
    }
    expect(budgetStatus(s.ctx, 'dev')).toMatchObject({ fiveHour: { used: 0 }, weekly: { used: 40, limit: 39.5 }, exhausted: true });
  });

  it('빌려 쓰지 않는다: 리서치 몫이 남아도 개발 몫이 다 쓰였으면 멈춘다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    spend(s, 'dev', 55);
    expect(budgetStatus(s.ctx, 'research').exhausted).toBe(false);
    enforceBudgets(s.ctx);
    expect(ticket(s, tk!.id).status).toBe('paused');
  });

  it('검토 단계(in_review) 티켓은 개발 몫 소진으로 멈추지 않는다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.step(); // 작업 → in_review
    spend(s, 'dev', 55);
    enforceBudgets(s.ctx);
    expect(ticket(s, tk!.id).status).toBe('in_review');
  });

  it('GPT 몫이 소진되면 티켓은 in_review에서 기다린다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.step(); // 작업 → in_review
    spend(s, 'review', 100); // GPT 몫은 100% (2026-10-19)
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('in_review');
    expect(s.mock.callsFor('review')).toHaveLength(0);
    s.clock.advanceHours(5.1);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('done');
  });

  it('리서치 몫이 소진되면 로컬(저정밀 모드)로 계속하고 표시를 단다', async () => {
    const t = planOutput().tickets[0]!;
    const s = setup({ handlers: { plan: () => planOutput({ tickets: [{ ...t, title: '시장 조사', type: 'research', assignee: 'strategy', reviewer: 'qa-local' }] }) } });
    const { tickets: [tk] } = await approvedTickets(s);
    spend(s, 'research', 15);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'done', lowPrecision: true });
    const work = s.mock.callsFor('work')[0]!;
    expect(work.lowPrecision).toBe(true);
    // 리서치 몫이 아니라 로컬로 기록된다
    const rows = s.db.select().from(usage).where(eq(usage.ticketId, tk!.id)).all();
    expect(rows.every((r) => r.budget === 'local')).toBe(true);
    const handoff = s.db.select().from(messages).where(eq(messages.kind, 'handoff')).get()!;
    expect(handoff.content).toContain('저정밀 모드로 작성됨');
  });

  it('임시 직원이 Claude를 쓰면 개발 몫에서 가져간다', () => {
    const s = setup();
    s.db
      .insert(employees)
      .values({ id: 'temp-writer', displayName: '작가', role: 'temp', department: '임시', brain: { provider: 'claude-code', budget: 'research' }, spriteSet: 'temp-1', isTemporary: true })
      .run();
    const temp = s.db.select().from(employees).where(eq(employees.id, 'temp-writer')).get()!;
    expect(budgetOf(temp)).toBe('dev');
  });

  it('로컬 모델은 한도가 없다', () => {
    const s = setup();
    recordUsage(s.ctx, { budget: 'local', inputTokens: 10_000_000, outputTokens: 0, estimatedPct: 0, estimatedWeeklyPct: 0, source: 'estimated' });
    expect(budgetStatus(s.ctx, 'local').exhausted).toBe(false);
  });
});
