// 백서진의 대화 → 등록 제안 → 다음 CEO 답변 → 등록. 제안만으로는 주문·계획·티켓을 만들지 않는다.
import { eq } from 'drizzle-orm';
import { getState, inTx, newId, nowIso, setState, type Ctx } from '../context.ts';
import { registerOrder } from '../core/orders.ts';
import { orders } from '../db/schema.ts';
import { OfficeError } from '../errors.ts';
import { findProject } from '../workspace/projects.ts';
import { lastCeoMessage, resolveOrderMessageId } from './order-message.ts';

const KEY = 'chief.orderProposals';
export const CHIEF_PROPOSAL_TTL_MS = 30 * 60_000;
export interface ChiefOrderProposal {
  id: string;
  rawText: string;
  projectId: string | null;
  sourceMessageId: string;
  observedMessageId: string | null;
  messageIdSource: 'provided' | 'last-ceo-message';
  createdAt: string;
  status: 'pending' | 'registered' | 'chat' | 'superseded';
  orderId: string | null;
  decisionMessageId?: string;
}
interface Proposals { activeId: string | null; items: ChiefOrderProposal[] }
const proposals = (c: Ctx): Proposals => getState(c, KEY, { activeId: null, items: [] });
export const pendingChiefProposal = (c: Ctx): ChiefOrderProposal | null => {
  const state = proposals(c);
  const item = state.items.find((p) => p.id === state.activeId && p.status === 'pending');
  return item && c.clock.now().getTime() - new Date(item.createdAt).getTime() < CHIEF_PROPOSAL_TTL_MS ? item : null;
};

export function proposeChiefOrder(c: Ctx, input: { rawText: string; discordMessageId?: string; projectId?: string }) {
  return inTx(c, (t) => {
    const source = resolveOrderMessageId(t, input.discordMessageId);
    if (input.projectId && !findProject(t, input.projectId)) throw new OfficeError('project', '등록된 프로젝트를 찾지 못했어요. 프로젝트를 확인해 주세요');
    const rawText = input.rawText.trim();
    if (!rawText) throw new OfficeError('order-text', '함께 정리한 업무 내용을 적어 주세요');
    const state = proposals(t);
    const existing = state.items.find((p) => p.sourceMessageId === source.id && p.rawText === rawText && p.projectId === (input.projectId ?? null) && ['pending', 'registered'].includes(p.status));
    if (existing && (existing.status === 'registered' || t.clock.now().getTime() - new Date(existing.createdAt).getTime() < CHIEF_PROPOSAL_TTL_MS)) return proposalResult(existing);
    const already = t.db.select().from(orders).where(eq(orders.discordMessageId, source.id)).get();
    if (already) return { created: false, status: 'registered', orderId: already.id, discordMessageId: source.id, messageIdSource: source.source, note: '이미 등록된 지시예요' };
    for (const item of state.items) if (item.status === 'pending') item.status = 'superseded';
    const item: ChiefOrderProposal = {
      id: newId(), rawText, projectId: input.projectId ?? null, sourceMessageId: source.id,
      observedMessageId: lastCeoMessage(t)?.id ?? null, messageIdSource: source.source,
      createdAt: nowIso(t), status: 'pending', orderId: null,
    };
    setState(t, KEY, { activeId: item.id, items: [...state.items, item].slice(-50) } satisfies Proposals);
    return proposalResult(item);
  });
}

function proposalResult(item: ChiefOrderProposal) {
  if (item.status === 'registered') return { created: false, status: 'registered', proposalId: item.id, orderId: item.orderId, discordMessageId: item.sourceMessageId, messageIdSource: item.messageIdSource, note: '이미 등록된 지시예요' };
  return {
    created: false, status: item.status === 'pending' ? 'awaiting-user-confirmation' : item.status,
    proposalId: item.id, orderId: item.orderId, rawText: item.rawText,
    discordMessageId: item.sourceMessageId, messageIdSource: item.messageIdSource,
    question: `사장님, 이렇게 이해했어요.\n\n${item.rawText}\n\n이 내용으로 지시를 추가할까요? 더 이야기하거나 내용을 고쳐도 괜찮아요.`,
    note: '아직 지시는 등록하지 않았어요. 이 내용을 사용자에게 보여 주고 답을 기다리세요. 같은 차례에 respond_order_proposal을 호출하지 마세요.',
  };
}

export function respondChiefOrder(c: Ctx, proposalId: string, decision: 'register' | 'chat') {
  return inTx(c, (t) => {
    const state = proposals(t);
    const item = state.items.find((p) => p.id === proposalId);
    if (!item) throw new OfficeError('proposal', '등록 제안을 찾지 못했어요. 대화 내용을 다시 정리해 주세요');
    if (item.status === 'registered') return { created: false, status: 'registered', orderId: item.orderId, note: '이미 등록된 지시예요' };
    if (state.activeId !== item.id || item.status !== 'pending') throw new OfficeError('stale-proposal', '이미 닫혔거나 내용이 바뀐 제안이에요. 최신 대화 내용을 확인해 주세요');
    if (t.clock.now().getTime() - new Date(item.createdAt).getTime() >= CHIEF_PROPOSAL_TTL_MS) throw new OfficeError('expired-proposal', '30분이 지나 등록 제안이 만료됐어요. 내용을 다시 확인하고 물어봐 주세요');
    // 모델이 지어낸 확인 ID를 받지 않고, 실제 #비서실 CEO의 후속 메시지가 도착했는지 확인한다.
    const reply = resolveOrderMessageId(t, undefined);
    if (reply.id === item.observedMessageId || BigInt(reply.id) <= BigInt(item.sourceMessageId)) {
      throw new OfficeError('awaiting-reply', '아직 사장님의 후속 답변이 없어요. 지시로 추가할지 질문하고 답변을 기다려 주세요');
    }
    if (decision === 'chat') {
      item.status = 'chat';
      item.decisionMessageId = reply.id;
      state.activeId = null;
      setState(t, KEY, state);
      return { created: false, status: 'chat', note: '지시로 등록하지 않고 대화를 이어가요' };
    }
    const { order, created } = registerOrder(t, { discordMessageId: item.sourceMessageId, rawText: item.rawText, channelId: t.config.discord.channels.secretary, ...(item.projectId ? { projectId: item.projectId } : {}) });
    item.status = 'registered';
    item.orderId = order.id;
    item.decisionMessageId = reply.id;
    state.activeId = null;
    setState(t, KEY, state);
    return { created, status: 'registered', orderId: order.id, note: '지시를 등록했어요. PM이 요구사항 확인부터 진행해요. 계획 승인이나 작업 시작을 뜻하지는 않아요' };
  });
}
