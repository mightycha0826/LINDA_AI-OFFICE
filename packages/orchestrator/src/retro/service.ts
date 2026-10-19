// 회고와 학습 (14장). 오케스트레이터가 주기적으로 tick()을 부른다.
// 1. 티켓 회고: 반려가 한 번이라도 있었던 티켓이 끝나면 회고 작성자(로컬 Gemma)가 쓰고 확인자(GPT 리뷰어)가 확인한다.
// 2. 자동 트리거: 같은 분류 반려가 3번 쌓이면 회고 작성자가 규칙 후보를 쓴다.
// 3. 주간 회고: 일요일 22:00. 반려 통계와 규칙 효과를 코드가 집계하고 회고 작성자가 요약과 후보를 쓴다.
//    (7-1: PM이 Claude가 되어 회고 초안은 Claude 한도를 쓰지 않게 로컬로 옮겼다. 회고 서기(7-5)가 생기면 그쪽으로)
//    효과 없는 규칙과 역할당 10개 초과는 코드가 삭제 제안을 올린다.
// 4. 후보는 코드 사전 검사 → GPT 관문 → #결재함 "규칙 추가 제안". 승인돼야 적용된다.
import { and, desc, eq, gt, gte, inArray, sql } from 'drizzle-orm';
import {
  GateOutputSchema,
  REASON_CATEGORIES,
  RetroCheckSchema,
  RuleCandidateSchema,
  TicketRetroSchema,
  WeeklyRetroSchema,
  type ReasonCategory,
  type RuleCandidate,
} from '@ai-office/shared';
import { getState, inTx, newId, nowIso, setState, type Ctx } from '../context.ts';
import { recordMessage } from '../core/guards.ts';
import { messages, retros, rules, tickets } from '../db/schema.ts';
import { localTime } from '../discord/schedule.ts';
import type { Engine } from '../engine.ts';
import { OfficeError } from '../errors.ts';
import { cleanupCandidates, countRecurrences, isIneffective, proposeRetire, proposeRule, ruleViolations } from './rules.ts';

/** 회고 초안을 쓰는 직원과 확인하는 직원: 서로 다른 모델 (14장). 7-1에는 교정 담당, 7-5부터 회고 서기(로컬 보조 직원) */
export const RETRO_WRITER = 'retro-scribe';
export const RETRO_CHECKER = 'reviewer';

const CURSOR = 'retro.cursor';
const QUEUE = 'retro.queue';
const REVISED = 'retro.revised';
const triggerKey = (cat: ReasonCategory) => `retro.trigger.${cat}`;
/** 주간 회고를 PM 없이 통계만으로 쓰기까지 기다리는 시간 */
const WEEKLY_GRACE_MIN = 120;

export interface QueuedCandidate {
  candidate: RuleCandidate;
  source: 'auto' | 'weekly' | 'revision';
}

interface ReviewRecord {
  verdict: string | null;
  reasonCategory: string | null;
  reasons: string[];
  at: string;
}

function parseReview(content: string): string[] {
  try {
    const j = JSON.parse(content.slice(Math.max(content.indexOf('{'), 0))) as { criteria?: { criterion: string; pass: boolean; reason?: string }[]; fixRequests?: string[] };
    const failed = (j.criteria ?? []).filter((c) => !c.pass).map((c) => `${c.criterion}: ${c.reason ?? ''}`);
    return failed.length ? failed : (j.fixRequests ?? []);
  } catch {
    return [content.slice(0, 300)];
  }
}

export class RetroService {
  private readonly c: Ctx;
  private readonly engine: Engine;
  private readonly log: (s: string) => void;

  constructor(c: Ctx, engine: Engine, log: (s: string) => void = () => {}) {
    this.c = c;
    this.engine = engine;
    this.log = log;
  }

  /** 한 바퀴. 한 일의 수를 돌려준다 */
  async tick(): Promise<number> {
    let n = 0;
    setState(this.c, CURSOR, countRecurrences(this.c, getState<number>(this.c, CURSOR, 0)));
    n += await this.ticketRetros();
    n += await this.revisions();
    n += await this.autoTriggers();
    n += await this.weekly();
    n += await this.processQueue();
    return n;
  }

  // --- 1. 티켓 회고 ---------------------------------------------------------------

