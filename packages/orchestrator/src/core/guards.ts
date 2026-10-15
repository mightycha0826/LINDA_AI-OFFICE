// 폭주 방지 (DESIGN.md 5장 핵심 규칙).
// - 핑퐁 차단: 같은 담당자·검토자 쌍이 상태 변화 없이 연속으로 주고받으면 guard.pingpong.
// - 턴·토큰 상한: 넘으면 paused(cap). 자동으로 풀리지 않는다.
import { eq } from 'drizzle-orm';
import type { MessageKind, ReasonCategory } from '@ai-office/shared';
import { emit, inTx, newId, nowIso, type Ctx } from '../context.ts';
import { messages, tickets } from '../db/schema.ts';
import { applyTicketEvent, getTicket } from './tickets.ts';

const orchestrator = { kind: 'orchestrator' } as const;

export interface MessageInput {
  ticketId?: string;
  orderId?: string;
  fromId: string;
  toId?: string;
  kind: MessageKind;
  content: string;
  reviewVerdict?: 'pass' | 'fail';
  reasonCategory?: ReasonCategory;
  tokens?: number;
  /** 회의 라운드처럼 횟수가 정해진 구조화 대화는 핑퐁으로 세지 않는다. */
  countsForPingpong?: boolean;
}

export function recordMessage(c: Ctx, m: MessageInput): { messageId: string; pingpong: boolean } {
  return inTx(c, (t) => {
    const id = newId();
    t.db
      .insert(messages)
      .values({
        id,
        ticketId: m.ticketId ?? null,
        orderId: m.orderId ?? null,
        fromId: m.fromId,
        toId: m.toId ?? null,
        kind: m.kind,
        content: m.content,
        reviewVerdict: m.reviewVerdict ?? null,
        reasonCategory: m.reasonCategory ?? null,
        tokens: m.tokens ?? 0,
        createdAt: nowIso(t),
      })
      .run();
    emit(t, 'message.sent', { messageId: id, ticketId: m.ticketId ?? null, from: m.fromId, to: m.toId ?? null, kind: m.kind, summary: m.content.slice(0, 40) });

    if (!m.ticketId || m.countsForPingpong === false) return { messageId: id, pingpong: false };
    const tk = getTicket(t, m.ticketId);
    const pair = new Set([tk.assigneeId, tk.reviewerId]);
    const betweenPair = !!m.toId && m.fromId !== m.toId && pair.has(m.fromId) && pair.has(m.toId);
    // 다른 사람의 메시지가 끼면 연속이 끊긴다
    const count = betweenPair ? tk.pingpongCount + 1 : 0;
    t.db.update(tickets).set({ pingpongCount: count }).where(eq(tickets.id, tk.id)).run();

    if (count >= t.config.pingpongLimit && ['in_progress', 'in_review', 'rework', 'meeting'].includes(tk.status)) {
      applyTicketEvent(t, tk.id, { type: 'guard.pingpong' }, orchestrator);
      return { messageId: id, pingpong: true };
    }
    return { messageId: id, pingpong: false };
  });
}

/** AI 호출 한 번을 티켓에 기록하고 상한을 넘으면 멈춘다. */
export function recordTurn(c: Ctx, ticketId: string, tokens: number): { capped: boolean } {
  return inTx(c, (t) => {
    const tk = getTicket(t, ticketId);
    const turnsUsed = tk.turnsUsed + 1;
    const tokensUsed = tk.tokensUsed + tokens;
    t.db.update(tickets).set({ turnsUsed, tokensUsed }).where(eq(tickets.id, ticketId)).run();
    const over = turnsUsed >= tk.turnCap || tokensUsed >= tk.tokenCap;
    if (over && tk.status !== 'paused' && tk.status !== 'done' && tk.status !== 'cancelled') {
      applyTicketEvent(t, ticketId, { type: 'system.pause', reason: 'cap' }, orchestrator);
      return { capped: true };
    }
    return { capped: over };
  });
}

/** 호출 전에 상한을 넘었는지 본다. */
export function isOverCap(c: Ctx, ticketId: string): boolean {
  const tk = getTicket(c, ticketId);
  return tk.turnsUsed >= tk.turnCap || tk.tokensUsed >= tk.tokenCap;
}

/** CEO가 상한을 올린다(/설정). 상한 때문에 멈춘 티켓이 이제 상한 안이면 이어간다. */
export function raiseCaps(c: Ctx, ticketId: string, caps: { tokenCap?: number; turnCap?: number }): void {
  inTx(c, (t) => {
    const tk = getTicket(t, ticketId);
    const tokenCap = Math.max(tk.tokenCap, caps.tokenCap ?? 0);
    const turnCap = Math.max(tk.turnCap, caps.turnCap ?? 0);
    t.db.update(tickets).set({ tokenCap, turnCap }).where(eq(tickets.id, ticketId)).run();
    emit(t, 'ticket.status', { ticketId, from: tk.status, to: tk.status, event: 'caps.raised', tokenCap, turnCap });
    if (tk.status === 'paused' && tk.pauseReason === 'cap' && tk.turnsUsed < turnCap && tk.tokensUsed < tokenCap) {
      applyTicketEvent(t, ticketId, { type: 'system.resume', cause: 'cap-raised' }, orchestrator);
    }
  });
}
