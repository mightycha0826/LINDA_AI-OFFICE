// 보고 데이터 (10장 보고 형식). 순서는 항상 같다: 1 완료 2 결재 대기 3 막힌 것 4 사용량 5 시스템 상태(이상이 있을 때만).
// 비서실장이 요약을 쓰고, 이 데이터는 /보고와 비서실장이 없을 때의 대체 보고에 그대로 쓴다.
import { and, eq, gte, inArray } from 'drizzle-orm';
import type { Ctx } from './context.ts';
import { isStopped } from './context.ts';
import { budgetStatus } from './core/budget.ts';
import { approvals, tickets, usage } from './db/schema.ts';

export interface ReportData {
  since: string;
  done: { id: string; title: string; reworkCount: number; lowPrecision: boolean }[];
  pendingApprovals: { id: string; kind: string; summary: string; link: string | null }[];
  blocked: { id: string; title: string }[];
  paused: { id: string; title: string; reason: string }[];
  usage: { budget: string; fiveHour: number; fiveHourLimit: number | null; weekly: number; weeklyLimit: number | null; blockedUntil: string | null }[];
  estimated: boolean;
  stopped: boolean;
}

export function approvalLink(c: Ctx, discordMessageId: string | null): string | null {
  const { guildId, channels } = c.config.discord;
  return discordMessageId && guildId ? `https://discord.com/channels/${guildId}/${channels.approvals}/${discordMessageId}` : null;
}

export function buildReportData(c: Ctx, since: string): ReportData {
  const done = c.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.status, 'done'), gte(tickets.finishedAt, since)))
    .all();
  const pending = c.db.select().from(approvals).where(eq(approvals.status, 'pending')).all();
  const stuck = c.db.select().from(tickets).where(inArray(tickets.status, ['blocked', 'paused'])).all();
  const recentUsage = c.db.select().from(usage).where(gte(usage.createdAt, new Date(c.clock.now().getTime() - 7 * 24 * 3_600_000).toISOString())).all();
  return {
    since,
    done: done.map((t) => ({ id: t.id, title: t.title, reworkCount: t.reworkCount, lowPrecision: t.lowPrecision })),
    pendingApprovals: pending.map((a) => ({ id: a.id, kind: a.kind, summary: a.summary, link: approvalLink(c, a.discordMessageId) })),
    blocked: stuck.filter((t) => t.status === 'blocked').map((t) => ({ id: t.id, title: t.title })),
    paused: stuck.filter((t) => t.status === 'paused').map((t) => ({ id: t.id, title: t.title, reason: t.pauseReason ?? '' })),
    usage: (['dev', 'research', 'review'] as const).map((b) => {
      const s = budgetStatus(c, b);
      return { budget: b, fiveHour: s.fiveHour.used, fiveHourLimit: s.fiveHour.limit, weekly: s.weekly.used, weeklyLimit: s.weekly.limit, blockedUntil: s.blockedUntil };
    }),
    estimated: recentUsage.some((u) => u.source === 'estimated'),
    stopped: isStopped(c),
  };
}

const BUDGET_NAME: Record<string, string> = { dev: 'Claude 개발', research: 'Claude 리서치', review: 'GPT 리뷰' };
const PAUSE_NAME: Record<string, string> = { 'ceo-stop': '/정지', budget: '한도 소진', offline: '인터넷 끊김', 'system-error': '시스템 이상', cap: '턴·토큰 상한' };

export function formatReportData(d: ReportData): string {
  const list = <T>(xs: T[], f: (x: T) => string) => (xs.length ? xs.map((x) => `- ${f(x)}`).join('\n') : '- 없음');
  const pct = (n: number) => `${n.toFixed(1)}%`;
  const anomalies = d.paused.filter((p) => p.reason !== 'budget');
  const lines = [
    '**1. 완료된 일**',
    list(d.done, (t) => `${t.id} ${t.title}${t.reworkCount ? ` (반려 ${t.reworkCount}회)` : ''}${t.lowPrecision ? ' · 저정밀 모드' : ''}`),
    '**2. 결재 대기**',
    list(d.pendingApprovals, (a) => `${a.summary}${a.link ? ` — ${a.link}` : ''}`),
    '**3. 막힌 것**',
    list([...d.blocked.map((b) => `${b.id} ${b.title}`), ...d.paused.filter((p) => p.reason === 'budget').map((p) => `${p.id} ${p.title} (한도 소진으로 멈춤)`)], (x) => x),
    `**4. 사용량** ${d.estimated ? '(추정치)' : ''}`,
    list(d.usage, (u) => `${BUDGET_NAME[u.budget]}: 5시간 ${pct(u.fiveHour)}/${u.fiveHourLimit}% · 주간 ${pct(u.weekly)}/${u.weeklyLimit}%${u.blockedUntil ? ` · 제공자 한도 도달, ${u.blockedUntil}까지 막음` : ''}`),
  ];
  if (anomalies.length || d.stopped) {
    lines.push('**5. 시스템 상태**', list([...(d.stopped ? ['/정지 중이에요'] : []), ...anomalies.map((p) => `${p.id} ${p.title}: ${PAUSE_NAME[p.reason] ?? p.reason}`)], (x) => x));
  }
  return lines.join('\n');
}
