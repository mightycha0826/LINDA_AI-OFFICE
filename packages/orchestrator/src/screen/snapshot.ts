// 사무실 화면 스냅샷 (12장 데이터 흐름 1). 화면을 열면 이것으로 현재 전체 상태를 받고, 그다음 SSE로 바뀐 것만 받는다.
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import type { Brain, ScreenAccountUsage, ScreenEmployee, ScreenLogEntry, ScreenTicket, Snapshot } from '@ai-office/shared';
import { getState, isStopped, type Ctx } from '../context.ts';
import { budgetStatus } from '../core/budget.ts';
import { approvals, employees, events, meetingMinutes, messages, orders, projects, tickets, usage } from '../db/schema.ts';
import { isCeoPresent } from '../discord/presence.ts';
import { localTime, nextCheckTime } from '../discord/schedule.ts';
import { approvalLink } from '../reports.ts';
import { jobOf, personalNameOf, rankOf } from '../staff/org.ts';

/** 이름표의 두뇌 이름. 조직도(2-0)의 말로 짧게: Claude·GPT·Gemma (자세한 모델은 자원 탭) */
export function brainLabel(id: string, b: Brain): string {
  if (id === 'chief-of-staff') return '헤르메스 · Gemma';
  switch (b.provider) {
    case 'claude-code':
      return 'Claude';
    case 'codex':
      return 'GPT';
    case 'ollama':
      return b.model === 'qwen3:14b' ? 'Qwen' : 'Gemma'; // gemma4:12b·gemma4:12b-64k
    case 'none':
      return '코드';
  }
}

/** 티켓 한 줄. 프로젝트는 지시를 봐야 알 수 있어 null로 두고, 스냅샷·상세가 withProject로 채운다 */
export function toScreenTicket(t: typeof tickets.$inferSelect): ScreenTicket {
  return {
    id: t.id,
    orderId: t.orderId,
    projectId: null,
    title: t.title,
    type: t.type,
    status: t.status,
    pausedFrom: t.pausedFrom,
    pauseReason: t.pauseReason,
    assigneeId: t.assigneeId,
    reviewerId: t.reviewerId,
    reworkCount: t.reworkCount,
    needsCeoApproval: t.needsCeoApproval,
    branch: t.branch,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    tokensUsed: t.tokensUsed,
    turnsUsed: t.turnsUsed,
    lowPrecision: t.lowPrecision,
  };
}

/** 화면에는 저장소 주소의 `사용자:토큰@` 부분을 싣지 않는다 (토큰을 주소에 넣어 등록했어도 화면으로 새지 않게) */
export const withoutCredentials = (url: string): string => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');

/** 지시 → 프로젝트 (2026-10-22: 업무 탭 프로젝트별 묶음, 이름표 프로젝트 칩) */
function orderProjects(c: Ctx, orderIds: string[]): Map<string, typeof orders.$inferSelect> {
  if (orderIds.length === 0) return new Map();
  return new Map(c.db.select().from(orders).where(inArray(orders.id, [...new Set(orderIds)])).all().map((o) => [o.id, o]));
}

const withProject = (t: typeof tickets.$inferSelect, byOrder: Map<string, typeof orders.$inferSelect>): ScreenTicket => ({ ...toScreenTicket(t), projectId: byOrder.get(t.orderId)?.projectId ?? null });

export interface SnapshotExtras {
  startedAt: string;
  gpu: { usedMB: number; totalMB: number } | null;
}

/** 오늘(설정 시간대) 0시의 UTC ISO */
function startOfLocalDay(c: Ctx): string {
  const now = c.clock.now();
  const t = localTime(now, c.config.schedule.timezone);
  return new Date(now.getTime() - t.minutes * 60_000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds()).toISOString();
}

