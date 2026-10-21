// 직원 직접 지시와 진행 중 수정 (9장 직원 봇, 2026-10-21 CEO 결정).
// 주인이 직원 봇을 멘션해 일을 맡기면, 로컬 Gemma가 "지시"로 읽은 내용을 제안으로만 남긴다.
// 실제로 일이 생기는 것은 주인이 LINDA의 [맡기고 시작] 버튼을 눌렀을 때뿐이다(이 버튼이 계획서 결재 한 번).
// 진행 중인 일을 고쳐 달라는 말도 [수정 반영] 버튼을 눌러야 완료 조건에 붙는다.
// 버튼 전에는 상태가 바뀌지 않고, 제안은 30분 뒤 끝나며 한 번만 쓸 수 있다. 푸시 결재는 그대로다.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PmPlanOutput, TicketType } from '@ai-office/shared';
import { getState, inTx, newId, nowIso, setState, type Ctx } from '../context.ts';
import { employees, messages, plans, tickets } from '../db/schema.ts';
import { assertCeo, NotFoundError, OfficeError } from '../errors.ts';
import { projectByChannel } from '../workspace/projects.ts';
import { registerOrder } from './orders.ts';
import { applyCeoPlanDecision, createPlanVersion, REVIEWER_ORDER } from './plans.ts';
import { applyTicketEvent } from './tickets.ts';

/** 제안이 유효한 시간 */
export const DIRECT_PROPOSAL_TTL_MS = 30 * 60_000;
const PROPOSALS = 'direct.proposals';
const ORIGINS = 'direct.origins';
const MAX_KEPT = 50;

/** 직원 직접 지시를 받을 수 있는 직원과 그 티켓 종류. Git 고양이(코드)·비서실장(헤르메스)·보조 직원은 없다 */
export const DIRECT_TICKET_TYPE: Readonly<Record<string, TicketType>> = {
  pm: 'writing',
  developer: 'coding',
  'dev-a': 'coding',
  'dev-b': 'coding',
  reviewer: 'research',
  marketing: 'marketing',
  strategy: 'research',
  'qa-local': 'writing',
};
/** 직접 지시 티켓의 예상 토큰 (6장 PM 역할 카드의 기준과 같은 크기) */
const ESTIMATE: Record<TicketType, number> = { coding: 50_000, research: 30_000, marketing: 30_000, strategy: 30_000, writing: 30_000 };
/** 진행 중 수정을 받는 티켓 상태. 푸시 결재 대기는 #결재함의 [반려]로 고친다 */
const REVISABLE = ['in_progress', 'rework', 'in_review'] as const;

export interface Origin {
  channelId: string;
  /** 주인이 직원 봇을 멘션한 메시지 */
  messageId: string;
}

export type DirectProposal = Origin & {
  id: string;
  employeeId: string;
  createdAt: string;
  used: boolean;
} & ({ kind: 'order'; rawText: string; title: string; type: TicketType; criteria: string[]; projectId: string | null } | { kind: 'revise'; ticketId: string; note: string });

type Proposals = Record<string, DirectProposal>;

function save(c: Ctx, p: DirectProposal): DirectProposal {
  const all = getState<Proposals>(c, PROPOSALS, {});
  // 오래된 것부터 지워 최대 MAX_KEPT개만 남긴다
  const kept = Object.values(all)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-(MAX_KEPT - 1));
  setState(c, PROPOSALS, Object.fromEntries([...kept, p].map((x) => [x.id, x])));
  return p;
}

export function getProposal(c: Ctx, id: string): DirectProposal | null {
  return getState<Proposals>(c, PROPOSALS, {})[id] ?? null;
}

/** 버튼을 눌렀을 때: 있고, 안 썼고, 30분이 안 지났는가 */
function usable(c: Ctx, id: string, kind: DirectProposal['kind']): DirectProposal {
  const p = getProposal(c, id);
  if (!p || p.kind !== kind) throw new NotFoundError('이 제안');
  if (p.used) throw new OfficeError('already-decided', '이미 처리한 제안이에요');
  if (c.clock.now().getTime() - new Date(p.createdAt).getTime() > DIRECT_PROPOSAL_TTL_MS) {
    throw new OfficeError('stale', '30분이 지난 제안이에요. 직원을 다시 불러 주세요');
  }
  return p;
}

