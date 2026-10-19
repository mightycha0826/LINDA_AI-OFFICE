// 알림 (10장 알림 단계). events 테이블을 순번대로 읽어 Discord에 올린다. 순번 커서는 DB에 남는다.
// - 결재 요청·막힘은 바로 올려 버튼을 쓸 수 있게 한다. 다만 점검 시간 밖이고 CEO가 부재면
//   휴대폰 알림 없이(@silent) 올리고, 다음 점검 시각에 멘션 한 번으로 묶어 알린다 (3단계 결정 B).
// - 완료는 조용히 기록(멘션 없음). 예산 상한 근접·초과, 시스템 이상은 즉시 알림 대상.
// - 시간당 즉시 알림(멘션) 수에 상한을 둔다 (폭주 방지).
import { eq, gt, like } from 'drizzle-orm';
import { getState, inTx, setState, type Ctx } from '../context.ts';
import { budgetStatus } from '../core/budget.ts';
import { approvals, events, meetingMinutes, messages, orders, plans, systemState, tickets } from '../db/schema.ts';
import { approvalLink } from '../reports.ts';
import { approvalMessageFor, blockedMessage, blockedPlanMessage, decidedMessage } from './messages.ts';
import { isCeoPresent } from './presence.ts';
import { isInCheckWindow } from './schedule.ts';
import type { ChannelKey, DiscordPort } from './types.ts';

const CURSOR = 'discord.cursor';
const HELD = 'discord.held';
const MENTIONS = 'discord.mentions';
const NEAR = 'discord.nearLimit';
/** #막힘에 이미 올린 "계획 작성 멈춤" 지시 */
const PLAN_NOTICED = 'discord.planBlockedNoticed';

interface Held {
  kind: 'approval' | 'blocked' | 'alert';
  text: string;
  link: string | null;
}

type Payload = Record<string, unknown>;

export class Notifier {
  private readonly c: Ctx;
  private readonly port: DiscordPort;
  private readonly log: (s: string) => void;
  private readonly explain: ((notice: string) => Promise<string[] | null>) | undefined;

  /** explain: 막힘 해설가 (16장 7-5). 알림 원문을 받아 2~3줄 해설. 없거나 실패하면 해설 없이 */
  constructor(c: Ctx, port: DiscordPort, log: (s: string) => void = () => {}, explain?: (notice: string) => Promise<string[] | null>) {
    this.c = c;
    this.port = port;
    this.log = log;
    this.explain = explain;
  }

  /**
   * 막힘 해설 (16장 7-5): 원래 알림 뒤에 따로 조용히 올린다. 원래 메시지를 고치지 않는 것은
   * CEO가 그 메시지의 버튼을 눌러 내용이 바뀌는 것과 부딪히지 않게 하기 위해서다.
   */
  private async explainAfter(channel: ChannelKey, notice: string): Promise<void> {
    if (!this.explain) return;
    try {
      const lines = await this.explain(notice);
      if (lines?.length) await this.port.send({ channel, content: `**해설** (막힘 해설가)\n${lines.map((l) => `- ${l}`).join('\n')}`, silent: true });
    } catch (err) {
      this.log(`막힘 해설 실패(건너뜀): ${(err as Error).message}`);
    }
  }

  /** 지금 멘션(휴대폰 알림)을 보내도 되는가: 점검 시간이거나 CEO 접속 중 */
  allowedNow(): boolean {
    return isInCheckWindow(this.c.config, this.c.clock.now()) || isCeoPresent(this.c);
  }

  private mentionBudgetLeft(): boolean {
    const hourAgo = this.c.clock.now().getTime() - 3_600_000;
    const recent = getState<string[]>(this.c, MENTIONS, []).filter((t) => new Date(t).getTime() > hourAgo);
    return recent.length < this.c.config.schedule.maxImmediatePerHour;
  }

