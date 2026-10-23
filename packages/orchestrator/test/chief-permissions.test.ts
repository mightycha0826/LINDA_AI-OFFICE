// 비서실장 권한 넓히기 (6·7장, 2026-10-22 CEO 결정): 읽기 도구, 확인 버튼 요청, 비상 정지(멈춤만).
// 결재·PM 질문 답변·/재개는 사장님이 직접 한다. 비서실장에게 그런 길이 없음을 코드로 확인한다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { chiefRequestOf } from '../src/chief/requests.ts';
import { ChiefTools } from '../src/chief/tools.ts';
import { TOOL_NAMES } from '../src/chief/tool-defs.ts';
import { getState, isStopped, setState } from '../src/context.ts';
import { resumeAll } from '../src/core/stop.ts';
import { guestEmployeeId, setGuestOn, syncGuests, loadGuestRegistry } from '../src/core/guests.ts';
import { employees, orders, tickets } from '../src/db/schema.ts';
import { InteractionHandler } from '../src/discord/interactions.ts';
import { Notifier } from '../src/discord/notifier.ts';
import { planBlockedKey } from '../src/engine/planning.ts';
import { NotCeoError } from '../src/errors.ts';
import { FakeDiscord } from './fakes/fake-discord.ts';
import { CEO, STRANGER, approvedTickets, eventsOf, setup, type Setup } from './helpers.ts';

type Result = Record<string, unknown>;
const tools = (s: Setup) => new ChiefTools(s.ctx, s.engine, null);
const call = async (s: Setup, name: string, args: unknown) => (await tools(s).call(name, args)) as Result;

/** 비서실장 요청 → #결재함 메시지 → 버튼 ID */
async function requestAndPost(s: Setup, args: Record<string, unknown>) {
  const r = await call(s, 'request_action', { reason: '사장님이 말함', ...args });
  const discord = new FakeDiscord();
  await new Notifier(s.ctx, discord).tick();
  return { r, discord, posted: discord.in('approvals').at(-1) };
}
const click = (s: Setup, customId: string, userId = CEO) => new InteractionHandler(s.ctx, s.engine).handle({ type: 'button', userId, customId });

describe('비서실장 도구 목록 (코드로 집행)', () => {
  it('늘어난 것은 읽기 5개(회사 기억 포함, 2026-10-23)·확인 버튼 요청·비상 정지뿐이고, 결재·답변·재개·기억 쓰기 도구는 없다', async () => {
    expect([...TOOL_NAMES].sort()).toEqual(
      [
        'get_status', 'get_ticket', 'get_pending_approvals', 'get_report_data', 'get_usage',
        'get_ticket_log', 'get_order', 'get_staff', 'get_projects', 'get_memory',
        'create_order', 'respond_order_proposal', 'request_confirmation', 'request_action', 'emergency_stop', 'submit_report',
      ].sort(),
    );
    const s = setup();
    for (const name of ['decide_approval', 'approve_plan', 'answer_clarification', 'resume', 'set_setting', 'remember', 'forget']) {
      await expect(tools(s).call(name, {})).rejects.toThrow('없는 도구');
    }
  });
});

describe('읽기 도구', () => {
  it('티켓 대화·회의록, 지시·계획서, 직원, 프로젝트를 읽고 아무것도 바꾸지 않는다', async () => {
    const s = setup();
    await approvedTickets(s);
    const before = eventsOf(s).length;

    const log = await call(s, 'get_ticket_log', { ticketId: 'T-1', limit: 5 });
    expect(log).toMatchObject({ id: 'T-1', meetings: [] });
    expect(Array.isArray(log.messages)).toBe(true);
    expect((await call(s, 'get_ticket_log', { ticketId: 'T-99' })).error).toContain('T-99');

    const list = (await tools(s).call('get_order', {})) as { id: string }[];
    expect(list.map((o) => o.id)).toEqual(['O-1']);
    const detail = await call(s, 'get_order', { orderId: 'O-1' });
    expect(detail).toMatchObject({ id: 'O-1', plan: { status: 'approved' }, tickets: [{ id: 'T-1' }] });

    const staff = (await tools(s).call('get_staff', {})) as { id: string; name: string | null; tickets: string[] }[];
    expect(staff.find((e) => e.id === 'chief-of-staff')?.name).toBe('백서진');
    expect(staff.some((e) => e.tickets.some((t) => t.startsWith('T-1')))).toBe(true);

    const projects = (await tools(s).call('get_projects', {})) as Result[];
    expect(projects).toEqual([{ id: 'demo', repoUrl: 'https://github.com/owner/demo.git', defaultBranch: 'main', testCommand: 'npm test', hasChannel: false }]);
    expect(JSON.stringify(projects)).not.toContain('localPath');

    expect(eventsOf(s).length).toBe(before);
  });
});

