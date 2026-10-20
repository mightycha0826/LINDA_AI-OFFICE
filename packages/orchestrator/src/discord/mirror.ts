// #사무실-대화 거울 (9장 ⑦). AI끼리 대화는 오케스트레이터 안에서 하고, Discord에는 복사해서 보여주기만 한다.
// - 티켓마다 스레드 하나. 정규 직원 9명은 자기 직원 봇으로, 나머지는 웹훅에 직원 이름을 붙여 올린다(staff-bots.ts).
// - 긴 내용은 앞부분과 사무실 화면 링크만. 회의록은 스레드 끝에 올린다.
// - 묶어서 보낸다: 한 번에 최대 maxPerFlush개 (Discord 전송 제한).
// - 이 채널에 사람이 답해도 지시로 처리하지 않는다 (봇이 이 채널의 메시지를 읽지 않는다).
import { eq, gt } from 'drizzle-orm';
import { getState, setState, type Ctx } from '../context.ts';
import { employees, events, meetingMinutes, messages, tickets } from '../db/schema.ts';
import { clip, minutesText } from './messages.ts';
import type { MirrorPort } from './types.ts';

const CURSOR = 'mirror.cursor';
const THREADS = 'mirror.threads';

export class Mirror {
  private readonly c: Ctx;
  private readonly port: MirrorPort;
  private readonly maxPerFlush: number;
  private readonly log: (s: string) => void;
  private readonly interpret: ((from: string, content: string) => Promise<string | null>) | undefined;

  /** interpret: 거울 통역사 (16장 7-5). JSON 메시지를 문장으로. 없거나 실패하면 원문(앞부분)을 그대로 */
  constructor(c: Ctx, port: MirrorPort, opts: { maxPerFlush?: number; log?: (s: string) => void; interpret?: (from: string, content: string) => Promise<string | null> } = {}) {
    this.c = c;
    this.port = port;
    this.maxPerFlush = opts.maxPerFlush ?? 8;
    this.log = opts.log ?? (() => {});
    this.interpret = opts.interpret;
  }

  private async thread(ticketId: string): Promise<string | null> {
    const map = getState<Record<string, string>>(this.c, THREADS, {});
    if (map[ticketId]) return map[ticketId];
    const t = this.c.db.select().from(tickets).where(eq(tickets.id, ticketId)).get();
    if (!t) return null;
    const id = await this.port.ensureThread(ticketId, `${t.id} ${t.title}`.slice(0, 90));
    setState(this.c, THREADS, { ...map, [ticketId]: id });
    return id;
  }

  private name(id: string): string {
    if (id === 'orchestrator') return '회사 시스템';
    const e = this.c.db.select().from(employees).where(eq(employees.id, id)).get();
    return e ? `${e.displayName}${e.isTemporary ? ' (방문)' : ''}` : id;
  }

  /** JSON(앞에 한 줄 표시가 붙은 것 포함)이면 거울 통역사가 문장으로 바꾼다. 아니면 null(원문 그대로) */
  private async readable(fromId: string, content: string): Promise<string | null> {
    if (!this.interpret || !/(^|\n)\s*[{[]/.test(content)) return null;
    try {
      const text = await this.interpret(this.name(fromId), content.slice(0, 6000));
      return text?.trim() ? text.trim() : null;
    } catch (err) {
      this.log(`거울 통역 실패(원문으로): ${(err as Error).message}`);
      return null;
    }
  }

  /** 한 번 묶어 보낸다. 보낸 수를 돌려준다. */
  async flush(): Promise<number> {
    const c = this.c;
    const cursor = getState<number>(c, CURSOR, 0);
    const batch = c.db.select().from(events).where(gt(events.seq, cursor)).orderBy(events.seq).limit(500).all();
    let sent = 0;
    for (const ev of batch) {
      if (sent >= this.maxPerFlush) break;
      const p = ev.payload as Record<string, unknown>;
      try {
        if (ev.type === 'message.sent' && typeof p.ticketId === 'string') {
          const m = c.db.select().from(messages).where(eq(messages.id, String(p.messageId))).get();
          const threadId = m && (await this.thread(p.ticketId));
          if (m && threadId) {
            const content = (await this.readable(m.fromId, m.content)) ?? m.content;
            await this.port.post(threadId, { username: this.name(m.fromId), employeeId: m.fromId, content: clip(content, c.config.mirror.maxChars, c.config.screenUrl, p.ticketId) });
            sent++;
          }
        } else if (ev.type === 'meeting.minutes' && typeof p.ticketId === 'string') {
          const m = c.db.select().from(meetingMinutes).where(eq(meetingMinutes.id, String(p.minutesId))).get();
          const threadId = m && (await this.thread(p.ticketId));
          if (m && threadId) {
            await this.port.post(threadId, { username: '회의록', content: minutesText(m) });
            sent++;
          }
        }
      } catch (err) {
        this.log(`거울 전송 실패(#${ev.seq}): ${(err as Error).message}`);
        return sent;
      }
      setState(c, CURSOR, ev.seq);
    }
    return sent;
  }
}
