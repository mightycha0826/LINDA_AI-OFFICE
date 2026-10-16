// 티켓 상태를 바꾸는 유일한 길. decide()로 판단하고, 조건부 UPDATE와 events 기록을 한 트랜잭션에서 한다.
import { and, eq, inArray } from 'drizzle-orm';
import { emit, inTx, isStopped, newId, nowIso, type Ctx } from '../context.ts';
import { messages, orders, tickets } from '../db/schema.ts';
import { ConcurrentUpdateError, NotFoundError } from '../errors.ts';
import { decide, type Actor, type Decision, type TicketEvent } from './transitions.ts';
import { dismissFinishedTemps } from '../staff/temp-staff.ts';

export type TicketRow = typeof tickets.$inferSelect;

export function getTicket(c: Ctx, id: string): TicketRow {
  const row = c.db.select().from(tickets).where(eq(tickets.id, id)).get();
  if (!row) throw new NotFoundError(`티켓 ${id}`);
  return row;
}

function actorLabel(actor: Actor): string {
  return actor.kind === 'employee' ? actor.id : actor.kind === 'approval-bot' ? `discord:${actor.discordUserId}` : 'orchestrator';
}

export function applyTicketEvent(c: Ctx, ticketId: string, ev: TicketEvent, actor: Actor): Decision {
  return inTx(c, (t) => {
    const row = getTicket(t, ticketId);
    const decision = decide(row, ev, actor, { ceoDiscordId: t.config.ceoDiscordId, systemStopped: isStopped(t) });
    const now = nowIso(t);
    const result = t.db
      .update(tickets)
      .set({
        status: decision.to,
        ...decision.patch,
        pingpongCount: 0, // 상태가 바뀌면 핑퐁은 다시 센다
        version: row.version + 1,
        ...(decision.to === 'in_progress' && !row.startedAt ? { startedAt: now } : {}),
        ...(decision.to === 'done' || decision.to === 'cancelled' ? { finishedAt: now } : {}),
      })
      .where(and(eq(tickets.id, ticketId), eq(tickets.status, row.status), eq(tickets.version, row.version)))
      .run();
    if (result.changes !== 1) throw new ConcurrentUpdateError(`티켓 ${ticketId}`);

    emit(t, 'ticket.status', {
      ticketId,
      from: decision.from,
      to: decision.to,
      event: ev.type,
      rule: decision.rule,
      actor: actorLabel(actor),
      ...('reason' in ev ? { reason: ev.reason } : {}),
      ...('cause' in ev ? { cause: ev.cause } : {}),
      ...('reasonCategory' in ev ? { reasonCategory: ev.reasonCategory } : {}),
    });

    if (ev.type === 'ceo.direct') {
      t.db
        .insert(messages)
        .values({ id: newId(), ticketId, orderId: row.orderId, fromId: 'ceo', toId: row.assigneeId, kind: 'system', content: `CEO 방향 지시: ${ev.note}`, createdAt: now })
        .run();
    }
    if (decision.to === 'done' || decision.to === 'cancelled') {
      closeOrderIfFinished(t, row.orderId);
      dismissFinishedTemps(t, row.orderId);
    }
    return decision;
  });
}

/** 지시의 티켓이 모두 끝나면 지시도 끝낸다. */
function closeOrderIfFinished(c: Ctx, orderId: string): void {
  const open = c.db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.orderId, orderId), inArray(tickets.status, ['planned', 'in_progress', 'in_review', 'rework', 'meeting', 'blocked', 'awaiting_approval', 'paused'])))
    .all();
  if (open.length > 0) return;
  const anyDone = c.db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.orderId, orderId), eq(tickets.status, 'done'))).get();
  const status = anyDone ? 'done' : 'cancelled';
  c.db.update(orders).set({ status }).where(and(eq(orders.id, orderId), eq(orders.status, 'in-progress'))).run();
}
