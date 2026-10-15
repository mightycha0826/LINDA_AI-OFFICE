// DB로도 지키는 불변 조건 (DESIGN.md 4장).
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { applyTicketEvent } from '../src/core/tickets.ts';
import { approvals, events, plans, tickets } from '../src/db/schema.ts';
import { TransitionRejected } from '../src/errors.ts';
import { approvedTickets, ceoActor, eventsOf, orchestrator, setup, ticket } from './helpers.ts';

describe('상태 변경과 이벤트는 같은 트랜잭션', () => {
  it('성공한 전환은 정확히 하나의 ticket.status 이벤트를 남긴다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    const before = eventsOf(s).length;
    applyTicketEvent(s.ctx, tk!.id, { type: 'system.pause', reason: 'budget' }, orchestrator);
    const after = eventsOf(s);
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)).toMatchObject({ type: 'ticket.status', payload: { ticketId: tk!.id, from: 'in_progress', to: 'paused' } });
  });

  it('거부된 전환은 상태도 이벤트도 남기지 않는다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    const before = eventsOf(s).length;
    expect(() => applyTicketEvent(s.ctx, tk!.id, { type: 'review.passed' }, { kind: 'employee', id: 'reviewer' })).toThrow(TransitionRejected);
    expect(eventsOf(s).length).toBe(before);
    expect(ticket(s, tk!.id).status).toBe('in_progress');
  });

  it('이벤트 기록이 실패하면 상태 변경도 되돌린다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    // events INSERT를 막아 트랜잭션 중간 실패를 만든다
    s.db.$client.exec(`CREATE TRIGGER block_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    expect(() => applyTicketEvent(s.ctx, tk!.id, { type: 'system.pause', reason: 'budget' }, orchestrator)).toThrow(/boom/);
    expect(ticket(s, tk!.id).status).toBe('in_progress');
  });
});

describe('DB 제약과 트리거', () => {
  it('events는 추가만 된다', async () => {
    const s = setup();
    await approvedTickets(s);
    expect(() => s.db.update(events).set({ type: 'git.push' }).run()).toThrow(/append-only/);
    expect(() => s.db.delete(events).run()).toThrow(/append-only/);
  });

  it('결정된 결재는 DB에서도 다시 바꿀 수 없다', async () => {
    const s = setup();
    await approvedTickets(s);
    const decided = s.db.select().from(approvals).where(eq(approvals.status, 'approved')).get()!;
    expect(() => s.db.update(approvals).set({ status: 'rejected' }).where(eq(approvals.id, decided.id)).run()).toThrow(/already decided/);
    expect(() => s.db.delete(approvals).run()).toThrow(/cannot be deleted/);
  });

  it('사람이 결정한 결재에는 결정자가 꼭 있다', async () => {
    const s = setup();
    await approvedTickets(s);
    s.db.$client.exec(`DROP TRIGGER approvals_decide_once`);
    const a = s.db.select().from(approvals).get()!;
    expect(() => s.db.update(approvals).set({ decidedByDiscordId: null }).where(eq(approvals.id, a.id)).run()).toThrow(/CHECK/);
  });

  it('끝난 티켓의 상태는 DB에서도 바뀌지 않는다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('done');
    expect(() => s.db.update(tickets).set({ status: 'in_progress' }).where(eq(tickets.id, tk!.id)).run()).toThrow(/already finished/);
  });

  it('검토자와 담당자는 같을 수 없다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    expect(() => s.db.update(tickets).set({ reviewerId: tk!.assigneeId }).where(eq(tickets.id, tk!.id)).run()).toThrow(/CHECK/);
  });

  it('paused가 아니면 pausedFrom·pauseReason이 없고, paused면 반드시 있다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    expect(() => s.db.update(tickets).set({ status: 'paused' }).where(eq(tickets.id, tk!.id)).run()).toThrow(/CHECK/);
    expect(() => s.db.update(tickets).set({ pausedFrom: 'in_review', pauseReason: 'budget' }).where(eq(tickets.id, tk!.id)).run()).toThrow(/CHECK/);
  });

  it('상태 값은 정해진 목록만', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    expect(() => s.db.$client.prepare(`UPDATE tickets SET status = 'finished' WHERE id = ?`).run(tk!.id)).toThrow(/CHECK/);
  });

  it('지시 하나에 살아 있는 계획서는 하나뿐', async () => {
    const s = setup();
    const { order } = s.engine.submitOrder({ discordMessageId: '1300000000000000999', rawText: 'x' });
    await s.engine.runUntilIdle();
    const live = s.db.select().from(plans).where(eq(plans.orderId, order.id)).get()!;
    expect(live.status).toBe('awaiting-ceo');
    expect(() =>
      s.db.insert(plans).values({ ...live, id: 'P-999', version: live.version + 1, status: 'draft' }).run(),
    ).toThrow(/UNIQUE/);
  });

  it('같은 Discord 메시지로는 지시가 하나만 생긴다', () => {
    const s = setup();
    const a = s.engine.submitOrder({ discordMessageId: '1300000000000000777', rawText: '첫 번째' });
    const b = s.engine.submitOrder({ discordMessageId: '1300000000000000777', rawText: '두 번째' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.order.id).toBe(a.order.id);
    expect(b.order.rawText).toBe('첫 번째');
    expect(eventsOf(s, 'order.created')).toHaveLength(1);
  });

  it('CEO 계정 확인: 결재 봇 actor라도 CEO가 아니면 전환이 거부된다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    expect(() => applyTicketEvent(s.ctx, tk!.id, { type: 'system.pause', reason: 'ceo-stop' }, { kind: 'approval-bot', discordUserId: '999999999999999999' })).toThrow(TransitionRejected);
    applyTicketEvent(s.ctx, tk!.id, { type: 'system.pause', reason: 'ceo-stop' }, ceoActor);
    expect(ticket(s, tk!.id).status).toBe('paused');
  });
});
