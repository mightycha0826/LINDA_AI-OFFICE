// 폭주 방지 (DESIGN.md 5장): 핑퐁 차단, 턴·토큰 상한.
import { describe, expect, it } from 'vitest';
import { enforceBudgets } from '../src/core/budget.ts';
import { raiseCaps, recordMessage } from '../src/core/guards.ts';
import { applyTicketEvent } from '../src/core/tickets.ts';
import { CEO, approvedTickets, orchestrator, setup, ticket } from './helpers.ts';

const chat = (ticketId: string, fromId: string, toId: string) => ({ ticketId, fromId, toId, kind: 'chat' as const, content: '이건 어때요?' });

describe('핑퐁 차단', () => {
  it('같은 쌍이 상태 변화 없이 3번 주고받으면 작업 중 티켓은 meeting으로', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    expect(recordMessage(s.ctx, chat(tk!.id, 'developer', 'reviewer')).pingpong).toBe(false);
    expect(recordMessage(s.ctx, chat(tk!.id, 'reviewer', 'developer')).pingpong).toBe(false);
    expect(recordMessage(s.ctx, chat(tk!.id, 'developer', 'reviewer')).pingpong).toBe(true);
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'meeting', pingpongCount: 0 });
  });

  it('회의 중에 또 핑퐁이면 blocked', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    applyTicketEvent(s.ctx, tk!.id, { type: 'guard.pingpong' }, orchestrator);
    for (let i = 0; i < 3; i++) recordMessage(s.ctx, chat(tk!.id, i % 2 ? 'reviewer' : 'developer', i % 2 ? 'developer' : 'reviewer'));
    expect(ticket(s, tk!.id).status).toBe('blocked');
  });

  it('다른 사람의 메시지가 끼면 다시 센다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    recordMessage(s.ctx, chat(tk!.id, 'developer', 'reviewer'));
    recordMessage(s.ctx, chat(tk!.id, 'reviewer', 'developer'));
    recordMessage(s.ctx, chat(tk!.id, 'pm', 'developer'));
    recordMessage(s.ctx, chat(tk!.id, 'developer', 'reviewer'));
    recordMessage(s.ctx, chat(tk!.id, 'reviewer', 'developer'));
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'in_progress', pingpongCount: 2 });
  });

  it('상태가 바뀌면 다시 센다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    recordMessage(s.ctx, chat(tk!.id, 'developer', 'reviewer'));
    recordMessage(s.ctx, chat(tk!.id, 'reviewer', 'developer'));
    applyTicketEvent(s.ctx, tk!.id, { type: 'ticket.submitted' }, { kind: 'employee', id: 'developer' });
    recordMessage(s.ctx, chat(tk!.id, 'developer', 'reviewer'));
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'in_review', pingpongCount: 1 });
  });

  it('회의 라운드 발언은 핑퐁으로 세지 않는다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    for (let i = 0; i < 5; i++) recordMessage(s.ctx, { ...chat(tk!.id, 'developer', 'reviewer'), countsForPingpong: false });
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'in_progress', pingpongCount: 0 });
  });
});

describe('턴·토큰 상한', () => {
  it('AI 호출마다 티켓의 턴과 토큰을 센다', async () => {
    const s = setup({ mock: { tokensPerCall: 25_000 } });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.step(); // 작업 1회
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'in_review', tokensUsed: 25_000, turnsUsed: 1 });
  });

  it('상한 도달 → paused(cap) → 시간이 지나도 그대로 → /재개로 이어감(몫을 한 번 더 줌)', async () => {
    const s = setup({ mock: { tokensPerCall: 25_000 }, handlers: { review: (req) => ({ verdict: 'fail', criteria: [{ criterion: (req.input as { ticket: { acceptanceCriteria: string[] } }).ticket.acceptanceCriteria[0]!, pass: false, reason: 'x' }], reasonCategory: 'test-failed', fixRequests: ['x'] }) } });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    const capped = ticket(s, tk!.id);
    expect(capped).toMatchObject({ status: 'paused', pauseReason: 'cap' });
    expect(capped.tokensUsed).toBeGreaterThanOrEqual(capped.tokenCap);

    s.clock.advanceHours(24 * 8);
    enforceBudgets(s.ctx);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('paused');

    s.engine.resume(CEO);
    const resumed = ticket(s, tk!.id);
    expect(resumed.status).not.toBe('paused');
    expect(resumed.tokenCap).toBe(capped.tokenCap + 60_000);
    expect(resumed.turnCap).toBe(80);
  });

  it('턴 상한도 같은 규칙', async () => {
    const s = setup({ config: { ticketCaps: { maxTurns: 3 } }, handlers: { review: (req) => ({ verdict: 'fail', criteria: [{ criterion: (req.input as { ticket: { acceptanceCriteria: string[] } }).ticket.acceptanceCriteria[0]!, pass: false, reason: 'x' }], reasonCategory: 'test-failed', fixRequests: ['x'] }) } });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'paused', pauseReason: 'cap', turnsUsed: 3 });
  });

  it('CEO가 상한을 올리면 이어간다', async () => {
    const s = setup({ config: { ticketCaps: { maxTurns: 1 } } });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'paused', pauseReason: 'cap' });
    raiseCaps(s.ctx, tk!.id, { turnCap: 10 });
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('done');
  });
});