function markUsed(c: Ctx, p: DirectProposal): void {
  const all = getState<Proposals>(c, PROPOSALS, {});
  setState(c, PROPOSALS, { ...all, [p.id]: { ...p, used: true } });
}

/** 이 직원이 직접 지시를 맡을 수 없으면 그 이유. 맡을 수 있으면 null */
export function directRefusal(c: Ctx, employeeId: string, channelId: string): string | null {
  const type = DIRECT_TICKET_TYPE[employeeId];
  if (!type) {
    return employeeId === 'git-cat' ? 'Git 고양이는 커밋·푸시만 해요. 일은 다른 직원에게 맡겨 주세요' : '이 직원은 일을 직접 맡지 않아요. #비서실이나 /지시로 맡겨 주세요';
  }
  if (type === 'coding' && !projectByChannel(c, channelId)) return '코드 작업은 프로젝트 #작업 채널에서 맡겨 주세요(어느 저장소인지 정해져야 해요)';
  return null;
}

/** 지시 제안을 남긴다. 상태는 바꾸지 않는다. 맡을 수 없는 직원이면 OfficeError */
export function proposeOrder(c: Ctx, p: Origin & { employeeId: string; rawText: string; title: string; criteria: string[] }): DirectProposal {
  const refusal = directRefusal(c, p.employeeId, p.channelId);
  if (refusal) throw new OfficeError('direct-refused', refusal);
  const criteria = p.criteria.map((x) => x.trim()).filter(Boolean).slice(0, 4);
  if (!criteria.length) throw new OfficeError('direct-criteria', '완료 조건을 정하지 못했어요. 무엇이 되면 끝인지 같이 적어 주세요');
  return save(c, {
    id: newId(),
    kind: 'order',
    employeeId: p.employeeId,
    channelId: p.channelId,
    messageId: p.messageId,
    rawText: p.rawText.slice(0, 2000),
    title: p.title.trim().slice(0, 60) || p.rawText.slice(0, 40),
    type: DIRECT_TICKET_TYPE[p.employeeId]!,
    criteria,
    projectId: projectByChannel(c, p.channelId)?.id ?? null,
    createdAt: nowIso(c),
    used: false,
  });
}

/** 이 직원이 담당하는, 고칠 수 있는 가장 최근 티켓 */
export function revisableTicketOf(c: Ctx, employeeId: string) {
  return (
    c.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.assigneeId, employeeId), inArray(tickets.status, [...REVISABLE])))
      .orderBy(sql`rowid DESC`)
      .get() ?? null
  );
}

/** 진행 중 수정 제안을 남긴다. 상태는 바꾸지 않는다. 고칠 티켓이 없으면 OfficeError */
export function proposeRevision(c: Ctx, p: Origin & { employeeId: string; note: string }): DirectProposal {
  const t = revisableTicketOf(c, p.employeeId);
  if (!t) throw new OfficeError('direct-no-ticket', '지금 맡아서 진행 중인 일이 없어요');
  const note = p.note.trim().slice(0, 300);
  if (!note) throw new OfficeError('direct-note', '무엇을 고칠지 같이 적어 주세요');
  return save(c, { id: newId(), kind: 'revise', employeeId: p.employeeId, channelId: p.channelId, messageId: p.messageId, ticketId: t.id, note, createdAt: nowIso(c), used: false });
}

/**
 * [맡기고 시작]: 담당자를 고정한 계획서 한 장을 코드가 만들고 그 자리에서 CEO 승인한다.
 * 검토자는 담당자와 다른 모델로 코드가 고른다(fixReviewers). 관문 검사는 건너뛴다(주인이 직접 쓴 한 장짜리 일).
 */
