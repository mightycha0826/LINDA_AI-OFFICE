// 회의와 회의록 (DESIGN.md 5장 회의록).
// AI에게 요약을 시키지 않는다. 회의 중 주고받은 JSON에서 코드가 정해진 양식을 채운다.
import { and, desc, eq, sql } from 'drizzle-orm';
import { ReviewOutputSchema, type CeoNeedKind, type MeetingKind, type MeetingOutcome, type MeetingPosition } from '@ai-office/shared';
import { emit, inTx, newId, nowIso, type Ctx } from '../context.ts';
import { meetingMinutes, messages, type MinutesAgendaItem, type MinutesRound } from '../db/schema.ts';

export type MinutesRow = typeof meetingMinutes.$inferSelect;

export interface MinutesInput {
  ticketId?: string;
  planId?: string;
  kind: MeetingKind;
  participants: string[];
  agenda: MinutesAgendaItem[];
  rounds: MinutesRound[];
  outcome: MeetingOutcome;
  nextActions: string[];
}

export function saveMinutes(c: Ctx, input: MinutesInput): MinutesRow {
  return inTx(c, (t) => {
    const row = t.db
      .insert(meetingMinutes)
      .values({
        id: newId(),
        ticketId: input.ticketId ?? null,
        planId: input.planId ?? null,
        kind: input.kind,
        participants: input.participants,
        agenda: input.agenda,
        rounds: input.rounds,
        outcome: input.outcome,
        nextActions: input.nextActions,
        createdAt: nowIso(t),
      })
      .returning()
      .get();
    emit(t, 'meeting.minutes', { minutesId: row.id, ticketId: row.ticketId, planId: row.planId, kind: row.kind, outcome: row.outcome });
    return row;
  });
}

export interface RoundPositions {
  round: number;
  positions: { employeeId: string; position: MeetingPosition }[];
}

/**
 * 라운드 기록에서 결론을 계산한다. 마지막 라운드 기준이다.
 * 한 명이라도 사장님 판단을 요청하면 합의 여부와 관계없이 needs-ceo (2026-10-23), 그다음 모두 동의하면 합의.
 */
export function concludeMeeting(rounds: RoundPositions[]): { outcome: MeetingOutcome; nextActions: string[]; rounds: MinutesRound[] } {
  const last = rounds.at(-1);
  const escalated = !!last && last.positions.some((p) => p.position.needsCeo);
  const agreed = !!last && last.positions.length > 0 && last.positions.every((p) => p.position.agree);
  const nextActions = [...new Set(last?.positions.flatMap((p) => p.position.nextActions) ?? [])];
  return {
    outcome: escalated ? 'needs-ceo' : agreed ? 'agreed' : 'disagreed',
    nextActions,
    rounds: rounds.map((r) => ({
      round: r.round,
      positions: r.positions.map((p) => ({ employeeId: p.employeeId, claim: p.position.claim, ...(p.position.needsCeo ? { needsCeo: p.position.needsCeo } : {}) })),
    })),
  };
}

/** 회의록에서 사장님 판단 요청(마지막 라운드)을 꺼낸다. 막힘 메시지에 쓴다 */
export function ceoRequestsOf(minutes: { rounds: MinutesRound[] }): { employeeId: string; kind: CeoNeedKind; question: string }[] {
  const last = minutes.rounds.at(-1);
  return (last?.positions ?? []).flatMap((p) => (p.needsCeo ? [{ employeeId: p.employeeId, ...p.needsCeo }] : []));
}

/** 안건 = 마지막 반려에서 통과하지 못한 완료 조건과 이유. 리뷰 메시지의 원문 JSON에서 가져온다. */
export function agendaFromLastReview(c: Ctx, ticketId: string): MinutesAgendaItem[] {
  const msg = c.db
    .select()
    .from(messages)
    .where(and(eq(messages.ticketId, ticketId), eq(messages.kind, 'review'), eq(messages.reviewVerdict, 'fail')))
    .orderBy(desc(sql`rowid`)) // 같은 시각이어도 넣은 순서대로
    .limit(1)
    .get();
  if (!msg || !msg.reasonCategory) return [];
  const category = msg.reasonCategory;
  const parsed = ReviewOutputSchema.safeParse(safeJson(msg.content));
  if (!parsed.success) return [{ criterion: '(원문을 읽지 못함)', reason: msg.content.slice(0, 200), reasonCategory: category }];
  return parsed.data.criteria.filter((cr) => !cr.pass).map((cr) => ({ criterion: cr.criterion, reason: cr.reason ?? '', reasonCategory: category }));
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