  private useMention(): void {
    const hourAgo = this.c.clock.now().getTime() - 3_600_000;
    const recent = getState<string[]>(this.c, MENTIONS, []).filter((t) => new Date(t).getTime() > hourAgo);
    setState(this.c, MENTIONS, [...recent, this.c.clock.now().toISOString()]);
  }

  private hold(item: Held): void {
    setState(this.c, HELD, [...getState<Held[]>(this.c, HELD, []), item]);
  }

  private mention(): string {
    return `<@${this.c.config.ceoDiscordId}> `;
  }

  /**
   * 알려야 하는 메시지를 올린다. 지금 멘션해도 되고 시간당 상한 안이면 멘션을 붙이고,
   * 아니면 조용히 올리고 다음 점검 때 묶어서 알린다.
   */
  private async sendImmediate(channel: ChannelKey, msg: { content: string; buttons?: import('./types.ts').Button[][] }, held: Omit<Held, 'link'>): Promise<string> {
    const loud = this.allowedNow() && this.mentionBudgetLeft();
    const sent = await this.port.send({ channel, content: loud ? this.mention() + msg.content : msg.content, ...(msg.buttons ? { buttons: msg.buttons } : {}), silent: !loud });
    if (loud) this.useMention();
    else this.hold({ ...held, link: sent.url });
    return sent.messageId;
  }

  async tick(): Promise<number> {
    const c = this.c;
    const cursor = getState<number>(c, CURSOR, 0);
    const batch = c.db.select().from(events).where(gt(events.seq, cursor)).orderBy(events.seq).limit(200).all();
    let posts = 0;
    for (const ev of batch) {
      try {
        posts += await this.handle(ev.type, ev.payload as Payload);
      } catch (err) {
        // 보내기에 실패하면 커서를 멈추고 다음 바퀴에 다시 시도한다
        this.log(`Discord 알림 실패(#${ev.seq} ${ev.type}): ${(err as Error).message}`);
        return posts;
      }
      setState(c, CURSOR, ev.seq);
    }
    posts += await this.checkBlockedPlans();
    posts += await this.checkNearLimits();
    posts += await this.flushHeld();
    return posts;
  }

  /**
   * 계획 작성이 멈춘 지시를 #막힘에 [다시 시도][취소]와 함께 한 번 올린다.
   * 이벤트가 아니라 멈춤 상태를 직접 보므로, 이 기능이 생기기 전에 멈춘 지시도 올라간다.
   * 다시 시도·취소로 풀리면 목록에서 빠지고, 또 멈추면 다시 올린다.
   */
  private async checkBlockedPlans(): Promise<number> {
    const c = this.c;
    // 멈출 때마다 '지시@멈춘 시각'으로 구분한다(예전 값은 글자만 있어 'legacy')
    const blocked = c.db
      .select()
      .from(systemState)
      .where(like(systemState.key, 'planBlocked:%'))
      .all()
      .map((r) => {
        const v = r.value as string | { issues: string; at: string };
        const orderId = r.key.slice('planBlocked:'.length);
        const { issues, at } = typeof v === 'string' ? { issues: v, at: 'legacy' } : v;
        return { orderId, issues, mark: `${orderId}@${at}` };
      });
    const live = new Set(blocked.map((b) => b.mark));
    const noticed = getState<string[]>(c, PLAN_NOTICED, []).filter((m) => live.has(m));
    let posts = 0;
    for (const b of blocked) {
      if (noticed.includes(b.mark)) continue;
      const order = c.db.select().from(orders).where(eq(orders.id, b.orderId)).get();
      if (!order || order.status !== 'planning') continue;
      const planMsg = blockedPlanMessage(order, b.issues);
      await this.sendImmediate('blocked', planMsg, { kind: 'blocked', text: `${order.id} 계획 작성 멈춤` });
      noticed.push(b.mark);
      setState(c, PLAN_NOTICED, noticed); // 올릴 때마다 남긴다(중간에 실패해도 두 번 올리지 않게)
      posts++;
      await this.explainAfter('blocked', planMsg.content);
    }
    setState(c, PLAN_NOTICED, noticed);
    return posts;
  }

