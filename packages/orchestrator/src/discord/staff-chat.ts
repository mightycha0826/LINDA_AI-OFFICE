// 직원 봇 대화 (9장, 2026-10-20 CEO 결정). 주인이 직원 봇을 멘션하면 그 직원 이름으로 답한다.
// - 주인 계정이 보낸, 그 봇을 멘션한 글에만 답한다. 다른 사람·봇의 글은 무시한다(봇끼리 끝없이 주고받지 않게).
// - 두뇌는 누구든 로컬 Gemma. 대답 자체로는 상태를 바꾸지 않는다.
// - 2026-10-21: 지시·수정으로 읽히면 제안(core/direct.ts)만 남기고, LINDA가 [맡기고 시작]·[수정 반영] 버튼을 띄운다.
//   일이 생기는 것은 주인이 그 버튼을 눌렀을 때뿐이다.
// - 정지 중이면 AI를 부르지 않는다. 한 직원은 한 번에 한 질문만 답한다.
// - 2026-10-21 "살아 있는 것처럼": 지금 시각·기분과 같은 채널에서 방금(30분 안) 나눈 대화 4번까지 같이 넘긴다.
//   대화 기억은 메모리에만 두고(DB·로그에 남기지 않음), 다시 켜면 사라진다.
import { inArray } from 'drizzle-orm';
import type { StaffChatOutput } from '@ai-office/shared';
import { isStopped, type Ctx } from '../context.ts';
import { proposeOrder, proposeRevision, type DirectProposal } from '../core/direct.ts';
import { tickets } from '../db/schema.ts';
import { OfficeError } from '../errors.ts';
import { CHAT_PERSONAS, chatMood } from '../staff/chat-personas.ts';
import { STAFF_BOT_IDS, staffStatus } from './staff-bots.ts';

/** 주인 메시지에서 AI에게 넘기는 최대 글자 수 */
export const CHAT_MAX_INPUT = 1000;
/** 대화에 넘기는 맡은 티켓 수 */
const CHAT_MAX_TICKETS = 10;
/** 기억하는 대화: 직원·채널마다 최근 몇 번, 몇 분 안 */
export const CHAT_MEMORY_TURNS = 4;
export const CHAT_MEMORY_MS = 30 * 60_000;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export interface ChatTurn {
  at: number;
  owner: string;
  me: string;
}
const OPEN_STATUSES = ['planned', 'in_progress', 'in_review', 'rework', 'meeting', 'blocked', 'awaiting_approval', 'paused'] as const;

export interface StaffMention {
  guildId: string | null;
  channelId: string;
  messageId: string;
  authorId: string;
  authorIsBot: boolean;
  /** 이 직원 봇을 멘션했는가 (역할·@everyone 멘션은 아님) */
  mentionsMe: boolean;
  content: string;
}

/** 직원 봇이 올릴 답. proposal이 있으면 LINDA가 그 아래에 확인 버튼을 띄운다 */
export interface StaffReply {
  text: string;
  proposal: DirectProposal | null;
}

export function shouldAnswer(c: Ctx, employeeId: string, m: StaffMention): boolean {
  return (STAFF_BOT_IDS as readonly string[]).includes(employeeId) && m.guildId === c.config.discord.guildId && !m.authorIsBot && m.authorId === c.config.ceoDiscordId && m.mentionsMe;
}

/** 멘션 표시(<@id>, <@!id>, <@&id>)를 빼고 길이를 자른다 */
export function cleanMessage(content: string): string {
  return content.replace(/<@[!&]?\d+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_INPUT);
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
export function chatInput(c: Ctx, employeeId: string, message: string, recent: readonly ChatTurn[] = []) {
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
  return { persona, now: clock.text, mood, status, tickets: mine, recent: recent.map((t) => ({ 주인: t.owner, 나: t.me })), message };
}

export class StaffChat {
  private readonly c: Ctx;
  private readonly ask: (employeeId: string, input: ReturnType<typeof chatInput>) => Promise<StaffChatOutput | null>;
  private readonly log: (s: string) => void;
  private readonly busy = new Set<string>();
  /** 직원·채널마다 방금 나눈 대화 (메모리에만) */
  private readonly memory = new Map<string, ChatTurn[]>();

  constructor(c: Ctx, ask: (employeeId: string, input: ReturnType<typeof chatInput>) => Promise<StaffChatOutput | null>, log: (s: string) => void = () => {}) {
    this.c = c;
    this.ask = ask;
    this.log = log;
  }

  /** 답할 글. 답하지 않을 글이면 null */
  async answer(employeeId: string, m: StaffMention): Promise<StaffReply | null> {
    if (!shouldAnswer(this.c, employeeId, m)) return null;
    const plain = (text: string): StaffReply => ({ text, proposal: null });
    if (isStopped(this.c)) return plain('지금은 회사가 정지 중이라 대답하지 않아요. /재개 뒤에 다시 불러 주세요.');
    const message = cleanMessage(m.content);
    if (!message) return plain(`부르셨어요? 궁금한 것을 같이 적어 주세요. 지금 상태: ${staffStatus(this.c, employeeId)}`);
    if (this.busy.has(employeeId)) return plain('앞 질문에 답하는 중이에요. 조금 뒤에 다시 물어봐 주세요.');
    this.busy.add(employeeId);
    try {
      const key = `${employeeId}:${m.channelId}`;
      const now = this.c.clock.now().getTime();
      const recent = (this.memory.get(key) ?? []).filter((t) => now - t.at < CHAT_MEMORY_MS);
      const out = await this.ask(employeeId, chatInput(this.c, employeeId, message, recent));
      if (out) {
        this.memory.set(key, [...recent, { at: now, owner: message, me: out.text }].slice(-CHAT_MEMORY_TURNS));
        return this.withProposal(employeeId, m, message, out);
      }
    } catch (err) {
      this.log(`직원 봇 대화 실패(${employeeId}): ${(err as Error).message}`);
    } finally {
      this.busy.delete(employeeId);
    }
    return plain(`지금은 답을 만들지 못했어요(로컬 두뇌 응답 없음). 지금 상태: ${staffStatus(this.c, employeeId)}`);
  }

  /** 지시·수정으로 읽혔으면 제안을 남긴다. 맡을 수 없으면 이유를 답에 붙이고 제안은 없다 */
  private withProposal(employeeId: string, m: StaffMention, message: string, out: StaffChatOutput): StaffReply {
    const origin = { channelId: m.channelId, messageId: m.messageId, employeeId };
    try {
      if (out.intent === 'order') {
        return { text: out.text, proposal: proposeOrder(this.c, { ...origin, rawText: message, title: out.title ?? '', criteria: out.criteria ?? [] }) };
      }
      if (out.intent === 'revise') {
        return { text: out.text, proposal: proposeRevision(this.c, { ...origin, note: out.note ?? message }) };
      }
    } catch (err) {
      if (err instanceof OfficeError) return { text: `${out.text}\n(${err.message})`, proposal: null };
      throw err;
    }
    return { text: out.text, proposal: null };
  }
}