export function buildSnapshot(c: Ctx, extras: SnapshotExtras): Snapshot {
  const now = c.clock.now();
  const today = startOfLocalDay(c);
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();

  const staff: ScreenEmployee[] = c.db
    .select()
    .from(employees)
    .all()
    .filter((e) => !e.leftAt || e.leftAt >= hourAgo)
    .map((e) => ({
      id: e.id,
      displayName: e.displayName,
      role: e.role,
      department: e.department,
      rank: rankOf(e.id, e.isTemporary),
      job: jobOf(e.id),
      personalName: personalNameOf(e.id),
      // 증명사진·3D 모델은 화면 서버가 assets 폴더를 보고 채운다 (http/screen-server.ts withAssets)
      portrait: null,
      model: null,
      brainLabel: brainLabel(e.id, e.brain),
      spriteSet: e.spriteSet,
      isTemporary: e.isTemporary,
      tempKind: e.tempKind,
      leftAt: e.leftAt,
    }));

  const ticketRows = c.db
    .select()
    .from(tickets)
    .where(or(inArray(tickets.status, ['planned', 'in_progress', 'in_review', 'rework', 'meeting', 'blocked', 'awaiting_approval', 'paused']), gte(tickets.finishedAt, today)))
    .all();
  const byOrder = orderProjects(
    c,
    ticketRows.map((t) => t.orderId),
  );

  const msgRows = c.db.select().from(messages).orderBy(desc(sql`rowid`)).limit(100).all();
  const minutesRows = c.db.select().from(meetingMinutes).orderBy(desc(meetingMinutes.createdAt)).limit(20).all();
  const log: ScreenLogEntry[] = [
    ...msgRows.map((m) => ({ id: m.id, at: m.createdAt, ticketId: m.ticketId, fromId: m.fromId, toId: m.toId, kind: m.kind, text: m.content.slice(0, 500), minutes: false })),
    ...minutesRows.map((m) => ({
      id: m.id,
      at: m.createdAt,
      ticketId: m.ticketId,
      fromId: 'orchestrator',
      toId: null,
      kind: 'minutes',
      text: `${m.kind === 'gate-review' ? 'GPT 관문' : '회의'} ${m.outcome === 'agreed' ? '합의' : '불합의'} · ${m.rounds.length}라운드 · 다음 할 일 ${m.nextActions.join(', ') || '없음'}`,
      minutes: true,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  // 푸시 중: 승인된 푸시·되돌리기 결재 중 아직 결과(git.push)가 없는 것
  const decided = c.db.select().from(approvals).where(and(inArray(approvals.kind, ['push', 'revert', 'main-merge']), eq(approvals.status, 'approved'))).all();
  const results = new Set(
    c.db
      .select()
      .from(events)
      .where(eq(events.type, 'git.push'))
      .all()
      .map((e) => (e.payload as { approvalId?: string }).approvalId)
      .filter(Boolean),
  );
  const pushing = decided.filter((a) => !results.has(a.id)).map((a) => a.targetId);

  const lastModel = c.db.select().from(events).where(eq(events.type, 'model.loaded')).orderBy(desc(events.seq)).limit(1).get();
  const lastError = c.db
    .select()
    .from(messages)
    .where(and(eq(messages.kind, 'system'), eq(messages.fromId, 'orchestrator')))
    .orderBy(desc(sql`rowid`))
    .limit(20)
    .all()
    .find((m) => /실패|멈춤/.test(m.content));
  const lastSeq = c.db.select({ s: sql<number>`coalesce(max(${events.seq}), 0)` }).from(events).get()?.s ?? 0;
  const lim = c.config.limits;
  const recentUsage = c.db.select({ source: usage.source }).from(usage).where(gte(usage.createdAt, new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString())).all();

  return {
    companyName: c.config.screen.companyName,
    combo: c.config.screen.combo,
    timezone: c.config.schedule.timezone,
    checkTimes: c.config.schedule.checkTimes,
    nextReport: nextCheckTime(c.config, now),
    now: now.toISOString(),
    lastSeq,
    employees: staff,
    tickets: ticketRows.map((t) => withProject(t, byOrder)),
    projects: c.db
      .select()
      .from(projects)
      .all()
      .map((p) => ({ id: p.id, repoUrl: withoutCredentials(p.repoUrl) })),
    orders: [...byOrder.values()].map((o) => ({ id: o.id, projectId: o.projectId, text: o.rawText.replace(/\s+/g, ' ').trim().slice(0, 80), createdAt: o.createdAt })),
    approvals: c.db
      .select()
      .from(approvals)
      .where(eq(approvals.status, 'pending'))
      .all()
      .map((a) => ({ id: a.id, kind: a.kind, targetId: a.targetId, summary: a.summary, reversible: a.reversible, link: approvalLink(c, a.discordMessageId), createdAt: a.createdAt })),
    usage: (['dev', 'research', 'review'] as const).map((b) => {
      const s = budgetStatus(c, b);
      return { budget: b, fiveHour: s.fiveHour.used, fiveHourLimit: s.fiveHour.limit ?? 0, weekly: s.weekly.used, weeklyLimit: s.weekly.limit ?? 0, blockedUntil: s.blockedUntil };
    }),
    estimated: recentUsage.length === 0 || recentUsage.some((u) => u.source === 'estimated'),
    log,
    pushing,
    system: {
      startedAt: extras.startedAt,
      stopped: isStopped(c),
      online: getState(c, 'online', true),
      ceoPresent: isCeoPresent(c),
      loadedModel: lastModel ? String((lastModel.payload as { to?: string }).to ?? '') || null : null,
      lastModelSwitchAt: lastModel?.createdAt ?? null,
      gpu: extras.gpu,
      lastError: lastError ? `${lastError.createdAt.slice(11, 16)} ${lastError.content.slice(0, 120)}` : null,
      account: { claude: getState<ScreenAccountUsage | null>(c, 'account.claude', null) },
      personalReserve: {
        claudeFiveHour: 100 - lim.claude.fiveHour.dev - lim.claude.fiveHour.research,
        claudeWeekly: 100 - lim.claude.weekly.dev - lim.claude.weekly.research,
        gptFiveHour: 100 - lim.gpt.fiveHour.review,
        gptWeekly: 100 - lim.gpt.weekly.review,
      },
    },
  };
}

/** 티켓 상세 (카드를 누르면 열림): 완료 조건 체크리스트, 대화 로그, 회의록, 사용량 */
export function buildTicketDetail(c: Ctx, id: string) {
  const t = c.db.select().from(tickets).where(eq(tickets.id, id)).get();
  if (!t) return null;
  const msgs = c.db.select().from(messages).where(eq(messages.ticketId, id)).orderBy(sql`rowid`).all();
  const lastReview = [...msgs].reverse().find((m) => m.kind === 'review');
  let criteria: { criterion: string; pass: boolean | null; reason?: string }[] = t.acceptanceCriteria.map((criterion) => ({ criterion, pass: null }));
  if (lastReview) {
    try {
      const r = JSON.parse(lastReview.content) as { criteria?: { criterion: string; pass: boolean; reason?: string }[] };
      criteria = t.acceptanceCriteria.map((criterion) => {
        const hit = r.criteria?.find((x) => x.criterion === criterion);
        return hit ? { criterion, pass: hit.pass, ...(hit.reason ? { reason: hit.reason } : {}) } : { criterion, pass: null };
      });
    } catch {
      /* 형식이 다르면 판정 없음으로 둔다 */
    }
  }
  const handoff = [...msgs].reverse().find((m) => m.kind === 'handoff');
  let summary: string | null = null;
  if (handoff) {
    try {
      summary = (JSON.parse(handoff.content.slice(handoff.content.indexOf('{'))) as { summary?: string; document?: string }).summary ?? null;
    } catch {
      summary = handoff.content.slice(0, 200);
    }
  }
  return {
    ticket: withProject(t, orderProjects(c, [t.orderId])),
    acceptanceCriteria: criteria,
    summary,
    log: msgs.map((m) => ({ id: m.id, at: m.createdAt, fromId: m.fromId, toId: m.toId, kind: m.kind, text: m.content.slice(0, 2000) })),
    minutes: c.db.select().from(meetingMinutes).where(eq(meetingMinutes.ticketId, id)).all(),
    usage: { tokens: t.tokensUsed, turns: t.turnsUsed, tokenCap: t.tokenCap, turnCap: t.turnCap },
  };
}