  private reviewsOf(ticketId: string): ReviewRecord[] {
    return this.c.db
      .select()
      .from(messages)
      .where(and(eq(messages.ticketId, ticketId), eq(messages.kind, 'review')))
      .orderBy(sql`rowid`)
      .all()
      .map((m) => ({ verdict: m.reviewVerdict, reasonCategory: m.reasonCategory, reasons: parseReview(m.content), at: m.createdAt }));
  }

  /** 반려가 있었는데 회고가 없는 완료 티켓 */
  pendingTicketRetros(limit = 3) {
    const failed = this.c.db
      .selectDistinct({ id: messages.ticketId })
      .from(messages)
      .where(and(eq(messages.kind, 'review'), eq(messages.reviewVerdict, 'fail')))
      .all()
      .map((r) => r.id)
      .filter((x): x is string => !!x);
    if (failed.length === 0) return [];
    const done = this.c.db.select().from(tickets).where(and(eq(tickets.status, 'done'), inArray(tickets.id, failed))).all();
    const have = new Set(
      this.c.db
        .select({ t: retros.ticketId })
        .from(retros)
        .where(eq(retros.kind, 'ticket'))
        .all()
        .map((r) => r.t),
    );
    return done.filter((t) => !have.has(t.id)).slice(0, limit);
  }

  private async ticketRetros(): Promise<number> {
    let n = 0;
    for (const tk of this.pendingTicketRetros()) {
      const ticket = { id: tk.id, title: tk.title, type: tk.type, acceptanceCriteria: tk.acceptanceCriteria };
      const reviews = this.reviewsOf(tk.id);
      const retro = await this.engine.callAs(RETRO_WRITER, 'retro', TicketRetroSchema, { mode: 'ticket', ticket, reviews }, { workdir: 'retro' });
      if (!retro) break; // PM을 부를 수 없음: 다음 바퀴에
      const check = await this.engine.callAs(RETRO_CHECKER, 'retro', RetroCheckSchema, { mode: 'check', ticket, reviews, retro }, { workdir: 'retro' });
      inTx(this.c, (t) => {
        t.db
          .insert(retros)
          .values({ id: newId(), kind: 'ticket', ticketId: tk.id, whatWrong: retro.whatWrong, why: retro.why, preventAt: retro.preventAt, confirmed: check ? check.confirmed : null, checkNote: check?.note || null, createdAt: nowIso(t) })
          .onConflictDoNothing()
          .run();
        recordMessage(t, {
          ticketId: tk.id,
          fromId: RETRO_WRITER,
          kind: 'system',
          content: `티켓 회고: ${retro.whatWrong} / 원인: ${retro.why} / 막을 단계: ${retro.preventAt}${check ? (check.confirmed ? ' (리뷰어 확인)' : ` (리뷰어 이견: ${check.note})`) : ''}`,
          countsForPingpong: false,
        });
      });
      n++;
    }
    return n;
  }

  // --- 2. 자동 트리거와 CEO 수정 요청 ----------------------------------------------

  /** 같은 분류 반려 중 아직 후보로 다루지 않은 것 */
  failsSince(cat: ReasonCategory) {
    const since = getState<string>(this.c, triggerKey(cat), '');
    return this.c.db
      .select()
      .from(messages)
      .where(and(eq(messages.kind, 'review'), eq(messages.reviewVerdict, 'fail'), eq(messages.reasonCategory, cat), gt(messages.createdAt, since)))
      .orderBy(messages.createdAt)
      .all();
  }

  private evidenceFor(ticketIds: string[]) {
    return ticketIds.map((id) => {
      const tk = this.c.db.select().from(tickets).where(eq(tickets.id, id)).get();
      const retro = this.c.db.select().from(retros).where(and(eq(retros.kind, 'ticket'), eq(retros.ticketId, id))).get();
      return {
        ticketId: id,
        title: tk?.title ?? '',
        type: tk?.type ?? null,
        assignee: tk?.assigneeId ?? null,
        reasons: this.reviewsOf(id)
          .filter((r) => r.verdict === 'fail')
          .flatMap((r) => r.reasons)
          .slice(0, 5),
        retro: retro ? { whatWrong: retro.whatWrong, why: retro.why, preventAt: retro.preventAt } : null,
      };
    });
  }