  private async handle(type: string, p: Payload): Promise<number> {
    const c = this.c;
    if (type === 'approval.requested') {
      const a = c.db.select().from(approvals).where(eq(approvals.id, String(p.approvalId))).get();
      if (!a || a.discordMessageId || a.status !== 'pending') return 0; // 이미 올렸거나 그사이 끝남
      const plan = a.kind === 'plan' ? (c.db.select().from(plans).where(eq(plans.id, a.targetId)).get() ?? null) : null;
      const ticket = c.db.select().from(tickets).where(eq(tickets.id, a.targetId)).get() ?? null;
      const msg = approvalMessageFor(a, plan, ticket);
      const id = await this.sendImmediate('approvals', msg, { kind: 'approval', text: a.summary });
      c.db.update(approvals).set({ discordMessageId: id }).where(eq(approvals.id, a.id)).run();
      return 1;
    }
    if (type === 'approval.decided') {
      const a = c.db.select().from(approvals).where(eq(approvals.id, String(p.approvalId))).get();
      if (!a?.discordMessageId) return 0;
      const plan = a.kind === 'plan' ? (c.db.select().from(plans).where(eq(plans.id, a.targetId)).get() ?? null) : null;
      const ticket = c.db.select().from(tickets).where(eq(tickets.id, a.targetId)).get() ?? null;
      const msg = decidedMessage(approvalMessageFor(a, plan, ticket), a.status, a.choice, a.decidedAt ?? c.clock.now().toISOString());
      await this.port.edit('approvals', a.discordMessageId, msg);
      return 1;
    }
    if (type === 'ticket.status') {
      const ticket = c.db.select().from(tickets).where(eq(tickets.id, String(p.ticketId))).get();
      if (!ticket || p.from === p.to) return 0;
      if (p.to === 'blocked' && p.from !== 'paused') {
        const minutes = c.db.select().from(meetingMinutes).where(eq(meetingMinutes.ticketId, ticket.id)).all().at(-1) ?? null;
        const msg = blockedMessage(ticket, minutes);
        await this.sendImmediate('blocked', msg, { kind: 'blocked', text: `${ticket.id} ${ticket.title}` });
        await this.explainAfter('blocked', msg.content);
        return 1;
      }
      if (p.to === 'done') {
        // 조용히 기록 (멘션 없음)
        await this.port.send({ channel: 'reports', content: `완료 · ${ticket.id} ${ticket.title}${ticket.reworkCount ? ` (반려 ${ticket.reworkCount}회)` : ''}`, silent: true });
        return 1;
      }
      if (p.to === 'paused' && p.reason === 'system-error') {
        await this.sendImmediate('reports', { content: `시스템 이상 · ${ticket.id} ${ticket.title} 작업을 멈췄어요. 사무실 화면의 티켓 기록을 확인해 주세요` }, { kind: 'alert', text: `시스템 이상: ${ticket.id}` });
        // 해설에는 마지막 시스템 기록(멈춘 이유)을 함께 준다
        const last = c.db.select().from(messages).where(eq(messages.ticketId, ticket.id)).all().filter((m) => m.kind === 'system').at(-1);
        await this.explainAfter('reports', `시스템 이상 · ${ticket.id} ${ticket.title} 작업을 멈춤${last ? `\n이유: ${last.content.slice(0, 500)}` : ''}`);
        return 1;
      }
      return 0;
    }
    if (type === 'system.paused' && p.by === 'connectivity') {
      await this.sendImmediate('reports', { content: '인터넷이 끊겨 Claude·GPT 직원의 티켓을 멈췄어요. 로컬 직원은 계속 일해요' }, { kind: 'alert', text: '인터넷 끊김' });
      return 1;
    }
    if (type === 'system.paused' && p.by === 'ceo') {
      await this.port.send({ channel: 'reports', content: `모든 직원을 멈췄어요 (/정지). 멈춘 티켓 ${(p.tickets as string[] | undefined)?.length ?? 0}개`, silent: true });
      return 1;
    }
    if (type === 'system.resumed' && p.by === 'ceo') {
      await this.port.send({ channel: 'reports', content: '다시 일을 시작해요 (/재개)', silent: true });
      return 1;
    }
    if (type === 'git.push') {
      const t = String(p.ticketId ?? '');
      if (p.ok) {
        // 조용히 기록: 우체통 발송 완료 (11장 화면 연출과 같은 이벤트)
        const extra = p.backup ? ` · 백업 ${String(p.backup)} · 합친 상태 테스트 통과` : p.revert ? ` · ${String(p.revert)} 되돌림` : '';
        await this.port.send({ channel: 'reports', content: `Git 고양이 · ${t} → ${String(p.target)} 푸시 완료 (${String(p.sha)})${extra}`, silent: true });
        return 1;
      }
      const failure = `Git 고양이 · ${t} ${String(p.stage)} 실패\n${String(p.reason)}`;
      await this.sendImmediate('blocked', { content: failure }, { kind: 'blocked', text: `${t} 푸시 실패` });
      await this.explainAfter('blocked', failure);
      return 1;
    }
    if (type === 'usage.updated' && p.reason === 'provider-limit') {
      const name = { dev: 'Claude 개발 몫', research: 'Claude 리서치 몫', review: 'GPT 리뷰어 몫' }[String(p.budget)] ?? String(p.budget);
      await this.sendImmediate('reports', { content: `예산 · ${name}이 제공자 한도에 닿아 ${String(p.blockedUntil).slice(0, 16).replace('T', ' ')}까지 멈춰요` }, { kind: 'alert', text: `${name} 한도 도달` });
      return 1;
    }
    return 0;
  }

