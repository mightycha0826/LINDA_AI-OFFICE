// 직원 봇 9개 (9장, 2026-10-20 CEO 결정).
// - 하는 일: ① #사무실-대화 스레드에 자기 거울 글 ② 멤버 목록 상태 글 ③ 주인이 멘션하면 대답(staff-chat.ts, 같은 날 추가).
// - 명령·버튼·DM 처리기는 달지 않는다. 대답으로는 상태를 바꾸지 않는다.
// - 직원 봇이 없거나 실패하면 그 글은 웹훅으로(이름을 붙여) 올린다.
import { inArray } from 'drizzle-orm';
import { deriveEmployeeStatus, type DerivedStatus, type ScreenTicket } from '@ai-office/shared';
import { isStopped, type Ctx } from '../context.ts';
import { tickets } from '../db/schema.ts';
import { toScreenTicket } from '../screen/snapshot.ts';
import type { DirectChannelRoute } from './mirror.ts';
import type { ChannelReplyPort, MirrorPort } from './types.ts';

/** 자기 봇을 갖는 정규 직원 (비서실장은 헤르메스 봇, 보조 직원은 웹훅 이름) */
export const STAFF_BOT_IDS = ['pm', 'developer', 'dev-a', 'dev-b', 'reviewer', 'marketing', 'strategy', 'qa-local', 'git-cat'] as const;

export interface StaffBotPort {
  /** 이 직원의 봇이 연결돼 있는가 */
  has(employeeId: string): boolean;
  /** 스레드나 채널에 올린다 (직접 지시는 주인이 말한 채널, 2026-10-21) */
  post(employeeId: string, channelOrThreadId: string, content: string): Promise<void>;
  /** 이 직원 봇의 Discord 사용자 ID (서로 태그할 때). 봇이 없으면 null */
  userIdOf(employeeId: string): string | null;
  setStatus(employeeId: string, text: string): Promise<void>;
  stop(): Promise<void>;
}

const STATUS_WORD: Record<Exclude<DerivedStatus, 'idle' | 'away'>, string> = { working: '작업 중', reviewing: '검토 중', meeting: '회의 중', blocked: '막힘', paused: '멈춤' };

/** 그 상태를 만든 티켓 (deriveEmployeeStatus와 같은 조건) */
const causes: Record<keyof typeof STATUS_WORD, (t: ScreenTicket, id: string) => boolean> = {
  blocked: (t, id) => t.status === 'blocked' && t.assigneeId === id,
  meeting: (t, id) => t.status === 'meeting' && (t.assigneeId === id || t.reviewerId === id),
  working: (t, id) => (t.status === 'in_progress' || t.status === 'rework') && t.assigneeId === id,
  reviewing: (t, id) => t.status === 'in_review' && t.reviewerId === id,
  paused: (t, id) => t.status === 'paused' && (t.assigneeId === id || t.reviewerId === id),
};

/** 멤버 목록에 보일 상태 글: `T-3 작업 중`처럼. 사무실 화면과 같은 규칙(deriveEmployeeStatus)으로 DB에서 계산한다 */
export function staffStatus(c: Ctx, employeeId: string): string {
  if (isStopped(c)) return '정지';
  const open = c.db
    .select()
    .from(tickets)
    .where(inArray(tickets.status, ['in_progress', 'rework', 'in_review', 'meeting', 'blocked', 'paused']))
    .all()
    .map(toScreenTicket)
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
  const status = deriveEmployeeStatus(employeeId, open);
  if (status === 'idle' || status === 'away') return '대기 중';
  const t = open.find((x) => causes[status](x, employeeId));
  return t ? `${t.id} ${STATUS_WORD[status]}` : STATUS_WORD[status];
}

/** 30초마다 부른다. 바뀐 상태만 보낸다(Discord 상태 변경 제한) */
export class StaffPresence {
  private readonly c: Ctx;
  private readonly bots: StaffBotPort;
  private readonly last = new Map<string, string>();

  constructor(c: Ctx, bots: StaffBotPort) {
    this.c = c;
    this.bots = bots;
  }

  async tick(): Promise<number> {
    let sent = 0;
    for (const id of STAFF_BOT_IDS) {
      if (!this.bots.has(id)) continue;
      const text = staffStatus(this.c, id);
      if (this.last.get(id) === text) continue;
      await this.bots.setStatus(id, text);
      this.last.set(id, text);
      sent++;
    }
    return sent;
  }
}

/** 거울 글을 직원 봇으로 보내고, 봇이 없거나 실패하면 웹훅(base)으로 */
export function routeMirror(base: MirrorPort, bots: StaffBotPort, log: (s: string) => void = () => {}): MirrorPort {
  return {
    ensureThread: (ticketId, title) => base.ensureThread(ticketId, title),
    async post(threadId, m) {
      if (m.employeeId && bots.has(m.employeeId)) {
        try {
          await bots.post(m.employeeId, threadId, m.content);
          return;
        } catch (err) {
          log(`직원 봇 글 실패(${m.employeeId}, 웹훅으로): ${(err as Error).message}`);
        }
      }
      await base.post(threadId, m);
    },
  };
}

/**
 * 직원 직접 지시 채널로 올리는 길 (2026-10-21): 직원 봇이 있으면 그 봇으로, 없거나 실패하면 LINDA가 이름을 붙여 올린다.
 * 태그는 직원 봇의 사용자 ID로 만든다(allowedMentions가 비어 있어 알림은 가지 않는다).
 */
export function directChannelRoute(bots: StaffBotPort | null, replies: ChannelReplyPort, log: (s: string) => void = () => {}): DirectChannelRoute {
  return {
    async post(channelId, m) {
      if (bots && m.employeeId && bots.has(m.employeeId)) {
        try {
          await bots.post(m.employeeId, channelId, m.content);
          return;
        } catch (err) {
          log(`직원 봇 글 실패(${m.employeeId}, LINDA로): ${(err as Error).message}`);
        }
      }
      await replies.post(channelId, `**${m.username}** ${m.content}`);
    },
    mentionOf(employeeId) {
      const id = bots?.userIdOf(employeeId);
      return id ? `<@${id}>` : null;
    },
  };
}