  private async autoTriggers(): Promise<number> {
    let n = 0;
    for (const cat of REASON_CATEGORIES) {
      const fails = this.failsSince(cat);
      if (fails.length < this.c.config.retro.autoTriggerCount) continue;
      const ids = [...new Set(fails.map((f) => f.ticketId).filter((x): x is string => !!x))].slice(-5);
      const evidence = this.evidenceFor(ids);
      const cand = await this.engine.callAs(RETRO_WRITER, 'retro', RuleCandidateSchema, { mode: 'rule', reasonCategory: cat, evidence }, { workdir: 'retro' });
      if (!cand) break;
      setState(this.c, triggerKey(cat), fails.at(-1)!.createdAt);
      this.enqueue({ candidate: { ...cand, reasonCategory: cat }, source: 'auto' });
      n++;
    }
    return n;
  }

  /** CEO가 [수정]을 누른 후보는 메모를 붙여 PM이 다시 쓴다 */
  private async revisions(): Promise<number> {
    const done = new Set(getState<string[]>(this.c, REVISED, []));
    const todo = this.c.db
      .select()
      .from(rules)
      .where(eq(rules.status, 'retired'))
      .all()
      .filter((r) => r.retiredReason?.startsWith('수정 요청:') && !done.has(r.id));
    let n = 0;
    for (const r of todo) {
      const cand = await this.engine.callAs(
        RETRO_WRITER,
        'retro',
        RuleCandidateSchema,
        { mode: 'rule', reasonCategory: r.reasonCategory, evidence: this.evidenceFor(r.evidence), ceoNote: r.retiredReason!.slice('수정 요청:'.length).trim(), previous: { scope: r.scope, rule: r.text } },
        { workdir: 'retro' },
      );
      if (!cand) break;
      done.add(r.id);
      setState(this.c, REVISED, [...done]);
      this.enqueue({ candidate: { ...cand, reasonCategory: r.reasonCategory }, source: 'revision' });
      n++;
    }
    return n;
  }

  // --- 3. 주간 회고 --------------------------------------------------------------

