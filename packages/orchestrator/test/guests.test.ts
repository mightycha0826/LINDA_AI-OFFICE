// 파견 직원: 빌려 온 친구 계정 (8장, 2026-10-21 CEO 결정). 회사 몫과 따로 재고, 70%까지만 쓰고, 검토하지 않는다
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { guestEnv } from '../src/brains/registry.ts';
import { safeEnv } from '../src/brains/process.ts';
import { planOutput } from '../src/brains/mock.ts';
import { recordUsage } from '../src/core/budget.ts';
import { enforceGuests, guestEmployeeId, guestHome, guestUsage, loadGuestRegistry, recordGuestUsage, setGuestOn, syncGuests } from '../src/core/guests.ts';
import { checkPlanRules, fixReviewers } from '../src/core/plans.ts';
import { setState } from '../src/context.ts';
import { employees, tickets, usage } from '../src/db/schema.ts';
import { InteractionHandler } from '../src/discord/interactions.ts';
import { CEO, STRANGER, approvedTickets, setup, type Setup } from './helpers.ts';

type Entry = { id: string; name: string; provider: 'claude' | 'codex'; role?: string; capPct?: number };
function writeRegistry(s: Setup, guests: Entry[], bom = false) {
  mkdirSync(s.config.paths.data, { recursive: true });
  writeFileSync(join(s.config.paths.data, 'guests.json'), (bom ? '﻿' : '') + JSON.stringify({ guests }), 'utf8');
}
const MINSU: Entry = { id: 'minsu', name: '민수', provider: 'claude' };
const GID = guestEmployeeId('minsu');
const emp = (s: Setup, id = GID) => s.db.select().from(employees).where(eq(employees.id, id)).get()!;

/** 민수(Claude 파견)를 출근시키고, 민수가 담당하는 코딩 티켓 하나를 승인까지 */
async function guestTicket(over: Partial<Entry> = {}) {
  const s = setup({ handlers: { plan: () => planOutput({ tickets: [{ title: '로그인 화면', type: 'coding', assignee: GID, reviewer: 'reviewer', acceptanceCriteria: ['테스트 통과'], needsCeoApproval: false, estimatedTokens: 30_000 }] }) } });
  writeRegistry(s, [{ ...MINSU, ...over }]);
  setGuestOn(s.ctx, 'minsu', true, CEO);
  const { tickets: ts } = await approvedTickets(s);
  return { s, ticketId: ts[0]!.id };
}

describe('명단 (data/guests.json, 비밀 값 없음)', () => {
  it('없으면 빈 명단, BOM 허용, ID 형식·중복은 거부', () => {
    const s = setup();
    expect(loadGuestRegistry(s.config.paths.data)).toEqual([]);
    writeRegistry(s, [MINSU], true);
    expect(loadGuestRegistry(s.config.paths.data)[0]).toMatchObject({ id: 'minsu', role: 'developer', capPct: 70 });
    writeRegistry(s, [{ ...MINSU, id: '../evil' }]);
    expect(() => loadGuestRegistry(s.config.paths.data)).toThrow(/형식/);
    writeRegistry(s, [MINSU, MINSU]);
    expect(() => loadGuestRegistry(s.config.paths.data)).toThrow(/두 번/);
  });

  it('로그인 폴더는 코드가 data/guests/<ID>로 정하고, CLAUDE_CONFIG_DIR·CODEX_HOME으로만 넘긴다', () => {
    const s = setup();
    const home = guestHome(s.config.paths.data, 'minsu');
    expect(home).toBe(join(s.config.paths.data, 'guests', 'minsu'));
    expect(guestEnv('claude-code', home)).toEqual({ CLAUDE_CONFIG_DIR: home });
    expect(guestEnv('codex', home)).toEqual({ CODEX_HOME: home });
    expect(safeEnv(guestEnv('claude-code', home)).CLAUDE_CONFIG_DIR).toBe(home); // 비밀 이름으로 막히지 않는다
  });
});

