// 직원 봇 대화 (9장, 2026-10-20 CEO 결정). 주인이 직원 봇을 멘션하면 그 직원 이름으로 답한다.
// - 주인의 멘션과 직원 답장에 대한 후속 답변만 처리한다. 다른 사람·봇의 글은 무시한다.
// - 두뇌는 누구든 로컬 Gemma. 대화·질문 → 합의한 내용 제안 → 다음 명확한 동의로 진행한다.
// - 제안과 선택 버튼은 해당 직원이 함께 보낸다. 결재함의 계획·푸시 결재는 버튼으로 처리한다.
// - 정지 중이면 AI를 부르지 않는다. 한 직원은 한 번에 한 질문만 답한다.
// - 대화는 직원·채널별로 최근 20회/6시간/16000자 안에서 DB에 보관하고 재시작 뒤에도 이어간다.
//   만료 기록은 주기적으로 정리하고 "대화 초기화"로 해당 직원·채널의 기억을 지운다.
import { inArray } from 'drizzle-orm';
import type { StaffChatOutput } from '@ai-office/shared';
import { getState, isStopped, type Ctx } from '../context.ts';
import { answerClarification } from '../core/clarifications.ts';
import { applyRevision, dismissProposal, pendingProposal, proposalIdForReply, proposeOrder, proposeRevision, shownProposalMessage, startDirectOrder, type DirectProposal } from '../core/direct.ts';
import { tickets } from '../db/schema.ts';
import { OfficeError } from '../errors.ts';
import { CHAT_PERSONAS, chatMood } from '../staff/chat-personas.ts';
import { staffProposalIntro } from '../staff/voice.ts';
import { STAFF_BOT_IDS, staffStatus } from './staff-bots.ts';
import { staffReplyText } from './format.ts';
import { forgetStaffConversation, readStaffConversation, rememberStaffConversation, type ChatTurn } from './chat-memory.ts';
import { proposalMessage } from './messages.ts';
export { CHAT_MEMORY_TURNS, CHAT_MEMORY_MS, type ChatTurn } from './chat-memory.ts';

/** 주인 메시지에서 AI에게 넘기는 최대 글자 수 */
export const CHAT_MAX_INPUT = 4000;
/** 대화에 넘기는 맡은 티켓 수 */
const CHAT_MAX_TICKETS = 10;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const OPEN_STATUSES = ['planned', 'in_progress', 'in_review', 'rework', 'meeting', 'blocked', 'awaiting_approval', 'paused'] as const;

export interface StaffMention {
  guildId: string | null;
  channelId: string;
  messageId: string;
  authorId: string;
  authorIsBot: boolean;
  /** 이 직원 봇을 멘션했는가 (역할·@everyone 멘션은 아님) */
  mentionsMe: boolean;
  /** 봇 답장에 이어서 답한 경우. Discord가 내용을 제공한 메시지만 처리한다. */
  repliesToMe?: boolean;
  replyToMessageId?: string;
  content: string;
}

/** 직원 봇이 올릴 답. 제안과 확인 질문·버튼도 그 직원의 답장에 함께 보낸다. */
export interface StaffReply {
  text: string;
  proposal: DirectProposal | null;
}

export function shouldAnswer(c: Ctx, employeeId: string, m: StaffMention): boolean {
  return (STAFF_BOT_IDS as readonly string[]).includes(employeeId) && m.guildId === c.config.discord.guildId && !m.authorIsBot && m.authorId === c.config.ceoDiscordId && (m.mentionsMe || !!m.repliesToMe) && !!m.content;
}

/** 확인 질문 직후의 독립적인 동의만 받는다. 조건·수정·인용·화제 전환이 섞이면 다시 대화한다. */
export function isWorkConsent(message: string): boolean {
  const normalized = message.trim().replace(/[.!。！]+$/u, '').replace(/\s+/g, ' ');
  return /^(?:(?:응|네|넵|예|좋아|좋아요|그래|알겠어|알겠어요)(?:[,，] ?| )?)?(?:(?:(?:그|이) (?:내용|범위|조건|계획)(?:으로|대로)|그대로|그렇게) ?)?(?:(?:진행|시작|등록|반영)(?:해|해줘|해 줘|해요|해줘요|해 줘요|해 주세요|해주세요|하자|해도 돼|해도 돼요)|맡길게|맡길게요)$/.test(normalized)
    || /^(?:(?:응|네|넵|예|좋아|좋아요|그래)(?:[,，] ?| )?)(?:그렇게|그대로) ?(?:해|해줘|해 줘|해주세요|해 주세요)$/.test(normalized)
    || /^(?:그렇게|그대로) ?(?:해|해줘|해 줘|해주세요|해 주세요)$/.test(normalized)
    || /^(응|네|넵|예|좋아|좋아요|그래)$/.test(normalized);
}