describe('확인 버튼 요청 (실행은 사장님 클릭으로만)', () => {
  it('설정: 요청만으로는 바뀌지 않고, 사장님이 [실행]을 눌러야 바뀐다. 두 번째 클릭은 처리하지 않는다', async () => {
    const s = setup();
    const before = s.config.absenceMinutes;
    const { r, posted } = await requestAndPost(s, { kind: 'setting', target: 'absence-minutes', value: '45' });
    expect(r).toMatchObject({ requested: true });
    expect(s.config.absenceMinutes).toBe(before);
    expect(posted!.content).toContain(`부재 전환 시간(분): ${before}분 → 45분`);
    const ok = posted!.buttons![0]![0]!.id;
    expect(ok).toMatch(/^cr:.+:ok$/);

    // 다른 계정의 클릭은 무시한다
    expect(await click(s, ok, STRANGER)).toEqual({ kind: 'ignore' });
    expect(s.config.absenceMinutes).toBe(before);

    const done = await click(s, ok);
    expect(done).toMatchObject({ kind: 'update', buttons: [] });
    expect(s.config.absenceMinutes).toBe(45);
    expect(await click(s, ok)).toMatchObject({ kind: 'reply', ephemeral: true, content: '이미 처리된 요청이에요' });
  });

  it('[하지 않기]를 누르면 아무것도 바뀌지 않고 닫힌다', async () => {
    const s = setup();
    const before = s.config.ticketCaps.maxTurns;
    const { posted } = await requestAndPost(s, { kind: 'setting', target: 'ticket-max-turns', value: '80' });
    const [ok, no] = posted!.buttons![0]!.map((b) => b.id);
    expect(await click(s, no!)).toMatchObject({ kind: 'update', content: expect.stringContaining('하지 않기로 했어요') });
    expect(await click(s, ok!)).toMatchObject({ ephemeral: true, content: '이미 처리된 요청이에요' });
    expect(s.config.ticketCaps.maxTurns).toBe(before);
  });

  it('지금 할 수 없는 요청은 버튼을 띄우지 않고 이유를 돌려준다. 같은 요청은 하나만', async () => {
    const s = setup();
    await approvedTickets(s);
    expect(await call(s, 'request_action', { kind: 'setting', target: 'nope', value: '1', reason: '' })).toMatchObject({ requested: false, note: expect.stringContaining('absence-minutes') });
    expect(await call(s, 'request_action', { kind: 'setting', target: 'toString', value: '1', reason: '' })).toMatchObject({ requested: false });
    expect(await call(s, 'request_action', { kind: 'setting', target: 'absence-minutes', value: '많이', reason: '' })).toMatchObject({ requested: false });
    expect(await call(s, 'request_action', { kind: 'retry-ticket', target: 'T-1', reason: '' })).toMatchObject({ requested: false, note: expect.stringContaining('막힌 상태가 아니') });
    expect(await call(s, 'request_action', { kind: 'retry-plan', target: 'O-1', reason: '' })).toMatchObject({ requested: false });
    expect(await call(s, 'request_action', { kind: 'guest-on', target: 'nobody', reason: '' })).toMatchObject({ requested: false });
    expect(await call(s, 'request_action', { kind: 'new-project', target: 'Bad_ID', reason: '' })).toMatchObject({ requested: false });

    const a = await call(s, 'request_action', { kind: 'new-project', target: 'todo-app', reason: '' });
    const b = await call(s, 'request_action', { kind: 'new-project', target: 'todo-app', reason: '' });
    expect(a).toMatchObject({ requested: true });
    expect(b.requestId).toBe(a.requestId);
    // #결재함에는 한 번만 올라가고, 다음 바퀴에 다시 올리지 않는다
    const discord = new FakeDiscord();
    const n = new Notifier(s.ctx, discord);
    await n.tick();
    await n.tick();
    expect(discord.in('approvals').filter((m) => m.content.includes('비서실장 요청'))).toHaveLength(1);
  });

  it('Discord가 실패하면 다음 바퀴에 다시 올린다', async () => {
    const s = setup();
    await call(s, 'request_action', { kind: 'setting', target: 'absence-minutes', value: '30', reason: '' });
    const discord = new FakeDiscord();
    const n = new Notifier(s.ctx, discord);
    discord.failNext = true;
    await n.tick().catch(() => undefined);
    await n.tick();
    expect(discord.in('approvals').filter((m) => m.content.includes('비서실장 요청'))).toHaveLength(1);
  });

  it('실행이 거부되면(예: 연결 없음) 요청은 남아 있어 다시 누르거나 닫을 수 있다', async () => {
    const s = setup();
    const { r, posted } = await requestAndPost(s, { kind: 'new-project', target: 'todo-app' });
    const [ok, no] = posted!.buttons![0]!.map((b) => b.id);
    expect(await click(s, ok!)).toMatchObject({ kind: 'reply', ephemeral: true, content: expect.stringContaining('연결되지 않았') });
    expect(chiefRequestOf(s.ctx, String(r.requestId))?.status).toBe('pending');
    await click(s, no!);
    expect(chiefRequestOf(s.ctx, String(r.requestId))?.status).toBe('cancelled');
  });

  it('막힌 티켓 다시 시도: 사장님 클릭 때 #막힘 [다시 시도]와 같이 진행된다', async () => {
    const s = setup();
    await approvedTickets(s);
    s.db.update(tickets).set({ status: 'blocked' }).where(eq(tickets.id, 'T-1')).run();
    const { posted } = await requestAndPost(s, { kind: 'retry-ticket', target: 't-1' });
    expect(posted!.content).toContain('T-1');
    expect(s.db.select().from(tickets).where(eq(tickets.id, 'T-1')).get()!.status).toBe('blocked');
    await click(s, posted!.buttons![0]![0]!.id);
    expect(s.db.select().from(tickets).where(eq(tickets.id, 'T-1')).get()!.status).toBe('in_progress');
  });

  it('멈춘 계획 작성 다시 시도: 사장님 클릭 때 멈춤 표시가 풀린다', async () => {
    const s = setup();
    const { order } = s.engine.submitOrder({ discordMessageId: '1300000000000000099', rawText: '예약 도구를 만들어줘' });
    setState(s.ctx, planBlockedKey(order.id), { issues: '형식 오류', at: s.clock.now().toISOString() });
    const { posted } = await requestAndPost(s, { kind: 'retry-plan', target: order.id });
    expect(getState(s.ctx, planBlockedKey(order.id), null)).not.toBeNull();
    await click(s, posted!.buttons![0]![0]!.id);
    expect(getState(s.ctx, planBlockedKey(order.id), null)).toBeNull();
    expect(s.db.select().from(orders).where(eq(orders.id, order.id)).get()!.status).toBe('planning');
  });

  it('파견 직원 퇴근: 사장님 클릭 때만 퇴근한다', async () => {
    const s = setup();
    mkdirSync(s.config.paths.data, { recursive: true });
    writeFileSync(join(s.config.paths.data, 'guests.json'), JSON.stringify({ guests: [{ id: 'minsu', name: '민수', provider: 'claude' }] }), 'utf8');
    syncGuests(s.ctx, loadGuestRegistry(s.config.paths.data));
    setGuestOn(s.ctx, 'minsu', true, CEO);
    const { posted } = await requestAndPost(s, { kind: 'guest-off', target: 'minsu' });
    const leftAt = () => s.db.select().from(employees).where(eq(employees.id, guestEmployeeId('minsu'))).get()!.leftAt;
    expect(leftAt()).toBeNull();
    await click(s, posted!.buttons![0]![0]!.id);
    expect(leftAt()).not.toBeNull();
  });
});

