// 폭주 방지 (DESIGN.md 5장 핵심 규칙).
// - 핑퐁 차단: 같은 담당자·검토자 쌍이 상태 변화 없이 연속으로 주고받으면 guard.pingpong.
// - 턴·토큰 상한: 넘으면 paused(cap). 새 한도 창의 자동 재개는 quota-recovery.ts가 맡는다.
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

/**
 * 화면 말풍선용 한 줄 요약 (12장: 40자 이내). 직원 출력은 JSON이 많아서 원문을 자르면 괄호만 보인다.
 * JSON이면 summary → verdict/reason → document 첫 줄 순으로 고르고, 아니면 앞부분을 쓴다.
 */
export function messageSummary(content: string, max = 40): string {
  const clip = (x: string) => {
    const one = x.replace(/\s+/g, ' ').trim();
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
  };
  const at = content.indexOf('{');
  if (at >= 0) {
    try {
      const j = JSON.parse(content.slice(at)) as Record<string, unknown>;
      const prefix = content.slice(0, at).trim();
      const str = (k: string) => (typeof j[k] === 'string' && (j[k] as string).trim() ? (j[k] as string) : null);
      const verdict = j.verdict === 'pass' ? '통과' : j.verdict === 'fail' ? '반려' : null;
      const doc = str('document')
        ?.replace(/^#+\s*/gm, '')
        .split('\n')
        .find((l) => l.trim());
      // 교정 1차 점검·관문처럼 지적 목록만 있는 출력은 건수로 (원문 JSON이 말풍선에 보이지 않게)
      const issues = Array.isArray(j.issues) ? (j.issues.length ? `지적 ${j.issues.length}건` : '지적 없음') : null;
      const pick = str('summary') ?? (verdict ? [verdict, str('reason') ?? str('feedback')].filter(Boolean).join(': ') : null) ?? str('claim') ?? str('message') ?? doc ?? issues;
      if (pick) return clip(prefix && prefix.length < 20 ? `${prefix} ${pick}` : pick);
    } catch {
      /* JSON이 아니면 원문 */
    }
  }
  return clip(content);
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
    emit(t, 'message.sent', { messageId: id, ticketId: m.ticketId ?? null, from: m.fromId, to: m.toId ?? null, kind: m.kind, summary: messageSummary(m.content) });

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
