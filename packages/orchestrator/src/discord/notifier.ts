// 알림 (10장 알림 단계). events 테이블을 순번대로 읽어 Discord에 올린다. 순번 커서는 DB에 남는다.
// - 결재 요청·막힘은 바로 올려 버튼을 쓸 수 있게 한다. 다만 점검 시간 밖이고 CEO가 부재면
//   휴대폰 알림 없이(@silent) 올리고, 다음 점검 시각에 멘션 한 번으로 묶어 알린다 (3단계 결정 B).
// - 완료는 조용히 기록(멘션 없음). 예산 상한 근접·초과, 시스템 이상은 즉시 알림 대상.
// - 시간당 즉시 알림(멘션) 수에 상한을 둔다 (폭주 방지).
import { eq, gt, like } from 'drizzle-orm';
import { staffUpdate } from '../staff/voice.ts';
import { personalNameOf } from '../staff/org.ts';
import { chiefRequestMessage, markChiefRequestPosted, unpostedChiefRequests } from '../chief/requests.ts';
import { getState, inTx, setState, type Ctx } from '../context.ts';
import type { ApprovalRow } from '../core/approvals.ts';
import { budgetStatus } from '../core/budget.ts';
import { approvals, events, meetingMinutes, messages, orders, plans, projects, systemState, tickets } from '../db/schema.ts';
import { approvalLink } from '../reports.ts';
import { approvalMessageFor, blockedMessage, blockedPlanMessage, clarificationMessage, decidedMessage } from './messages.ts';
import { clarificationOf, orderChannelKey } from '../core/clarifications.ts';
import { isCeoPresent } from './presence.ts';
import { isInCheckWindow } from './schedule.ts';
import type { Button, ChannelKey, DiscordPort } from './types.ts';
import { projectChannel, type ProjectChannelKind } from './project-channels.ts';
import { roleBotFor } from './staff-bots.ts';
import type { TicketRow } from '../core/tickets.ts';

