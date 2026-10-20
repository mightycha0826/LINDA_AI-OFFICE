// 직원 봇 9개 (9장, 2026-10-20 CEO 결정: 보여 주기 전용).
// - 하는 일: ① #사무실-대화 스레드에 자기 거울 글 ② 멤버 목록 상태 글.
// - 아무것도 받지 않는다: 게이트웨이 권한은 Guilds만, 메시지·명령·버튼·DM 처리기를 달지 않는다.
// - 직원 봇이 없거나 실패하면 그 글은 웹훅으로(이름을 붙여) 올린다.
import { and, eq, inArray, or } from 'drizzle-orm';
import { getState, type Ctx } from '../context.ts';
import { tickets } from '../db/schema.ts';
import type { MirrorPort } from './types.ts';

/** 자기 봇을 갖는 정규 직원 (비서실장은 헤르메스 봇, 보조 직원은 웹훅 이름) */
export const STAFF_BOT_IDS = ['pm', 'developer', 'dev-a', 'dev-b', 'reviewer', 'marketing', 'strategy', 'qa-local', 'git-cat'] as const;

export interface StaffBotPort {
  /** 이 직원의 봇이 연결돼 있는가 */
  has(employeeId: string): boolean;
  post(employeeId: string, threadId: string, content: string): Promise<void>;
  setStatus(employeeId: string, text: string): Promise<void>;
  stop(): Promise<void>;
}

/** 멤버 목록에 보일 상태 글. DB에서만 계산한다 */
export function staffStatus(c: Ctx, employeeId: string): string {
  if (getState<boolean>(c, 'stopped', false)) return '정지';
  const mine = c.db
    .select()
    .from(tickets)
    .where(
      or(
        and(eq(tickets.assigneeId, employeeId), inArray(tickets.status, ['in_progress', 'rework', 'meeting'])),
        and(eq(tickets.reviewerId, employeeId), inArray(tickets.status, ['in_review', 'meeting'])),
      ),
    )
    .all()
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
  const t = mine[0];
  if (!t) return '대기 중';
  if (t.status === 'meeting') return `${t.id} 회의 중`;
  if (t.status === 'in_review') return `${t.id} 검토 중`;
  return `${t.id} 작업 중`;
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
