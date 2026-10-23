// 비서실장 읽기 도구 (6장, 2026-10-22 CEO 결정으로 넓힘): 티켓 대화·회의록, 지시·계획서, 직원, 프로젝트.
// DB를 읽기만 하고 아무것도 바꾸지 않는다. 결과는 헤르메스가 읽기 쉬운 짧은 객체로 돌려준다.
import { desc, eq, notInArray } from 'drizzle-orm';
import type { Ctx } from '../context.ts';
import { isGuest } from '../core/budget.ts';
import { guestLine } from '../core/guests.ts';
import { latestPlan } from '../core/plans.ts';
import { employees, meetingMinutes, messages, orders, projects, tickets } from '../db/schema.ts';
import { readableDiscordText } from '../discord/format.ts';
import { personalNameOf } from '../staff/org.ts';

/** 티켓 하나의 대화 기록(최근 limit개)과 회의록 */
export function ticketLog(c: Ctx, ticketId: string, limit = 20) {
  const t = c.db.select().from(tickets).where(eq(tickets.id, ticketId)).get();
  if (!t) return { error: `${ticketId} 티켓이 없어요` };
  const log = c.db.select().from(messages).where(eq(messages.ticketId, t.id)).all().slice(-limit);
  const minutes = c.db.select().from(meetingMinutes).where(eq(meetingMinutes.ticketId, t.id)).all();
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    pauseReason: t.pauseReason,
    orderId: t.orderId,
    assignee: t.assigneeId,
    acceptanceCriteria: t.acceptanceCriteria,
    messages: log.map((m) => ({
      at: m.createdAt,
      from: m.fromId,
      to: m.toId,
      kind: m.kind,
      ...(m.reviewVerdict ? { verdict: m.reviewVerdict, reasonCategory: m.reasonCategory } : {}),
      text: readableDiscordText(m.content).slice(0, 1500),
    })),
    meetings: minutes.map((mm) => ({ at: mm.createdAt, outcome: mm.outcome, agenda: mm.agenda, rounds: mm.rounds, nextActions: mm.nextActions })),
  };
}

/** orderId가 없으면 최근 지시 15개, 있으면 그 지시의 원문·최신 계획서·티켓 */
export function orderInfo(c: Ctx, orderId?: string) {
  if (!orderId) {
    return c.db
      .select()
      .from(orders)
      .orderBy(desc(orders.createdAt))
      .limit(15)
      .all()
      .map((o) => ({ id: o.id, status: o.status, project: o.projectId, category: o.category, text: o.rawText.slice(0, 200), createdAt: o.createdAt }));
  }
  const o = c.db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!o) return { error: `${orderId} 지시가 없어요` };
  const plan = latestPlan(c, o.id);
  return {
    id: o.id,
    status: o.status,
    project: o.projectId,
    category: o.category,
    text: o.rawText,
    createdAt: o.createdAt,
    plan: plan
      ? {
          version: plan.version,
          status: plan.status,
          goal: plan.goal,
          questions: plan.questions,
          tickets: plan.tickets.map((pt) => ({ title: pt.title, type: pt.type, assignee: pt.assignee, reviewer: pt.reviewer, acceptanceCriteria: pt.acceptanceCriteria, needsCeoApproval: pt.needsCeoApproval })),
          estimate: plan.estimate,
          gate: plan.gateResult,
          ceoNote: plan.ceoNote,
        }
      : null,
    tickets: c.db
      .select()
      .from(tickets)
      .where(eq(tickets.orderId, o.id))
      .all()
      .map((t) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assigneeId, reviewer: t.reviewerId })),
  };
}

/** 직원에게 넘기는 참고 기록의 최대 개수 */
export const MAX_REFERENCES = 6;

/**
 * 글에 적힌 티켓(T-9)·지시(O-3) 번호의 기록 (2026-10-23 CEO 결정: 직원이 사장님께 기록을 붙여 달라고 묻지 않게).
 * 티켓은 최근 대화 6개(각 600자)와 회의 결론만, 지시는 원문·계획 목표·티켓 목록만.
 */
export function referencedRecords(c: Ctx, text: string, exclude: string[] = []) {
  const ids = [...new Set(text.toUpperCase().match(/\b[TO]-\d+\b/g) ?? [])].filter((id) => !exclude.includes(id)).slice(0, MAX_REFERENCES);
  return ids.flatMap((id): unknown[] => {
    if (id.startsWith('O-')) {
      const o = orderInfo(c, id);
      if (Array.isArray(o) || 'error' in o) return [];
      return [{ id: o.id, status: o.status, project: o.project, text: o.text.slice(0, 1500), goal: o.plan?.goal ?? null, tickets: o.tickets }];
    }
    const t = ticketLog(c, id, 6);
    if ('error' in t) return [];
    return [{ ...t, messages: t.messages.map((m) => ({ ...m, text: m.text.slice(0, 600) })), meetings: t.meetings.map((m) => ({ at: m.at, outcome: m.outcome, nextActions: m.nextActions })) }];
  });
}

/** 직원 목록. 나간 임시 직원은 뺀다. 파견 직원은 출근 여부와 사용률을 한 줄로 */
export function staffList(c: Ctx) {
  const active = c.db.select().from(tickets).where(notInArray(tickets.status, ['done', 'cancelled'])).all();
  return c.db
    .select()
    .from(employees)
    .all()
    .filter((e) => !(e.isTemporary && e.leftAt))
    .map((e) => ({
      id: e.id,
      name: personalNameOf(e.id),
      title: e.displayName,
      role: e.role,
      department: e.department,
      brain: e.brain.provider === 'ollama' ? `ollama ${e.brain.model}` : e.brain.provider,
      status: e.status,
      tickets: active.filter((t) => t.assigneeId === e.id).map((t) => `${t.id} ${t.status}`),
      ...(isGuest(e) ? { guest: guestLine(c, e) } : {}),
    }));
}

/** 등록된 프로젝트. 로컬 경로는 알리지 않는다 */
export function projectList(c: Ctx) {
  return c.db
    .select()
    .from(projects)
    .all()
    .map((p) => ({ id: p.id, repoUrl: p.repoUrl, defaultBranch: p.defaultBranch, testCommand: p.testCommand, hasChannel: !!p.discordChannelId }));
}