/** 멘션 표시(<@id>, <@!id>, <@&id>)를 빼고 길이를 자른다 */
export function cleanMessage(content: string): string {
  return content.replace(/<@[!&]?\d+>/g, ' ').replace(/[\t ]+/g, ' ').replace(/ *\r?\n */g, '\n').trim().slice(0, CHAT_MAX_INPUT);
}

/** 주인 시간대의 요일·시각 */
function localClock(now: Date, timeZone: string): { text: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const hour = Number(get('hour'));
  return { text: `${WEEKDAYS[day] ?? ''}요일 ${get('hour')}:${get('minute')}`, hour };
}

/** AI에게 넘기는 것: 대화 캐릭터, 지금 시각·기분, 회사 집계(지금 상태와 맡은 담당·검토 열린 티켓), 방금 나눈 대화, 주인 말 */
export function chatInput(c: Ctx, employeeId: string, message: string, recent: readonly ChatTurn[] = [], previousProposal: DirectProposal | null = null) {
  const mine = c.db
    .select()
    .from(tickets)
    .where(inArray(tickets.status, [...OPEN_STATUSES]))
    .all()
    .filter((t) => t.assigneeId === employeeId || t.reviewerId === employeeId)
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
    .slice(0, CHAT_MAX_TICKETS)
    .map((t) => ({ id: t.id, title: t.title, status: t.status, role: t.assigneeId === employeeId ? '담당' : '검토' }));
  const persona = CHAT_PERSONAS[employeeId as keyof typeof CHAT_PERSONAS] ?? null;
  const status = staffStatus(c, employeeId);
  const clock = localClock(c.clock.now(), c.config.schedule.timezone);
  const mood = persona ? persona.moods[chatMood(status, clock.hour)] : null;
  return { persona, now: clock.text, mood, status, tickets: mine, recent: recent.map((t) => ({ 주인: t.owner, 나: t.me })), message, previousProposal };
}

export class StaffChat {
  private readonly c: Ctx;
  private readonly ask: (employeeId: string, input: ReturnType<typeof chatInput>) => Promise<StaffChatOutput | null>;
  private readonly log: (s: string) => void;
  private readonly queue = new Map<string, Promise<void>>();
  private readonly queued = new Map<string, number>();

  constructor(c: Ctx, ask: (employeeId: string, input: ReturnType<typeof chatInput>) => Promise<StaffChatOutput | null>, log: (s: string) => void = () => {}) {
    this.c = c;
    this.ask = ask;
    this.log = log;
  }

  /** 답할 글. 답하지 않을 글이면 null */
  async answer(employeeId: string, m: StaffMention): Promise<StaffReply | null> {
    if (!shouldAnswer(this.c, employeeId, m)) return null;
    if ((this.queued.get(employeeId) ?? 0) >= 4) return { text: '메시지가 잠시 쌓였어요. 앞선 이야기부터 차례로 답하고 있으니 조금만 기다려 주세요.', proposal: null };
    const previous = this.queue.get(employeeId) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    this.queue.set(employeeId, done);
    this.queued.set(employeeId, (this.queued.get(employeeId) ?? 0) + 1);
    try {
      await previous;
      return await this.respond(employeeId, m);
    } finally {
      release();
      this.queued.set(employeeId, (this.queued.get(employeeId) ?? 1) - 1);
      if (this.queue.get(employeeId) === done) { this.queue.delete(employeeId); this.queued.delete(employeeId); }
    }
  }

