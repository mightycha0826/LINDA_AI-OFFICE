// 사용량 한도 칸막이 (DESIGN.md 8장).
// - 몫끼리 빌려 쓰지 않는다. 각 몫은 자기 사용량만 본다.
// - 개발 몫 소진: 개발 티켓을 paused(budget). 다시 차면 이어간다.
// - 리서치 몫 소진: 로컬 모델로 바꿔서 계속하고 "저정밀 모드" 표시.
// - GPT 소진: 리뷰와 관문 검사가 멈춘다. 티켓은 in_review에서 그대로 기다린다.
// - 임시 직원이 Claude를 쓰면 개발 몫에서 가져간다.
import { and, eq, gte, inArray, sum } from 'drizzle-orm';
import type { UsageBudget, UsageProvider, UsageSource } from '@ai-office/shared';
import { emit, getState, inTx, isStopped, newId, nowIso, setState, type Ctx } from '../context.ts';
import { employees, tickets, usage } from '../db/schema.ts';
import { applyTicketEvent } from './tickets.ts';
import { quotaResetAt } from './quota-window.ts';

export type EmployeeRow = typeof employees.$inferSelect;
type LimitedBudget = Exclude<UsageBudget, 'local'>;

const HOUR = 3_600_000;
const WINDOWS = { fiveHour: 5 * HOUR, weekly: 7 * 24 * HOUR } as const;

/** 파견 직원(빌려 온 친구 계정, core/guests.ts): 회사 몫을 쓰지 않는다 */
export function isGuest(e: EmployeeRow): boolean {
  return (e.brain.provider === 'claude-code' || e.brain.provider === 'codex') && !!e.brain.account;
}

/** 이 직원이 AI를 부를 때 깎이는 몫. Git 고양이처럼 AI가 아니면 null. 파견 직원은 회사 몫이 아니다(core/guests.ts가 따로 잰다) */
export function budgetOf(e: EmployeeRow): UsageBudget | null {
  switch (e.brain.provider) {
    case 'claude-code':
      return e.isTemporary ? 'dev' : e.brain.budget;
    case 'codex':
      return 'review';
    case 'ollama':
      return 'local';
    case 'none':
      return null;
  }
}

export function providerOf(b: UsageBudget): UsageProvider {
  return b === 'dev' || b === 'research' ? 'claude' : b === 'review' ? 'gpt' : 'ollama';
}

export function limitOf(c: Ctx, b: LimitedBudget, window: keyof typeof WINDOWS): number {
  const l = c.config.limits;
  if (b === 'review') return l.gpt[window].review;
  return l.claude[window][b];
}

export function usedPct(c: Ctx, b: UsageBudget, window: keyof typeof WINDOWS): number {
  const provider = b === 'local' ? null : providerOf(b) as 'claude' | 'gpt';
  const reset = provider ? quotaResetAt(c,provider,window) : 0;
  const since = new Date(Math.max(c.clock.now().getTime() - WINDOWS[window],reset)).toISOString();
  const row = c.db
    .select({ total: sum(window === 'fiveHour' ? usage.estimatedPct : usage.estimatedWeeklyPct) })
    .from(usage)
    .where(and(eq(usage.budget, b), gte(usage.createdAt, since)))
    .get();
  return Number(row?.total ?? 0);
}

export interface BudgetStatus {
  budget: UsageBudget;
  fiveHour: { used: number; limit: number | null };
  weekly: { used: number; limit: number | null };
  exhausted: boolean;
  /** 제공자가 "한도 도달"을 알려 와서 막아 둔 경우, 풀리는 시각 */
  blockedUntil: string | null;
}

const blockKey = (b: UsageBudget) => `budgetBlocked:${b}`;
/** 초기화 시각을 모를 때 막아 두는 시간 */
const DEFAULT_BLOCK_MS = HOUR;

/**
 * 제공자가 한도 도달을 알려 왔다. 우리 추정치와 상관없이 그 몫을 막는다.
 * 추정 계수가 틀려도 실제 한도를 넘겨 계속 부르지 않게 하기 위해서다.
 */
export function blockBudget(c: Ctx, b: UsageBudget, resetsAt?: string): string {
  const fallback = new Date(c.clock.now().getTime() + (c.config.usagePolicy.enforceEstimates ? DEFAULT_BLOCK_MS : 30 * 60_000)).toISOString();
  const until = resetsAt && new Date(resetsAt).getTime() > c.clock.now().getTime() ? resetsAt : fallback;
  setState(c, blockKey(b), until);
  emit(c, 'usage.updated', { budget: b, blockedUntil: until, reason: 'provider-limit' });
  return until;
}

export function budgetStatus(c: Ctx, b: UsageBudget): BudgetStatus {
  const five = usedPct(c, b, 'fiveHour');
  const week = usedPct(c, b, 'weekly');
  if (b === 'local') return { budget: b, fiveHour: { used: five, limit: null }, weekly: { used: week, limit: null }, exhausted: false, blockedUntil: null };
  const l5 = limitOf(c, b, 'fiveHour');
  const lw = limitOf(c, b, 'weekly');
  const until = getState<string | null>(c, blockKey(b), null);
  const blockedUntil = until && new Date(until).getTime() > c.clock.now().getTime() ? until : null;
  if (!c.config.usagePolicy.enforceEstimates) return { budget:b, fiveHour:{used:five,limit:null}, weekly:{used:week,limit:null}, exhausted:!!blockedUntil, blockedUntil };
  return { budget: b, fiveHour: { used: five, limit: l5 }, weekly: { used: week, limit: lw }, exhausted: five >= l5 || week >= lw || !!blockedUntil, blockedUntil };
}

