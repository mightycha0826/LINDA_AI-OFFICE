// 직원 봇 대화 (9장, 2026-10-20 CEO 결정). 주인이 직원 봇을 멘션하면 그 직원 이름으로 답한다.
// - 주인 계정이 보낸, 그 봇을 멘션한 글에만 답한다. 다른 사람·봇의 글은 무시한다(봇끼리 끝없이 주고받지 않게).
// - 두뇌는 누구든 로컬 Gemma. 대화와 상태 안내만 하고, 지시 등록·결재·푸시·상태 변경은 하지 않는다(코드에 그런 길이 없다).
// - 정지 중이면 AI를 부르지 않는다. 한 직원은 한 번에 한 질문만 답한다.
import { inArray } from 'drizzle-orm';
import { isStopped, type Ctx } from '../context.ts';
import { tickets } from '../db/schema.ts';
import { CHAT_PERSONAS } from '../staff/chat-personas.ts';
import { STAFF_BOT_IDS, staffStatus } from './staff-bots.ts';

/** 주인 메시지에서 AI에게 넘기는 최대 글자 수 */
export const CHAT_MAX_INPUT = 1000;
/** 대화에 넘기는 맡은 티켓 수 */
const CHAT_MAX_TICKETS = 10;
const OPEN_STATUSES = ['planned', 'in_progress', 'in_review', 'rework', 'meeting', 'blocked', 'awaiting_approval', 'paused'] as const;

export interface StaffMention {
  guildId: string | null;
  authorId: string;
  authorIsBot: boolean;
  /** 이 직원 봇을 멘션했는가 (역할·@everyone 멘션은 아님) */
  mentionsMe: boolean;
  content: string;
}

export function shouldAnswer(c: Ctx, employeeId: string, m: StaffMention): boolean {
  return (STAFF_BOT_IDS as readonly string[]).includes(employeeId) && m.guildId === c.config.discord.guildId && !m.authorIsBot && m.authorId === c.config.ceoDiscordId && m.mentionsMe;
}

/** 멘션 표시(<@id>, <@!id>, <@&id>)를 빼고 길이를 자른다 */
export function cleanMessage(content: string): string {
  return content.replace(/<@[!&]?\d+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_INPUT);
}

/** AI에게 넘기는 것: 대화 캐릭터, 회사 집계(지금 상태와 맡은 담당·검토 열린 티켓), 주인 말 */
export function chatInput(c: Ctx, employeeId: string, message: string) {
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
  return { persona, status: staffStatus(c, employeeId), tickets: mine, message };
}

export class StaffChat {
  private readonly c: Ctx;
  private readonly ask: (employeeId: string, input: ReturnType<typeof chatInput>) => Promise<string | null>;
  private readonly log: (s: string) => void;
  private readonly busy = new Set<string>();

  constructor(c: Ctx, ask: (employeeId: string, input: ReturnType<typeof chatInput>) => Promise<string | null>, log: (s: string) => void = () => {}) {
    this.c = c;
    this.ask = ask;
    this.log = log;
  }

  /** 답할 글. 답하지 않을 글이면 null */
  async answer(employeeId: string, m: StaffMention): Promise<string | null> {
    if (!shouldAnswer(this.c, employeeId, m)) return null;
    if (isStopped(this.c)) return '지금은 회사가 정지 중이라 대답하지 않아요. /재개 뒤에 다시 불러 주세요.';
    const message = cleanMessage(m.content);
    if (!message) return `부르셨어요? 궁금한 것을 같이 적어 주세요. 지금 상태: ${staffStatus(this.c, employeeId)}`;
    if (this.busy.has(employeeId)) return '앞 질문에 답하는 중이에요. 조금 뒤에 다시 물어봐 주세요.';
    this.busy.add(employeeId);
    try {
      const text = await this.ask(employeeId, chatInput(this.c, employeeId, message));
      if (text) return text;
    } catch (err) {
      this.log(`직원 봇 대화 실패(${employeeId}): ${(err as Error).message}`);
    } finally {
      this.busy.delete(employeeId);
    }
    return `지금은 답을 만들지 못했어요(로컬 두뇌 응답 없음). 지금 상태: ${staffStatus(this.c, employeeId)}`;
  }
}