describe('출근·퇴근 (Discord /파견, CEO만)', () => {
  it('새 파견 직원은 퇴근 상태로 들어오고, 주인만 출근시킨다', () => {
    const s = setup();
    writeRegistry(s, [MINSU]);
    syncGuests(s.ctx, loadGuestRegistry(s.config.paths.data));
    const e = emp(s);
    expect(e.leftAt).not.toBeNull();
    expect(e.brain).toEqual({ provider: 'claude-code', budget: 'dev', account: 'minsu' });
    expect(e.department).toBe('파견 라운지');
    expect(() => setGuestOn(s.ctx, 'minsu', true, STRANGER)).toThrow(/CEO/);
    expect(setGuestOn(s.ctx, 'minsu', true, CEO).leftAt).toBeNull();
  });

  it('퇴근한 파견 직원에게는 계획서가 일을 맡기지 못하고, 파견 직원은 검토하지 않는다', () => {
    const s = setup();
    writeRegistry(s, [MINSU]);
    syncGuests(s.ctx, loadGuestRegistry(s.config.paths.data));
    const plan = (assignee: string, reviewer: string) => planOutput({ tickets: [{ title: 'x', type: 'coding', assignee, reviewer, acceptanceCriteria: ['a'], needsCeoApproval: false, estimatedTokens: 1 }] });
    expect(checkPlanRules(s.ctx, plan(GID, 'reviewer')).join()).toContain(GID); // 퇴근 중 = 없는 직원
    setGuestOn(s.ctx, 'minsu', true, CEO);
    expect(checkPlanRules(s.ctx, plan(GID, 'reviewer'))).toEqual([]);
    expect(checkPlanRules(s.ctx, plan('dev-a', GID)).join()).toContain('파견 직원');
    expect(fixReviewers(s.ctx, plan('dev-a', GID)).out.tickets[0]!.reviewer).toBe('developer');
  });

  it('/파견은 CEO만, 버튼으로 출근·퇴근', async () => {
    const s = setup();
    writeRegistry(s, [MINSU]);
    const h = new InteractionHandler(s.ctx, s.engine);
    expect(await h.handle({ type: 'command', userId: STRANGER, name: '파견', options: {} })).toEqual({ kind: 'ignore' });
    const board = await h.handle({ type: 'command', userId: CEO, name: '파견', options: {} });
    expect(board).toMatchObject({ kind: 'reply' });
    expect((board as { content: string }).content).toContain('민수 · 파견');
    await h.handle({ type: 'button', userId: CEO, customId: 'gs:minsu:on' });
    expect(emp(s).leftAt).toBeNull();
    await h.handle({ type: 'button', userId: CEO, customId: 'gs:minsu:off' });
    expect(emp(s).leftAt).not.toBeNull();
  });
});

