// 질문은 결재가 아니다. 답변 대기와 대화 이력은 재시작 뒤에도 DB에 남긴다.
import { eq } from 'drizzle-orm';
import { emit, getState, inTx, nowIso, setState, type Ctx } from '../context.ts';
import { orders, plans } from '../db/schema.ts';
import { assertCeo, OfficeError } from '../errors.ts';
import { expirePendingApprovals } from './approvals.ts';
import { answerNote, COMPANY_SCOPE, remember } from './memory.ts';
import { getOrder } from './orders.ts';

export interface Clarification {
  ready: boolean;
  /** from이 없으면 사장님께 드린 질문, 'developer'면 PM이 개발팀장에게 먼저 물은 것 (답은 AI 출력) */
  rounds: { questions: string[]; answer: string | null; at: string; from?: 'developer' }[];
}
/** 한 지시에서 PM이 개발팀장에게 물을 수 있는 횟수. 넘으면 사장님께 여쭌다 */
export const MAX_CONSULT_ROUNDS = 2;
export const clarificationKey = (orderId: string) => `clarification:${orderId}`;
export const orderChannelKey = (orderId: string) => `orderChannel:${orderId}`;
export const clarificationOf = (c: Ctx, orderId: string): Clarification => getState(c, clarificationKey(orderId), { ready: false, rounds: [] });

export function askClarification(c: Ctx, orderId: string, questions: string[]): void {
  if (!questions.length) throw new OfficeError('questions', '확인할 질문이 필요해요');
  inTx(c, (t) => {
    const order = getOrder(t, orderId);
    if (!['planning', 'awaiting-plan-approval'].includes(order.status)) throw new OfficeError('order-closed', '이미 계획 단계가 끝난 지시예요');
    const state = clarificationOf(t, orderId);
    if (state.rounds.at(-1)?.answer === null) return;
    // 이전 방식으로 올라온 질문 포함 계획서도 결재를 회수하고 대화부터 진행한다.
    for (const plan of t.db.select().from(plans).where(eq(plans.orderId, orderId)).all()) {
      if (!['draft', 'gate-review', 'awaiting-ceo', 'revision-requested'].includes(plan.status)) continue;
      t.db.update(plans).set({ status: 'superseded' }).where(eq(plans.id, plan.id)).run();
      expirePendingApprovals(t, 'plan', plan.id);
    }
    t.db.update(orders).set({ status: 'planning' }).where(eq(orders.id, orderId)).run();
    const rounds = [...state.rounds, { questions, answer: null, at: nowIso(t) }];
    setState(t, clarificationKey(orderId), { ready: false, rounds } satisfies Clarification);
    emit(t, 'plan.status', { orderId, status: 'awaiting-answers', round: rounds.length });
  });
}

export function answerClarification(c: Ctx, orderId: string, round: number, answer: string, userId: string): void {
  assertCeo(c.config, userId);
  inTx(c, (t) => {
    const state = clarificationOf(t, orderId);
    if (getOrder(t, orderId).status !== 'planning' || round !== state.rounds.length || state.rounds.at(-1)?.answer !== null) {
      throw new OfficeError('stale-question', '이미 답했거나 이전 질문이에요. 최신 질문에 답해 주세요');
    }
    if (!answer.trim()) throw new OfficeError('empty-answer', '답변을 입력해 주세요');
    const asked = state.rounds[round - 1]!;
    asked.answer = answer.trim();
    setState(t, clarificationKey(orderId), state);
    // 회사 기억: 같은 것을 다시 묻지 않게 질문과 답을 원문 그대로 남긴다 (프로젝트가 아직 없으면 회사 전체)
    remember(t, getOrder(t, orderId).projectId ?? COMPANY_SCOPE, { text: answerNote(asked.questions, asked.answer), source: 'answer', orderId });
    emit(t, 'plan.status', { orderId, status: 'answers-received', round });
  });
}

/** PM이 개발팀장에게 먼저 물은 질문과 답. 사장님 답변 대기를 만들지 않는다 */
export function recordConsultation(c: Ctx, orderId: string, questions: string[], answer: string): void {
  inTx(c, (t) => {
    const state = clarificationOf(t, orderId);
    setState(t, clarificationKey(orderId), { ready: false, rounds: [...state.rounds, { questions, answer, at: nowIso(t), from: 'developer' }] } satisfies Clarification);
    emit(t, 'plan.status', { orderId, status: 'consulted', round: state.rounds.length + 1 });
  });
}

export const consultRounds = (state: Clarification) => state.rounds.filter((r) => r.from === 'developer').length;
