// 파견 직원: 빌려 온 친구 계정 (8장, 2026-10-21 CEO 결정).
// - 친구가 데스크톱에서 scripts/add-guest.ps1로 자기 Claude·Codex 계정에 로그인한다. 로그인 정보는
//   data/guests/<ID>/ 폴더(CLAUDE_CONFIG_DIR 또는 CODEX_HOME)에만 있고, 회사 파일·Discord·로그에는 남지 않는다.
// - 계정 하나 = 파견 직원 한 명. 처음에는 퇴근 상태이고, 주인이 Discord /파견에서 [출근]·[퇴근]을 누른다.
// - 친구 계정은 사용률 70%(capPct)까지만 쓴다. Claude는 계정이 알려 주는 실제 사용률, Codex는 회사 추정치로 잰다.
// - 회사 몫(개발·기획·GPT)과 섞지 않는다: usage 표에 넣지 않고, 회사 몫이 바닥나도 파견 직원은 일하고, 그 반대도 같다.
// - 파견 직원은 검토하지 않는다(티켓 담당만). 검토는 지금처럼 회사의 다른 모델 직원이 한다.
// - 퇴근·한도 도달이면 그 직원의 티켓을 멈추고(paused budget), 다시 출근·여유가 생기면 이어간다.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Brain } from '@ai-office/shared';
import { getState, inTx, isStopped, nowIso, setState, type Ctx } from '../context.ts';
import { employees, tickets } from '../db/schema.ts';
import { assertCeo, NotFoundError, OfficeError } from '../errors.ts';
import { isGuest, type EmployeeRow } from './budget.ts';
import { applyTicketEvent } from './tickets.ts';

export const GUEST_DEPARTMENT = '파견 라운지';
export const DEFAULT_GUEST_CAP_PCT = 70;
const HOUR = 3_600_000;
const WINDOWS = { fiveHour: 5 * HOUR, weekly: 7 * 24 * HOUR } as const;
/** 파견 직원이 맡을 수 있는 역할 (검토 전담인 리뷰어, 로컬 직원 역할은 없다) */
const GUEST_ROLES = ['developer', 'marketing', 'strategy', 'pm'] as const;

export const GuestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,23}$/, '영문 소문자·숫자·- 2~24자'),
  name: z.string().trim().min(1).max(20),
  provider: z.enum(['claude', 'codex']),
  role: z.enum(GUEST_ROLES).default('developer'),
  capPct: z.number().int().min(1).max(100).default(DEFAULT_GUEST_CAP_PCT),
});
export type Guest = z.infer<typeof GuestSchema>;
const RegistrySchema = z.object({ guests: z.array(GuestSchema).max(10) });

export const guestEmployeeId = (id: string) => `guest-${id}`;
/** 계정 폴더는 코드가 정한다(파일에 적힌 경로는 쓰지 않는다): data/guests/<ID> */
export const guestHome = (dataDir: string, id: string) => join(dataDir, 'guests', id);