export function startDirectOrder(c: Ctx, proposalId: string, discordUserId: string): { orderId: string; ticketId: string } {
  assertCeo(c.config, discordUserId);
  return inTx(c, (t) => {
    const p = usable(t, proposalId, 'order');
    if (p.kind !== 'order') throw new NotFoundError('이 제안');
    const assignee = t.db.select().from(employees).where(eq(employees.id, p.employeeId)).get();
    if (!assignee) throw new NotFoundError(`직원 ${p.employeeId}`);
    const { order, created } = registerOrder(t, { discordMessageId: p.messageId, rawText: p.rawText, ...(p.projectId ? { projectId: p.projectId } : {}) });
    if (!created) throw new OfficeError('already-decided', `이미 받은 지시예요 (${order.id})`);
    const out: PmPlanOutput = {
      goal: p.title,
      questions: [],
      tickets: [
        {
          title: p.title,
          type: p.type,
          assignee: p.employeeId,
          reviewer: REVIEWER_ORDER[p.type === 'coding' ? 'coding' : 'other'][0]!,
          acceptanceCriteria: p.criteria,
          needsCeoApproval: false,
          estimatedTokens: ESTIMATE[p.type],
        },
      ],
      tempStaff: [],
      estimate: { claudeDevPct: 0, claudeResearchPct: 0, gptPct: 0, hours: 1 },
      ...(p.projectId ? { projectId: p.projectId } : {}),
    };
    const plan = createPlanVersion(t, order.id, out, { afterGateRejection: false });
    t.db.update(plans).set({ status: 'awaiting-ceo' }).where(eq(plans.id, plan.id)).run();
    applyCeoPlanDecision(t, plan.id, 'approved', '직원 직접 지시', { kind: 'approval-bot', discordUserId });
    const ticket = t.db.select().from(tickets).where(eq(tickets.orderId, order.id)).get();
    if (!ticket) throw new OfficeError('direct-ticket', '티켓을 만들지 못했어요');
    setState(t, ORIGINS, { ...getState<Record<string, Origin>>(t, ORIGINS, {}), [order.id]: { channelId: p.channelId, messageId: p.messageId } });
    markUsed(t, p);
    return { orderId: order.id, ticketId: ticket.id };
  });
}

/**
 * [수정 반영]: 주인의 말을 완료 조건 한 줄("CEO 수정 요청: …")로 붙인다. 검토 중이면 재작업으로 돌린다.
 * 작업 중·재작업 중이면 상태는 그대로이고, 다음 제출부터 새 조건으로 검토한다.
 */
export function applyRevision(c: Ctx, proposalId: string, discordUserId: string): { ticketId: string; status: string } {
  assertCeo(c.config, discordUserId);
  return inTx(c, (t) => {
    const p = usable(t, proposalId, 'revise');
    if (p.kind !== 'revise') throw new NotFoundError('이 제안');
    const row = t.db.select().from(tickets).where(eq(tickets.id, p.ticketId)).get();
    if (!row) throw new NotFoundError(`티켓 ${p.ticketId}`);
    if (!(REVISABLE as readonly string[]).includes(row.status)) throw new OfficeError('ticket-state', `${row.id}는 지금 고칠 수 없는 상태예요(${row.status})`);
    t.db
      .update(tickets)
      .set({ acceptanceCriteria: [...row.acceptanceCriteria, `CEO 수정 요청: ${p.note}`], version: row.version + 1 })
      .where(eq(tickets.id, row.id))
      .run();
    t.db.insert(messages).values({ id: newId(), ticketId: row.id, orderId: row.orderId, fromId: 'ceo', toId: row.assigneeId, kind: 'system', content: `CEO 수정 요청: ${p.note}`, createdAt: nowIso(t) }).run();
    if (row.status === 'in_review') applyTicketEvent(t, row.id, { type: 'ceo.revise' }, { kind: 'approval-bot', discordUserId });
    markUsed(t, p);
    const status = t.db.select({ s: tickets.status }).from(tickets).where(eq(tickets.id, row.id)).get()!.s;
    return { ticketId: row.id, status };
  });
}

/** [그냥 대화]: 제안을 버린다 */
export function dismissProposal(c: Ctx, proposalId: string, discordUserId: string): void {
  assertCeo(c.config, discordUserId);
  const p = getProposal(c, proposalId);
  if (p && !p.used) markUsed(c, p);
}

/** 직접 지시로 시작한 지시의 출처 채널. 거울이 그 채널 바로 아래에 대화를 올린다 */
export function originOfOrder(c: Ctx, orderId: string): Origin | null {
  return getState<Record<string, Origin>>(c, ORIGINS, {})[orderId] ?? null;
}
