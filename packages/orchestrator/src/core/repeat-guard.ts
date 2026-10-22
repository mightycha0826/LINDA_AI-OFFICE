// 같은 반려 반복 막기 (DESIGN.md 5장, 2026-10-23 CEO 결정).
// - 반려 때의 판단은 전환표(transitions.ts)가 한다: 같은 완료 조건 묶음이 SAME_FAIL_LIMIT번 연속 반려되면 막힘.
// - 여기서는 그 횟수를 기존 기록으로 한 번 채우고(업데이트 전에 이미 돌던 티켓), 기준을 넘긴 진행 중 티켓을 막힘으로 보낸다.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { ReviewOutputSchema } from '@ai-office/shared';
import { getState, inTx, setState, type Ctx } from '../context.ts';
import { events, messages, tickets } from '../db/schema.ts';
import { applyTicketEvent } from './tickets.ts';
import { failedCriteriaKey, SAME_FAIL_LIMIT } from './transitions.ts';

const orchestrator = { kind: 'orchestrator' } as const;
const BACKFILL_KEY = 'repeatGuard.backfilledAt';
/** 같은 반려 횟수를 처음부터 다시 세게 하는 사장님 결정 (transitions.ts의 clearRepeat와 같은 목록) */
const CEO_RESETS = new Set(['ceo.retry', 'ceo.direct', 'ceo.revise', 'approval.rejected']);
const OPEN = ['planned', 'in_progress', 'in_review', 'rework', 'meeting', 'blocked', 'awaiting_approval', 'paused'] as const;

/** 기록으로 계산한 같은 반려 횟수. 통과나 사장님 결정이 있으면 0부터, 읽지 못한 반려도 0부터 센다(잘못 막지 않게) */
export function repeatFromHistory(c: Ctx, ticketId: string): { lastFailedCriteria: string[] | null; sameFailCount: number } {
  const reviews = c.db
    .select()
    .from(messages)
    .where(and(eq(messages.ticketId, ticketId), eq(messages.kind, 'review')))
    .orderBy(asc(messages.createdAt), sql`rowid`)
    .all()
    .map((m) => ({ at: m.createdAt, verdict: m.reviewVerdict, content: m.content }));
  const resets = c.db
    .select()
    .from(events)
    .where(and(eq(events.type, 'ticket.status'), sql`json_extract(${events.payload}, '$.ticketId') = ${ticketId}`))
    .orderBy(asc(events.seq))
    .all()
    .filter((e) => CEO_RESETS.has(String((e.payload as { event?: unknown }).event)))
    .map((e) => ({ at: e.createdAt, verdict: 'reset' as const, content: '' }));

  let last: string[] | null = null;
  let count = 0;
  for (const r of [...reviews, ...resets].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
    if (r.verdict !== 'fail') {
      last = null;
      count = 0;
      continue;
    }
    const parsed = ReviewOutputSchema.safeParse(safeJson(r.content));
    if (!parsed.success) {
      last = null;
      count = 0;
      continue;
    }
    const failed = failedCriteriaKey(parsed.data.criteria.filter((x) => !x.pass).map((x) => x.criterion));
    count = last && last.length === failed.length && last.every((x, i) => x === failed[i]) ? count + 1 : 1;
    last = failed;
  }
  return { lastFailedCriteria: last, sameFailCount: count };
}

/**
 * 업데이트 전부터 돌던 티켓의 같은 반려 횟수를 기존 기록으로 한 번 채운다 (2026-10-23 CEO 결정).
 * 한 번만 한다. 채운 티켓 ID와 횟수를 돌려준다.
 */
export function backfillRepeatCounts(c: Ctx): { ticketId: string; sameFailCount: number }[] {
  if (getState(c, BACKFILL_KEY, null)) return [];
  return inTx(c, (t) => {
    const filled: { ticketId: string; sameFailCount: number }[] = [];
    for (const tk of t.db.select().from(tickets).where(inArray(tickets.status, [...OPEN])).all()) {
      const r = repeatFromHistory(t, tk.id);
      if (r.sameFailCount === 0) continue;
      t.db.update(tickets).set(r).where(eq(tickets.id, tk.id)).run();
      filled.push({ ticketId: tk.id, sameFailCount: r.sameFailCount });
    }
    setState(t, BACKFILL_KEY, t.clock.now().toISOString());
    return filled;
  });
}

/** 같은 반려가 이미 기준만큼 쌓인 진행 중 티켓을 막힘으로 보낸다. 막은 티켓 ID를 돌려준다 */
export function blockRepeatedFailures(c: Ctx): string[] {
  const stuck = c.db
    .select()
    .from(tickets)
    .where(inArray(tickets.status, ['in_progress', 'in_review', 'rework', 'meeting']))
    .all()
    .filter((tk) => tk.sameFailCount >= SAME_FAIL_LIMIT);
  for (const tk of stuck) applyTicketEvent(c, tk.id, { type: 'guard.repeat' }, orchestrator);
  return stuck.map((tk) => tk.id);
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