const CURSOR = 'discord.cursor';
const HELD = 'discord.held';
const MENTIONS = 'discord.mentions';
const NEAR = 'discord.nearLimit';
/** #막힘에 이미 올린 "계획 작성 멈춤" 지시 */
const PLAN_NOTICED = 'discord.planBlockedNoticed';
const BUDGET_NAME: Readonly<Record<string, string>> = { dev: 'Claude 개발 몫', research: 'Claude 리서치 몫', review: 'GPT 리뷰어 몫' };

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

  private projectOf(ticket: TicketRow): string | null {
    return this.c.db.select().from(plans).where(eq(plans.id, ticket.planId)).get()?.projectId
      ?? this.c.db.select().from(orders).where(eq(orders.id, ticket.orderId)).get()?.projectId ?? null;
  }

  private route(projectId: string | null | undefined, kind: ProjectChannelKind, employeeId: string) {
    const channelId = projectChannel(this.c, projectId, kind);
    return { employeeId: roleBotFor(this.c, employeeId), ...(channelId ? { channelId } : {}) };
  }

  /**
   * 막힘 해설 (16장 7-5): 원래 알림 뒤에 따로 조용히 올린다. 원래 메시지를 고치지 않는 것은
   * CEO가 그 메시지의 버튼을 눌러 내용이 바뀌는 것과 부딪히지 않게 하기 위해서다.
   */
  private async explainAfter(channel: ChannelKey, notice: string, channelId?: string): Promise<void> {
    if (!this.explain) return;
    try {
      const lines = await this.explain(notice);
      if (lines?.length) await this.port.send({ channel, employeeId: 'qa-local', ...(channelId ? { channelId } : {}), content: `**해설** (막힘 해설가)\n${lines.map((l) => `- ${l}`).join('\n')}`, silent: true });
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
  private async sendImmediate(channel: ChannelKey, msg: { content: string; channelId?: string; employeeId?: string; buttons?: Button[][] }, held: Omit<Held, 'link'>): Promise<string> {
    const loud = this.allowedNow() && this.mentionBudgetLeft();
    const sent = await this.port.send({ channel, ...(msg.channelId ? { channelId: msg.channelId } : {}), ...(msg.employeeId ? { employeeId: msg.employeeId } : {}), content: loud ? this.mention() + msg.content : msg.content, ...(msg.buttons ? { buttons: msg.buttons } : {}), silent: !loud });
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
    posts += await this.checkChiefRequests();
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
      const route = this.route(order.projectId, 'blocked', 'pm');
      await this.sendImmediate('blocked', { ...planMsg, ...route }, { kind: 'blocked', text: `${order.id} 계획 작성 멈춤` });
      noticed.push(b.mark);
      setState(c, PLAN_NOTICED, noticed); // 올릴 때마다 남긴다(중간에 실패해도 두 번 올리지 않게)
      posts++;
      await this.explainAfter('blocked', planMsg.content, route.channelId);
    }
    setState(c, PLAN_NOTICED, noticed);
    return posts;
  }

  /** 이벤트 종류 → 알림. 올린 수를 돌려준다(올릴 것이 없으면 0) */
  private readonly handlers = new Map<string, (p: Payload) => Promise<number>>([
    ['plan.status', (p) => this.onPlanStatus(p)],
    ['approval.requested', (p) => this.onApprovalRequested(p)],
    ['approval.decided', (p) => this.onApprovalDecided(p)],
    ['ticket.status', (p) => this.onTicketStatus(p)],
    ['system.paused', (p) => this.onSystemPaused(p)],
    ['system.resumed', (p) => this.onSystemResumed(p)],
    ['git.push', (p) => this.onGitPush(p)],
    ['usage.updated', (p) => this.onUsageUpdated(p)],
  ]);

  private async handle(type: string, p: Payload): Promise<number> {
    return (await this.handlers.get(type)?.(p)) ?? 0;
  }

  /** PM 질문 답변 대기: 프로젝트 기획 채널(없으면 지시한 채널)에 질문을 올린다 */
  private async onPlanStatus(p: Payload): Promise<number> {
    if (p.status !== 'awaiting-answers') return 0;
    const c = this.c;
    const orderId = String(p.orderId);
    const order = c.db.select().from(orders).where(eq(orders.id, orderId)).get();
    const state = clarificationOf(c, orderId);
    if (!order || order.status !== 'planning' || state.rounds.length !== p.round || state.rounds.at(-1)?.answer !== null) return 0;
    const legacyProjectChannel = order.projectId ? c.db.select().from(projects).where(eq(projects.id, order.projectId)).get()?.discordChannelId : null;
    const channelId = projectChannel(c, order.projectId, 'planning') ?? getState<string | null>(c, orderChannelKey(orderId), null) ?? legacyProjectChannel;
    const messageId = await this.sendImmediate('secretary', { ...clarificationMessage(order, state), employeeId: 'pm', ...(channelId ? { channelId } : {}) }, { kind: 'alert', text: `${orderId} PM 질문 답변 대기` });
    setState(c, `discord.pmQuestion:${messageId}`, { orderId, round: state.rounds.length });
    return 1;
  }

  /** 결재 메시지 (계획서면 계획서, 티켓 결재면 티켓을 함께 보여 준다) */
  private approvalMessage(a: ApprovalRow) {
    const plan = a.kind === 'plan' ? (this.c.db.select().from(plans).where(eq(plans.id, a.targetId)).get() ?? null) : null;
    const ticket = this.c.db.select().from(tickets).where(eq(tickets.id, a.targetId)).get() ?? null;
    return { plan, ticket, msg: approvalMessageFor(a, plan, ticket) };
  }

  private async onApprovalRequested(p: Payload): Promise<number> {
    const c = this.c;
    const a = c.db.select().from(approvals).where(eq(approvals.id, String(p.approvalId))).get();
    if (!a || a.discordMessageId || a.status !== 'pending') return 0; // 이미 올렸거나 그사이 끝남
    const { plan, ticket, msg } = this.approvalMessage(a);
    const employeeId = a.kind === 'plan' ? 'pm' : ['push', 'main-merge', 'revert'].includes(a.kind) ? 'git-cat' : ticket?.assigneeId ?? 'qa-local';
    const route = this.route(plan?.projectId ?? (ticket ? this.projectOf(ticket) : null), 'approvals', employeeId);
    const id = await this.sendImmediate('approvals', { ...msg, ...route }, { kind: 'approval', text: a.summary });
    c.db.update(approvals).set({ discordMessageId: id }).where(eq(approvals.id, a.id)).run();
    return 1;
  }

  /** 결정된 결재는 원래 메시지를 고쳐 버튼을 없앤다 */
  private async onApprovalDecided(p: Payload): Promise<number> {
    const c = this.c;
    const a = c.db.select().from(approvals).where(eq(approvals.id, String(p.approvalId))).get();
    if (!a?.discordMessageId) return 0;
    const msg = decidedMessage(this.approvalMessage(a).msg, a.status, a.choice, a.decidedAt ?? c.clock.now().toISOString());
    await this.port.edit('approvals', a.discordMessageId, msg);
    return 1;
  }

  private async onTicketStatus(p: Payload): Promise<number> {
    const c = this.c;
    const ticket = c.db.select().from(tickets).where(eq(tickets.id, String(p.ticketId))).get();
    if (!ticket || p.from === p.to) return 0;
    const projectId = this.projectOf(ticket);
    if ((p.to === 'in_progress' && p.from === 'planned') || p.to === 'in_review' || p.to === 'rework' || p.to === 'meeting') {
      const reviewing = p.to === 'in_review' || p.to === 'meeting';
      const route = this.route(projectId, 'todo', reviewing ? ticket.reviewerId : ticket.assigneeId);
      const status = staffUpdate(reviewing ? ticket.reviewerId : ticket.assigneeId, String(p.to));
      await this.port.send({ channel: 'reports', ...route, content: `**${ticket.id} ${ticket.title}**\n\n${status}\n\n**마무리할 때 확인할 내용**\n${ticket.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')}`, silent: true });
      return 1;
    }
    if (p.to === 'blocked' && p.from !== 'paused') {
      const minutes = c.db.select().from(meetingMinutes).where(eq(meetingMinutes.ticketId, ticket.id)).all().at(-1) ?? null;
      const msg = blockedMessage(ticket, minutes, typeof p.event === 'string' ? p.event : undefined);
      const route = this.route(projectId, 'blocked', ticket.assigneeId);
      await this.sendImmediate('blocked', { ...msg, ...route }, { kind: 'blocked', text: `${ticket.id} ${ticket.title}` });
      await this.explainAfter('blocked', msg.content, route.channelId);
      return 1;
    }
    if (p.to === 'done') {
      // 조용히 기록 (멘션 없음)
      await this.port.send({ channel: 'reports', ...this.route(projectId, 'completed', ticket.assigneeId), content: `**완료 · ${ticket.id} ${ticket.title}**${ticket.reworkCount ? ` (반려 ${ticket.reworkCount}회)` : ''}\n\n${staffUpdate(ticket.assigneeId, 'done')}\n\n**확인한 내용**\n${ticket.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')}`, silent: true });
      return 1;
    }
    if (p.to === 'paused' && p.reason === 'system-error') {
      await this.sendImmediate('reports', { ...this.route(projectId, 'blocked', ticket.assigneeId), content: `시스템 이상 · ${ticket.id} ${ticket.title} 작업을 멈췄어요. 사무실 화면의 티켓 기록을 확인해 주세요` }, { kind: 'alert', text: `시스템 이상: ${ticket.id}` });
      // 해설에는 마지막 시스템 기록(멈춘 이유)을 함께 준다
      const last = c.db.select().from(messages).where(eq(messages.ticketId, ticket.id)).all().filter((m) => m.kind === 'system').at(-1);
      await this.explainAfter('reports', `시스템 이상 · ${ticket.id} ${ticket.title} 작업을 멈춤${last ? `\n이유: ${last.content.slice(0, 500)}` : ''}`);
      return 1;
    }
    return 0;
  }

  /**
   * 비서실장 확인 요청: 아직 안 올린 요청을 #결재함에 [실행] [하지 않기]와 함께 올린다. 실행은 사장님 클릭으로만 (chief/requests.ts).
   * 이벤트가 아니라 요청 상태를 직접 본다(계획 작성 멈춤과 같은 방식). 보내기에 실패하면 다음 바퀴에 다시 올린다.
   */
  private async checkChiefRequests(): Promise<number> {
    let posts = 0;
    for (const req of unpostedChiefRequests(this.c)) {
      const messageId = await this.sendImmediate('approvals', chiefRequestMessage(req), { kind: 'approval', text: `비서실장 요청 · ${req.what.split('\n')[0]}` });
      markChiefRequestPosted(this.c, req.id, messageId);
      posts++;
    }
    return posts;
  }

  private async onSystemPaused(p: Payload): Promise<number> {
    if (p.by === 'connectivity') {
      await this.sendImmediate('reports', { content: '인터넷이 끊겨 Claude·GPT 직원의 티켓을 멈췄어요. 로컬 직원은 계속 일해요' }, { kind: 'alert', text: '인터넷 끊김' });
      return 1;
    }
    if (p.by === 'ceo') {
      await this.port.send({ channel: 'reports', content: `모든 직원을 멈췄어요 (/정지). 멈춘 티켓 ${(p.tickets as string[] | undefined)?.length ?? 0}개`, silent: true });
      return 1;
    }
    if (p.by === 'chief-of-staff') {
      // 비서실장 비상 정지 (7장, 2026-10-22): 사장님이 시키지 않았을 수 있으니 바로 알린다
      const name = personalNameOf('chief-of-staff');
      await this.sendImmediate('reports', { content: `비서실장${name ? ` ${name}` : ''}이 비상 정지로 모든 직원을 멈췄어요.\n이유: ${String(p.reason ?? '')}\n다시 시작은 사장님이 /재개로 해요` }, { kind: 'alert', text: '비서실장 비상 정지' });
      return 1;
    }
    return 0;
  }

  private async onSystemResumed(p: Payload): Promise<number> {
    if (p.by !== 'ceo') return 0;
    await this.port.send({ channel: 'reports', content: '다시 일을 시작해요 (/재개)', silent: true });
    return 1;
  }

  private async onGitPush(p: Payload): Promise<number> {
    const t = String(p.ticketId ?? '');
    const ticket = this.c.db.select().from(tickets).where(eq(tickets.id, t)).get();
    const projectId = ticket ? this.projectOf(ticket) : null;
    if (p.ok) {
      // 조용히 기록: 우체통 발송 완료 (11장 화면 연출과 같은 이벤트)
      const extra = p.backup ? ` · 백업 ${String(p.backup)} · 합친 상태 테스트 통과` : p.revert ? ` · ${String(p.revert)} 되돌림` : '';
      await this.port.send({ channel: 'reports', ...this.route(projectId, 'completed', 'git-cat'), content: `Git 고양이 · ${t} → ${String(p.target)} 푸시 완료 (${String(p.sha)})${extra}`, silent: true });
      return 1;
    }
    const failure = `Git 고양이 · ${t} ${String(p.stage)} 실패\n${String(p.reason)}`;
    const route = this.route(projectId, 'blocked', 'git-cat');
    await this.sendImmediate('blocked', { content: failure, ...route }, { kind: 'blocked', text: `${t} 푸시 실패` });
    await this.explainAfter('blocked', failure, route.channelId);
    return 1;
  }

  private async onUsageUpdated(p: Payload): Promise<number> {
    if (p.reason !== 'provider-limit') return 0;
    const name = BUDGET_NAME[String(p.budget)] ?? String(p.budget);
    await this.sendImmediate('reports', { content: `예산 · ${name}이 제공자 한도에 닿아 ${String(p.blockedUntil).slice(0, 16).replace('T', ' ')}까지 멈춰요` }, { kind: 'alert', text: `${name} 한도 도달` });
    return 1;
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
      const name = BUDGET_NAME[b];
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

