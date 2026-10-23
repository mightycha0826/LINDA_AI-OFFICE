// 보고 데이터 (10장 보고 형식). 순서는 항상 같다: 1 완료 2 결재 대기 3 막힌 것 4 사용량 5 시스템 상태(이상이 있을 때만).
// 비서실장이 요약을 쓰고, 이 데이터는 /보고와 비서실장이 없을 때의 대체 보고에 그대로 쓴다.
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { Ctx } from './context.ts';
import { getState, isStopped } from './context.ts';
import { BUDGET_NAME, budgetStatus } from './core/budget.ts';
import { approvals, retros, tickets, usage } from './db/schema.ts';

export interface ReportData {
  since: string;
  done: { id: string; title: string; reworkCount: number; lowPrecision: boolean }[];
  pendingApprovals: { id: string; kind: string; summary: string; link: string | null }[];
  blocked: { id: string; title: string }[];
  paused: { id: string; title: string; reason: string }[];
  usage: { budget: keyof typeof BUDGET_NAME; fiveHour: number; fiveHourLimit: number | null; weekly: number; weeklyLimit: number | null; blockedUntil: string | null }[];
  estimated: boolean;
  stopped: boolean;
  /** Claude 계정 전체 사용률(실측, 주인 개인 사용 포함) */
  claudeAccount: { fiveHourPct: number | null; weeklyPct: number | null; at: string } | null;
  /** 하루 안에 쓴 주간 회고 (일요일 22:00 보고에 들어간다, 14장) */
  weeklyRetro: { week: string; summary: string; rejections: number; byCategory: Record<string, number>; ineffectiveRules: string[] } | null;
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
    claudeAccount: getState<{ fiveHourPct: number | null; weeklyPct: number | null; at: string } | null>(c, 'account.claude', null),
    weeklyRetro: latestWeeklyRetro(c),
  };
}

function latestWeeklyRetro(c: Ctx): ReportData['weeklyRetro'] {
  const since = new Date(c.clock.now().getTime() - 24 * 3_600_000).toISOString();
  const r = c.db.select().from(retros).where(and(eq(retros.kind, 'weekly'), gte(retros.createdAt, since))).orderBy(desc(retros.createdAt)).get();
  if (!r) return null;
  const st = (r.stats ?? {}) as { rejections?: number; byCategory?: Record<string, number>; rules?: { text: string; ineffective: boolean }[] };
  return { week: r.week ?? '', summary: r.summary ?? '', rejections: st.rejections ?? 0, byCategory: st.byCategory ?? {}, ineffectiveRules: (st.rules ?? []).filter((x) => x.ineffective).map((x) => x.text) };
}

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
  if (d.claudeAccount) {
    const a = d.claudeAccount;
    const p = (n: number | null) => (n === null ? '?' : `${n}%`);
    lines.push(`- Claude 계정 전체(개인 사용 포함, 실측): 5시간 ${p(a.fiveHourPct)} · 주간 ${p(a.weeklyPct)}`);
  }
  if (anomalies.length || d.stopped) {
    lines.push('**5. 시스템 상태**', list([...(d.stopped ? ['/정지 중이에요'] : []), ...anomalies.map((p) => `${p.id} ${p.title}: ${PAUSE_NAME[p.reason] ?? p.reason}`)], (x) => x));
  }
  if (d.weeklyRetro) {
    const w = d.weeklyRetro;
    const cats = Object.entries(w.byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    lines.push(`**주간 회고 (${w.week})**`, w.summary, `- 반려 ${w.rejections}건${cats ? ` (${cats})` : ''}`);
    if (w.ineffectiveRules.length) lines.push(list(w.ineffectiveRules, (x) => `효과 없음: ${x} → #결재함에 삭제 제안`));
  }
  return lines.join('\n');
}