/** data/guests.json (add-guest.ps1이 쓴다. 비밀 값은 없다). 없으면 빈 명단, 형식이 틀리면 오류 */
export function loadGuestRegistry(dataDir: string): Guest[] {
  const file = join(dataDir, 'guests.json');
  if (!existsSync(file)) return [];
  const r = RegistrySchema.safeParse(JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')));
  if (!r.success) throw new OfficeError('guest-registry', `guests.json 형식 오류: ${z.prettifyError(r.error)}`);
  const ids = new Set<string>();
  for (const g of r.data.guests) {
    if (ids.has(g.id)) throw new OfficeError('guest-registry', `guests.json에 같은 ID가 두 번 있어요: ${g.id}`);
    ids.add(g.id);
  }
  return r.data.guests;
}

function guestBrain(g: Guest): Brain {
  return g.provider === 'claude' ? { provider: 'claude-code', budget: 'dev', account: g.id } : { provider: 'codex', account: g.id };
}

/**
 * 명단을 직원 표에 맞춘다. 새 파견 직원은 퇴근 상태(leftAt)로 들어온다. 명단에서 빠진 계정은 퇴근시킨다.
 * 이미 있는 파견 직원의 출근·퇴근 상태는 건드리지 않는다.
 */
export function syncGuests(c: Ctx, registry: Guest[]): void {
  inTx(c, (t) => {
    const now = nowIso(t);
    const listed = new Set(registry.map((g) => guestEmployeeId(g.id)));
    registry.forEach((g, i) => {
      const id = guestEmployeeId(g.id);
      const row = { displayName: `${g.name} · 파견`, role: g.role, department: GUEST_DEPARTMENT, brain: guestBrain(g), canSearchWeb: g.role === 'strategy' };
      const existing = t.db.select().from(employees).where(eq(employees.id, id)).get();
      if (existing) t.db.update(employees).set(row).where(eq(employees.id, id)).run();
      else t.db.insert(employees).values({ id, ...row, spriteSet: `temp-${(i % 4) + 1}`, status: 'idle', isTemporary: false, leftAt: now }).run();
    });
    for (const e of t.db.select().from(employees).all()) {
      if (isGuest(e) && !listed.has(e.id) && !e.leftAt) {
        t.db.update(employees).set({ leftAt: now }).where(eq(employees.id, e.id)).run();
        pauseGuestTickets(t, e.id);
      }
    }
  });
}

export const guestAccountOf = (e: EmployeeRow): string | null => (isGuest(e) ? ((e.brain as { account?: string }).account ?? null) : null);
export const isGuestOn = (e: EmployeeRow) => isGuest(e) && !e.leftAt;

/** 친구 계정 사용률 (%). Claude는 계정이 알려 준 값, Codex는 회사 추정치의 합 */
export interface GuestUsage {
  fiveHour: number;
  weekly: number;
  source: 'reported' | 'estimated';
  blockedUntil: string | null;
}
interface EstimateRow {
  at: string;
  pct: number;
  weeklyPct: number;
}
const accountKey = (id: string) => `account.guest.${id}`;
const estimateKey = (id: string) => `guest.estimates.${id}`;
const blockKey = (id: string) => `guest.blocked.${id}`;

export function guestUsage(c: Ctx, e: EmployeeRow): GuestUsage {
  const id = guestAccountOf(e)!;
  const until = getState<string | null>(c, blockKey(id), null);
  const blockedUntil = until && new Date(until).getTime() > c.clock.now().getTime() ? until : null;
  if (e.brain.provider === 'claude-code') {
    const a = getState<{ fiveHourPct: number | null; weeklyPct: number | null } | null>(c, accountKey(id), null);
    return { fiveHour: a?.fiveHourPct ?? 0, weekly: a?.weeklyPct ?? 0, source: 'reported', blockedUntil };
  }
  const now = c.clock.now().getTime();
  const rows = getState<EstimateRow[]>(c, estimateKey(id), []);
  const sum = (ms: number, k: 'pct' | 'weeklyPct') => rows.filter((r) => now - new Date(r.at).getTime() <= ms).reduce((s, r) => s + r[k], 0);
  return { fiveHour: sum(WINDOWS.fiveHour, 'pct'), weekly: sum(WINDOWS.weekly, 'weeklyPct'), source: 'estimated', blockedUntil };
}

/** 명단의 한도(%). 명단에서 빠졌으면 null (remove-guest.ps1 직후 바로 멈추게) */
export function guestCap(c: Ctx, e: EmployeeRow): number | null {
  const id = guestAccountOf(e);
  return loadGuestRegistrySafe(c).find((x) => x.id === id)?.capPct ?? null;
}
function loadGuestRegistrySafe(c: Ctx): Guest[] {
  try {
    return loadGuestRegistry(c.config.paths.data);
  } catch {
    return [];
  }
}

/** 한도(capPct)에 닿았거나 제공자가 막았는가 */
export function guestExhausted(c: Ctx, e: EmployeeRow): boolean {
  const cap = guestCap(c, e);
  if (cap === null) return true;
  const u = guestUsage(c, e);
  return u.fiveHour >= cap || u.weekly >= cap || !!u.blockedUntil;
}

/** 호출 1회 뒤 사용량 기록. account가 오면(Claude) 그 값, 아니면 추정치를 쌓는다(7일 지난 것은 버림) */
export function recordGuestUsage(c: Ctx, e: EmployeeRow, u: { account?: { fiveHourPct: number | null; weeklyPct: number | null } | null; pct: number; weeklyPct: number }): void {
  const id = guestAccountOf(e);
  if (!id) return;
  if (u.account) {
    setState(c, accountKey(id), { ...u.account, at: nowIso(c) });
    return;
  }
  const now = c.clock.now().getTime();
  const rows = getState<EstimateRow[]>(c, estimateKey(id), []).filter((r) => now - new Date(r.at).getTime() <= WINDOWS.weekly);
  setState(c, estimateKey(id), [...rows, { at: nowIso(c), pct: u.pct, weeklyPct: u.weeklyPct }]);
}

/** 제공자가 한도 도달을 알려 왔다 (회사 몫은 막지 않는다) */
export function blockGuest(c: Ctx, e: EmployeeRow, resetsAt?: string): void {
  const id = guestAccountOf(e);
  if (!id) return;
  const fallback = new Date(c.clock.now().getTime() + HOUR).toISOString();
  setState(c, blockKey(id), resetsAt && new Date(resetsAt).getTime() > c.clock.now().getTime() ? resetsAt : fallback);
}

const SPENDING = ['in_progress', 'rework', 'meeting'] as const;

function pauseGuestTickets(c: Ctx, employeeId: string): string[] {
  const active = c.db.select().from(tickets).where(and(eq(tickets.assigneeId, employeeId), inArray(tickets.status, [...SPENDING]))).all();
  for (const tk of active) applyTicketEvent(c, tk.id, { type: 'system.pause', reason: 'budget' }, { kind: 'orchestrator' });
  return active.map((t) => t.id);
}

/**
 * 파견 직원 티켓을 멈추거나 이어간다 (엔진이 바퀴마다 부른다).
 * 퇴근·한도 도달이면 멈추고, 출근 중이고 여유가 있으면 budget으로 멈춘 티켓을 이어간다.
 */
export function enforceGuests(c: Ctx): { paused: string[]; resumed: string[] } {
  return inTx(c, (t) => {
    const paused: string[] = [];
    const resumed: string[] = [];
    for (const e of t.db.select().from(employees).all()) {
      if (!isGuest(e)) continue;
      if (!isGuestOn(e) || guestExhausted(t, e)) {
        paused.push(...pauseGuestTickets(t, e.id));
      } else if (!isStopped(t)) {
        const waiting = t.db.select().from(tickets).where(and(eq(tickets.assigneeId, e.id), eq(tickets.status, 'paused'), eq(tickets.pauseReason, 'budget'))).all();
        for (const tk of waiting) {
          applyTicketEvent(t, tk.id, { type: 'system.resume', cause: 'budget-refilled' }, { kind: 'orchestrator' });
          resumed.push(tk.id);
        }
      }
    }
    return { paused, resumed };
  });
}

/** [출근]·[퇴근] (Discord /파견, CEO만). 명단에 없는 계정은 출근시킬 수 없다 */
export function setGuestOn(c: Ctx, guestId: string, on: boolean, discordUserId: string): EmployeeRow {
  assertCeo(c.config, discordUserId);
  const registry = loadGuestRegistry(c.config.paths.data);
  syncGuests(c, registry);
  return inTx(c, (t) => {
    const e = t.db.select().from(employees).where(eq(employees.id, guestEmployeeId(guestId))).get();
    if (!e || !isGuest(e)) throw new NotFoundError(`파견 직원 ${guestId}`);
    if (on && !registry.some((g) => g.id === guestId)) throw new OfficeError('guest-removed', '명단에서 빠진 계정이에요. add-guest.ps1로 다시 넣어 주세요');
    t.db.update(employees).set({ leftAt: on ? null : nowIso(t) }).where(eq(employees.id, e.id)).run();
    if (!on) pauseGuestTickets(t, e.id);
    return t.db.select().from(employees).where(eq(employees.id, e.id)).get()!;
  });
}

/** /파견 목록 한 줄 */
export function guestLine(c: Ctx, e: EmployeeRow): string {
  const u = guestUsage(c, e);
  const cap = guestCap(c, e);
  const kind = e.brain.provider === 'claude-code' ? 'Claude' : 'Codex';
  const state = !isGuestOn(e) ? '퇴근' : guestExhausted(c, e) ? '한도 도달로 쉬는 중' : '출근';
  const fmt = (n: number) => `${Math.round(n)}%`;
  return `**${e.displayName}** (${kind}, ${e.role}) · ${state} · 5시간 ${fmt(u.fiveHour)} · 주간 ${fmt(u.weekly)} / 한도 ${cap ?? '-'}%${u.source === 'estimated' ? ' (추정)' : ''}`;
}