export function isExhausted(c: Ctx, b: UsageBudget): boolean {
  return budgetStatus(c, b).exhausted;
}

/** 파견 직원 ID 모음 */
function guestIdSet(c: Ctx): Set<string> {
  return new Set(c.db.select().from(employees).all().filter(isGuest).map((e) => e.id));
}

export interface UsageInput {
  budget: UsageBudget;
  ticketId?: string;
  inputTokens: number;
  outputTokens: number;
  /** 5시간 한도 대비 % */
  estimatedPct: number;
  /** 주간 한도 대비 % */
  estimatedWeeklyPct: number;
  source: UsageSource;
}

/** 호출 1회당 1행 (4장 usage). */
export function recordUsage(c: Ctx, u: UsageInput): void {
  inTx(c, (t) => {
    t.db
      .insert(usage)
      .values({
        id: newId(),
        provider: providerOf(u.budget),
        budget: u.budget,
        ticketId: u.ticketId ?? null,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        estimatedPct: u.estimatedPct,
        estimatedWeeklyPct: u.estimatedWeeklyPct,
        source: u.source,
        createdAt: nowIso(t),
      })
      .run();
    emit(t, 'usage.updated', { budget: u.budget, estimatedPct: u.estimatedPct, estimatedWeeklyPct: u.estimatedWeeklyPct, source: u.source, ticketId: u.ticketId ?? null });
  });
}

/** 개발 몫을 쓰는 단계에 있는 티켓 상태. in_review는 GPT를 쓰므로 빠진다. */
const DEV_SPENDING: ('in_progress' | 'rework' | 'meeting')[] = ['in_progress', 'rework', 'meeting'];

/**
 * 몫 상태에 맞춰 티켓을 멈추거나 이어간다. 정기적으로, 그리고 사용량을 기록한 뒤 부른다.
 * 개발 몫만 티켓을 멈춘다. 리서치는 로컬로 바꾸고, GPT는 검토 단계에서 기다린다.
 */
export function enforceBudgets(c: Ctx): { paused: string[]; resumed: string[] } {
  return inTx(c, (t) => {
    const paused: string[] = [];
    const resumed: string[] = [];
    if (!t.config.usagePolicy.enforceEstimates) {
      const staff=new Map(t.db.select().from(employees).all().map(e=>[e.id,e]));
      const actorOf=(tk: typeof tickets.$inferSelect) => staff.get((tk.status==='in_review'||tk.pausedFrom==='in_review')?tk.reviewerId:tk.assigneeId);
      const all=t.db.select().from(tickets).all();
      for(const tk of all) {
        const actor=actorOf(tk);
        if(!actor || isGuest(actor)) continue;
        const budget=budgetOf(actor);
        const blocked=budget && isExhausted(t,budget);
        if (blocked && ['in_progress','rework','meeting','in_review'].includes(tk.status)) {
          applyTicketEvent(t,tk.id,{type:'system.pause',reason:'budget'},{kind:'orchestrator'}); paused.push(tk.id);
        } else if (!blocked && tk.status==='paused' && tk.pauseReason==='budget' && !isStopped(t)) {
          applyTicketEvent(t,tk.id,{type:'system.resume',cause:'budget-refilled'},{kind:'orchestrator'}); resumed.push(tk.id);
        }
      }
      return {paused,resumed};
    }
    const devIds = t.db
      .select()
      .from(employees)
      .all()
      .filter((e) => budgetOf(e) === 'dev' && !isGuest(e))
      .map((e) => e.id);
    if (devIds.length === 0) return { paused, resumed };
    const orchestrator = { kind: 'orchestrator' } as const;

    if (isExhausted(t, 'dev')) {
      const active = t.db.select().from(tickets).where(and(inArray(tickets.assigneeId, devIds), inArray(tickets.status, DEV_SPENDING))).all();
      for (const tk of active) {
        applyTicketEvent(t, tk.id, { type: 'system.pause', reason: 'budget' }, orchestrator);
        paused.push(tk.id);
      }
    } else if (!isStopped(t)) {
      // 파견 직원 티켓은 enforceGuests가 맡는다 (퇴근·친구 계정 한도)
      const waiting = t.db
        .select()
        .from(tickets)
        .where(and(eq(tickets.status, 'paused'), eq(tickets.pauseReason, 'budget')))
        .all()
        .filter((tk) => !guestIdSet(t).has(tk.assigneeId));
      for (const tk of waiting) {
        const worker=t.db.select().from(employees).where(eq(employees.id,tk.pausedFrom==='in_review'?tk.reviewerId:tk.assigneeId)).get();
        const budget=worker?budgetOf(worker):null;
        if (budget && isExhausted(t,budget)) continue;
        applyTicketEvent(t, tk.id, { type: 'system.resume', cause: 'budget-refilled' }, orchestrator);
        resumed.push(tk.id);
      }
    }
    return { paused, resumed };
  });
}