  private async respond(employeeId: string, m: StaffMention): Promise<StaffReply | null> {
    const plain = (text: string): StaffReply => ({ text, proposal: null });
    if (isStopped(this.c)) return plain('지금은 회사가 정지 중이라 대답하지 않아요. /재개 뒤에 다시 불러 주세요.');
    const message = cleanMessage(m.content);
    if (!message) return plain(`부르셨어요? 궁금한 것을 같이 적어 주세요. 지금 상태: ${staffStatus(this.c, employeeId)}`);
    try {
      if (/^(?:대화 초기화|최근 대화 잊어줘|최근 대화를 잊어줘|대화 기억 지워줘)[.!]?$/u.test(message)) {
        forgetStaffConversation(this.c, employeeId, m.channelId);
        const pending = pendingProposal(this.c, employeeId, m.channelId);
        if (pending) dismissProposal(this.c, pending.id, m.authorId);
        return plain('이 채널에서 저와 나눈 최근 대화 기억을 지웠어요. 여기서 새로 이야기하면 돼요.');
      }
      const question = employeeId === 'pm' && m.replyToMessageId
        ? getState<{ orderId: string; round: number } | null>(this.c, `discord.pmQuestion:${m.replyToMessageId}`, null) : null;
      if (question) {
        answerClarification(this.c, question.orderId, question.round, message, m.authorId);
        return plain('답변해 주신 내용을 확인했어요. 더 필요한 것이 있으면 이어서 여쭙고, 충분히 이해되면 계획서로 정리할게요.');
      }
      const now = this.c.clock.now().getTime();
      const recent = readStaffConversation(this.c, employeeId, m.channelId);
      if (recent.some((turn) => turn.messageId === m.messageId)) return null;
      const pending = pendingProposal(this.c, employeeId, m.channelId);
      // 같은 메시지 재전송이나 예전 답변은 확인으로 쓸 수 없다.
      if (pending && BigInt(m.messageId) <= BigInt(pending.messageId)) return null;
      if (pending && isWorkConsent(message)) {
        const shown = shownProposalMessage(this.c, pending.id);
        if (!shown || BigInt(m.messageId) <= BigInt(shown)) return plain('확인 질문이 도착하기 전에 보내신 말씀이라 동의로 처리하지 않았어요. 정리한 내용을 보신 뒤 다시 답해 주세요.');
        if (m.replyToMessageId && proposalIdForReply(this.c, m.replyToMessageId) !== pending.id) {
          return plain('이전 답장에 대한 말씀이라 지금 제안의 동의로 처리하지 않았어요. 최신 확인 질문에 답해 주시겠어요?');
        }
        const result = pending.kind === 'order'
          ? startDirectOrder(this.c, pending.id, m.authorId)
          : applyRevision(this.c, pending.id, m.authorId);
        const text = pending.kind === 'order'
          ? `네, 말씀 나눈 내용으로 맡아서 진행할게요. 진행 상황과 결과도 알려드릴게요. (${result.ticketId})`
          : `네, 말씀하신 수정 내용을 반영했어요. 바뀐 내용으로 작업하고 확인할게요. (${result.ticketId})`;
        rememberStaffConversation(this.c, employeeId, m.channelId, [...recent, { at: now, owner: message, me: text, messageId: m.messageId }]);
        return plain(text);
      }
      // 추가 질문·수정·거절 뒤에 예전 제안으로 시작하지 않는다. 필요하면 대화 후 새로 확인한다.
      if (pending) dismissProposal(this.c, pending.id, m.authorId);
      const out = await this.ask(employeeId, chatInput(this.c, employeeId, message, recent, pending));
      if (out) {
        const reply = this.withProposal(employeeId, m, message, { ...out, text: staffReplyText(out.text) });
        const spoken = [reply.text, reply.proposal ? proposalMessage(reply.proposal, employeeId).content : ''].filter(Boolean).join('\n\n');
        rememberStaffConversation(this.c, employeeId, m.channelId, [...recent, { at: now, owner: message, me: spoken, messageId: m.messageId }]);
        return reply;
      }
    } catch (err) {
      if (err instanceof OfficeError) return plain(err.message);
      this.log(`직원 봇 대화 실패(${employeeId}): ${(err as Error).message}`);
    }
    return plain(`잠시 답변이 지연되고 있어요. 조금 뒤에 다시 말씀해 주세요. 지금 상태: ${staffStatus(this.c, employeeId)}`);
  }

  /** 지시·수정으로 읽혔으면 제안을 남긴다. 맡을 수 없으면 이유를 답에 붙이고 제안은 없다 */
  private withProposal(employeeId: string, m: StaffMention, message: string, out: StaffChatOutput): StaffReply {
    const origin = { channelId: m.channelId, messageId: m.messageId, employeeId };
    try {
      if (out.intent === 'order') {
        const rawText = out.request?.trim() || [out.title, ...(out.criteria ?? [])].filter(Boolean).join('\n') || message;
        return { text: staffProposalIntro(employeeId), proposal: proposeOrder(this.c, { ...origin, rawText, title: out.title ?? '', criteria: out.criteria ?? [] }) };
      }
      if (out.intent === 'revise') {
        return { text: staffProposalIntro(employeeId), proposal: proposeRevision(this.c, { ...origin, note: out.note ?? message }) };
      }
    } catch (err) {
      if (err instanceof OfficeError) return { text: err.message, proposal: null };
      throw err;
    }
    return { text: out.text, proposal: null };
  }
}