describe('비상 정지 (멈춤만, 풀기는 사장님 /재개)', () => {
  it('회사를 정지 상태로 두고 사장님께 바로 알린다. 티켓 상태는 그대로이고 정지 중에는 아무 일도 시작하지 않는다', async () => {
    const s = setup();
    await approvedTickets(s);
    const statusBefore = s.db.select().from(tickets).all().map((t) => t.status);

    const r = await call(s, 'emergency_stop', { reason: '직원들이 같은 말을 반복함' });
    expect(r).toMatchObject({ stopped: true });
    expect(isStopped(s.ctx)).toBe(true);
    expect(s.db.select().from(tickets).all().map((t) => t.status)).toEqual(statusBefore);
    expect(eventsOf(s, 'system.paused').at(-1)!.payload).toMatchObject({ by: 'chief-of-staff', reason: '직원들이 같은 말을 반복함' });
    expect(await s.engine.step()).toBe(0);

    const discord = new FakeDiscord();
    await new Notifier(s.ctx, discord).tick();
    expect(discord.in('reports').at(-1)!.content).toContain('비상 정지');
    expect(discord.in('reports').at(-1)!.content).toContain('직원들이 같은 말을 반복함');

    // 이미 멈춰 있으면 다시 알리지 않는다
    expect((await call(s, 'emergency_stop', { reason: '또' })).note).toContain('이미');
    expect(eventsOf(s, 'system.paused')).toHaveLength(1);
  });

  it('풀기는 사장님 계정의 /재개뿐이고, 풀리면 하던 일을 이어간다', async () => {
    const s = setup();
    await approvedTickets(s);
    await call(s, 'emergency_stop', { reason: '확인 필요' });
    expect(() => resumeAll(s.ctx, STRANGER)).toThrow(NotCeoError);
    expect(isStopped(s.ctx)).toBe(true);
    s.engine.resume(CEO);
    expect(isStopped(s.ctx)).toBe(false);
    await s.engine.runUntilIdle();
    expect(s.db.select().from(tickets).all().every((t) => t.status === 'done')).toBe(true);
  });
});