  /** 가장 최근 주간 회고 시각이 지났는지, 그 주 열쇠(그날 날짜)와 지난 분 */
  weeklySlot(now = this.c.clock.now()): { week: string; minutesSince: number; since: string } {
    const { weeklyDay, weeklyTime } = this.c.config.retro;
    const lt = localTime(now, this.c.config.schedule.timezone);
    const dow = new Date(`${lt.date}T00:00:00Z`).getUTCDay();
    const slotMin = Number(weeklyTime.slice(0, 2)) * 60 + Number(weeklyTime.slice(3, 5));
    let back = (dow - weeklyDay + 7) % 7;
    if (back === 0 && lt.minutes < slotMin) back = 7;
    const day = new Date(`${lt.date}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - back);
    const minutesSince = back * 1440 + (lt.minutes - slotMin);
    const since = new Date(now.getTime() - (minutesSince + 7 * 1440) * 60_000).toISOString();
    return { week: day.toISOString().slice(0, 10), minutesSince, since };
  }

  /** 지난 7일 반려 통계와 규칙 효과 (코드 집계) */
  weeklyStats(since: string) {
    const fails = this.c.db
      .select()
      .from(messages)
      .where(and(eq(messages.kind, 'review'), eq(messages.reviewVerdict, 'fail'), gte(messages.createdAt, since)))
      .all();
    const byCategory: Record<string, number> = {};
    const byAssignee: Record<string, number> = {};
    for (const f of fails) {
      if (f.reasonCategory) byCategory[f.reasonCategory] = (byCategory[f.reasonCategory] ?? 0) + 1;
      if (f.toId) byAssignee[f.toId] = (byAssignee[f.toId] ?? 0) + 1;
    }
    const doneCount = this.c.db.select({ n: sql<number>`count(*)` }).from(tickets).where(and(eq(tickets.status, 'done'), gte(tickets.finishedAt, since))).get()?.n ?? 0;
    const active = this.c.db.select().from(rules).where(eq(rules.status, 'active')).all();
    return {
      since,
      doneTickets: doneCount,
      rejections: fails.length,
      byCategory,
      byAssignee,
      rules: active.map((r) => ({ id: r.id, text: r.text, scope: r.scope, applied: r.appliedCount, recurrence: r.recurrenceCount, baselineRate: r.baselineRate, ineffective: isIneffective(r) })),
    };
  }

  private async weekly(): Promise<number> {
    const slot = this.weeklySlot();
    // 지난 주를 뒤늦게 채우지는 않는다 (처음 켰을 때 빈 회고가 올라가지 않게)
    if (slot.minutesSince < 0 || slot.minutesSince > 24 * 60) return 0;
    const exists = this.c.db.select().from(retros).where(and(eq(retros.kind, 'weekly'), eq(retros.week, slot.week))).get();
    if (exists) return 0;
    const stats = this.weeklyStats(slot.since);
    const weekRetros = this.c.db
      .select()
      .from(retros)
      .where(and(eq(retros.kind, 'ticket'), gte(retros.createdAt, slot.since)))
      .all()
      .map((r) => ({ ticketId: r.ticketId, whatWrong: r.whatWrong, why: r.why, preventAt: r.preventAt }));
    const out = await this.engine.callAs(RETRO_WRITER, 'retro', WeeklyRetroSchema, { mode: 'weekly', stats, retros: weekRetros }, { workdir: 'retro' });
    if (!out && slot.minutesSince < WEEKLY_GRACE_MIN) return 0; // 잠시 뒤 다시
    const summary = out?.summary ?? `(PM 회고 없이 통계만) 반려 ${stats.rejections}건, 완료 ${stats.doneTickets}건`;
    inTx(this.c, (t) => {
      t.db.insert(retros).values({ id: newId(), kind: 'weekly', week: slot.week, summary, stats, createdAt: nowIso(t) }).onConflictDoNothing().run();
    });
    for (const cand of out?.candidates ?? []) this.enqueue({ candidate: cand, source: 'weekly' });
    // 효과 없음, 10개 초과 정리: 코드가 고르고 CEO가 결재한다
    for (const r of this.c.db.select().from(rules).where(eq(rules.status, 'active')).all()) {
      if (isIneffective(r)) proposeRetire(this.c, r.id, `효과 없음(적용 ${r.appliedCount}번에도 재발이 줄지 않음), 삭제 또는 수정 제안`);
    }
    for (const r of cleanupCandidates(this.c)) proposeRetire(this.c, r.id, '역할당 10개 초과, 정리 제안');
    return 1;
  }

  /** 정기 보고에 붙일 최근 주간 회고 (하루 안에 쓴 것) */
  latestWeekly() {
    const since = new Date(this.c.clock.now().getTime() - 24 * 3_600_000).toISOString();
    return this.c.db.select().from(retros).where(and(eq(retros.kind, 'weekly'), gte(retros.createdAt, since))).orderBy(desc(retros.createdAt)).get() ?? null;
  }

  // --- 4. 후보 → 관문 → 결재 ---------------------------------------------------------

  enqueue(q: QueuedCandidate): void {
    setState(this.c, QUEUE, [...getState<QueuedCandidate[]>(this.c, QUEUE, []), q]);
  }

  queue(): QueuedCandidate[] {
    return getState<QueuedCandidate[]>(this.c, QUEUE, []);
  }

  private drop(q: QueuedCandidate, why: string): void {
    setState(this.c, QUEUE, this.queue().slice(1));
    recordMessage(this.c, { fromId: 'orchestrator', kind: 'system', content: `규칙 후보를 올리지 않았어요(${why}): ${q.candidate.rule}`, countsForPingpong: false });
    this.log(`규칙 후보 버림(${why}): ${q.candidate.rule}`);
  }

  private async processQueue(): Promise<number> {
    let n = 0;
    for (let q = this.queue()[0]; q; q = this.queue()[0]) {
      const bad = ruleViolations(q.candidate.rule);
      if (bad.length) {
        this.drop(q, `금지 내용: ${bad.join(', ')}`);
        n++;
        continue;
      }
      const evidence = q.candidate.evidence.filter((id) => this.c.db.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, id)).get());
      if (evidence.length === 0) {
        this.drop(q, '근거 티켓 없음');
        n++;
        continue;
      }
      const cand: RuleCandidate = { ...q.candidate, evidence };
      const gate = await this.engine.callAs('reviewer', 'gate', GateOutputSchema, { rule: cand, evidence: this.evidenceFor(evidence) }, { workdir: 'gate-rule' });
      if (!gate) break; // GPT 한도·연결 문제: 기다린다
      if (!gate.passed) {
        this.drop(q, `GPT 관문 반려: ${gate.issues.join('; ') || '이유 없음'}`);
        n++;
        continue;
      }
      try {
        proposeRule(this.c, cand, q.source);
        setState(this.c, QUEUE, this.queue().slice(1));
      } catch (err) {
        if (!(err instanceof OfficeError)) throw err;
        this.drop(q, err.message);
      }
      n++;
    }
    return n;
  }
}