  /** 예산 상한 근접(90%) 알림. 몫마다 5시간에 한 번 */
  private async checkNearLimits(): Promise<number> {
    let posts = 0;
    const sent = getState<Record<string, string>>(this.c, NEAR, {});
    const now = this.c.clock.now().getTime();
    for (const b of ['dev', 'research', 'review'] as const) {
      const s = budgetStatus(this.c, b);
      const near = s.fiveHour.limit && s.fiveHour.used >= s.fiveHour.limit * 0.9;
      const last = sent[b] ? new Date(sent[b]).getTime() : 0;
      if (!near || now - last < 5 * 3_600_000) continue;
      const name = { dev: 'Claude 개발 몫', research: 'Claude 리서치 몫', review: 'GPT 리뷰어 몫' }[b];
      await this.sendImmediate('reports', { content: `예산 · ${name}을 5시간 한도의 ${s.fiveHour.used.toFixed(0)}% 썼어요 (상한 ${s.fiveHour.limit}%, 추정치)` }, { kind: 'alert', text: `${name} 상한 근접` });
      sent[b] = new Date(now).toISOString();
      setState(this.c, NEAR, sent);
      posts++;
    }
    return posts;
  }

  /** 점검 시간이 되거나 CEO가 들어오면 모아 둔 알림을 멘션 한 번으로 묶어 보낸다 */
  private async flushHeld(): Promise<number> {
    const held = getState<Held[]>(this.c, HELD, []);
    // 묶음 멘션도 시간당 상한 안에서만 보낸다
    if (held.length === 0 || !this.allowedNow() || !this.mentionBudgetLeft()) return 0;
    const count = (k: Held['kind']) => held.filter((h) => h.kind === k).length;
    const head = [count('approval') && `결재 대기 ${count('approval')}건`, count('blocked') && `막힘 ${count('blocked')}건`, count('alert') && `알림 ${count('alert')}건`].filter(Boolean).join(' · ');
    const lines = held.map((h) => `- ${h.text}${h.link ? ` — ${h.link}` : ''}`);
    await this.port.send({ channel: count('approval') ? 'approvals' : 'reports', content: `${this.mention()}${head}\n${lines.join('\n')}` });
    inTx(this.c, (t) => {
      setState(t, HELD, []);
    });
    this.useMention();
    return 1;
  }
}