describe('친구 계정 사용량은 회사 몫과 따로', () => {
  it('파견 직원 호출은 usage 표(회사 몫)에 들어가지 않고 파견 직원 기록에 쌓인다', async () => {
    const { s } = await guestTicket({ provider: 'codex' });
    await s.engine.runUntilIdle();
    const guestCalls = s.mock.calls.filter((c) => c.employee.id === GID);
    expect(guestCalls.length).toBeGreaterThan(0);
    // usage 행은 회사 직원 호출 수와 같다(파견 직원 호출은 한 줄도 없다). Codex 파견의 검토자는 코드가 개발팀장(Claude)으로 바꾼다
    expect(s.db.select().from(usage).all()).toHaveLength(s.mock.calls.filter((c) => c.employee.id !== GID).length);
    expect(s.db.select().from(tickets).all()[0]!.reviewerId).toBe('developer');
    expect(guestUsage(s.ctx, emp(s)).fiveHour).toBeGreaterThan(0);
  });

  it('친구 계정 사용률이 70%에 닿으면 멈추고, 내려가면 이어간다 (Claude는 계정이 알려 준 값)', async () => {
    const { s, ticketId } = await guestTicket();
    recordGuestUsage(s.ctx, emp(s), { account: { fiveHourPct: 70, weeklyPct: 20 }, pct: 0, weeklyPct: 0 });
    enforceGuests(s.ctx);
    expect(s.db.select().from(tickets).where(eq(tickets.id, ticketId)).get()!.status).toBe('paused');
    recordGuestUsage(s.ctx, emp(s), { account: { fiveHourPct: 12, weeklyPct: 20 }, pct: 0, weeklyPct: 0 });
    enforceGuests(s.ctx);
    expect(s.db.select().from(tickets).where(eq(tickets.id, ticketId)).get()!.status).toBe('in_progress');
  });

  it('회사 개발 몫이 바닥나도 파견 직원 티켓은 계속, 퇴근하면 멈춘다', async () => {
    const { s, ticketId } = await guestTicket();
    recordUsage(s.ctx, { budget: 'dev', inputTokens: 1, outputTokens: 1, estimatedPct: 100, estimatedWeeklyPct: 100, source: 'estimated' });
    await s.engine.step();
    expect(['in_progress', 'in_review', 'awaiting_approval', 'done']).toContain(s.db.select().from(tickets).where(eq(tickets.id, ticketId)).get()!.status);
    const s2 = (await guestTicket()).s;
    const t2 = s2.db.select().from(tickets).all()[0]!.id;
    setGuestOn(s2.ctx, 'minsu', false, CEO);
    expect(s2.db.select().from(tickets).where(eq(tickets.id, t2)).get()!.status).toBe('paused');
  });

  it('명단에서 빼면(remove-guest.ps1) 다음 바퀴에 바로 멈추고, 친구 계정 값은 회사 계정 표시에 섞이지 않는다', async () => {
    const { s, ticketId } = await guestTicket();
    setState(s.ctx, 'account.claude', { fiveHourPct: 5, weeklyPct: 5 });
    recordGuestUsage(s.ctx, emp(s), { account: { fiveHourPct: 40, weeklyPct: 40 }, pct: 0, weeklyPct: 0 });
    writeRegistry(s, []);
    enforceGuests(s.ctx);
    expect(s.db.select().from(tickets).where(eq(tickets.id, ticketId)).get()!.status).toBe('paused');
  });
});

describe('주인이 실행하는 스크립트 (키는 AI·Discord를 거치지 않는다)', () => {
  const SCRIPTS = join(import.meta.dirname, '..', '..', '..', 'scripts');
  const read = (f: string) => readFileSync(join(SCRIPTS, f), 'utf8');
  it('add·remove-guest.ps1은 UTF-8 BOM, ID 규칙이 코드와 같고, 로그인은 친구 계정 폴더에서만', () => {
    for (const f of ['add-guest.ps1', 'remove-guest.ps1']) expect([...readFileSync(join(SCRIPTS, f)).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const add = read('add-guest.ps1');
    expect(add).toContain("'^[a-z0-9][a-z0-9-]{1,23}$'");
    expect(add).toContain('$env:CLAUDE_CONFIG_DIR = $guestHome');
    expect(add).toContain('$env:CODEX_HOME = $guestHome');
    expect(add).toContain('Remove-Item Env:\\CLAUDE_CONFIG_DIR');
    expect(add).not.toMatch(/Read-Host|API_?KEY/i); // 키를 받지 않는다(친구가 직접 로그인)
  });
  it('protect-secrets.ps1이 파견 로그인 폴더를 폴더째 막고, unprotect가 되돌린다', () => {
    const p = read('protect-secrets.ps1');
    expect(p).toContain("Join-Path $DataDir 'guests'");
    expect(p).toContain('/deny\', "*${groupSid}:(OI)(CI)(F)"');
    expect(read('unprotect-secrets.ps1')).toContain("Join-Path $DataDir 'guests'");
  });
});
