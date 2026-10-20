// 직원 봇 9개 (9장, 2026-10-20 CEO 결정: 보여 주기 전용)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stopAll } from '../src/core/stop.ts';
import { applyTicketEvent } from '../src/core/tickets.ts';
import { employees } from '../src/db/schema.ts';
import { Mirror } from '../src/discord/mirror.ts';
import { routeMirror, STAFF_BOT_IDS, StaffPresence, staffStatus, type StaffBotPort } from '../src/discord/staff-bots.ts';
import { ASSISTANTS } from '../src/staff/assistants.ts';
import { FakeMirror } from './fakes/fake-discord.ts';
import { CEO, approvedTickets, setup } from './helpers.ts';

class FakeStaffBots implements StaffBotPort {
  readonly posts: { id: string; threadId: string; content: string }[] = [];
  readonly statuses: { id: string; text: string }[] = [];
  readonly failing = new Set<string>();
  private readonly ids: string[];
  constructor(ids: string[]) {
    this.ids = ids;
  }
  has(id: string) {
    return this.ids.includes(id);
  }
  async post(id: string, threadId: string, content: string) {
    if (this.failing.has(id)) throw new Error('보내기 실패');
    this.posts.push({ id, threadId, content });
  }
  async setStatus(id: string, text: string) {
    this.statuses.push({ id, text });
  }
  async stop() {}
}

describe('직원 봇 명단', () => {
  it('정규 직원 9명이고, 비서실장·보조 직원은 없다', () => {
    const s = setup();
    const ids = new Set(s.db.select().from(employees).all().map((e) => e.id));
    expect(STAFF_BOT_IDS).toHaveLength(9);
    for (const id of STAFF_BOT_IDS) expect(ids.has(id)).toBe(true);
    expect(STAFF_BOT_IDS).not.toContain('chief-of-staff');
    for (const a of ASSISTANTS) expect(STAFF_BOT_IDS).not.toContain(a.id);
  });
});

describe('직원 봇 상태 글', () => {
  it('대기 중 → 작업 중 → 검토 중, 정지 중이면 정지', async () => {
    const s = setup();
    expect(staffStatus(s.ctx, 'developer')).toBe('대기 중');
    await approvedTickets(s);
    expect(staffStatus(s.ctx, 'developer')).toBe('T-1 작업 중');
    expect(staffStatus(s.ctx, 'reviewer')).toBe('대기 중');
    applyTicketEvent(s.ctx, 'T-1', { type: 'ticket.submitted' }, { kind: 'employee', id: 'developer' });
    expect(staffStatus(s.ctx, 'reviewer')).toBe('T-1 검토 중');
    expect(staffStatus(s.ctx, 'developer')).toBe('대기 중');
    stopAll(s.ctx, CEO);
    expect(staffStatus(s.ctx, 'reviewer')).toBe('정지');
  });

  it('연결된 봇에만, 바뀐 상태만 보낸다', async () => {
    const s = setup();
    const bots = new FakeStaffBots(['developer', 'reviewer']);
    const p = new StaffPresence(s.ctx, bots);
    expect(await p.tick()).toBe(2);
    expect(await p.tick()).toBe(0);
    await approvedTickets(s);
    expect(await p.tick()).toBe(1);
    expect(bots.statuses.at(-1)).toEqual({ id: 'developer', text: 'T-1 작업 중' });
    expect(bots.statuses.map((x) => x.id)).not.toContain('pm');
  });
});

describe('거울 글 보내기: 직원 봇 → 없거나 실패하면 웹훅', () => {
  it('직원 봇이 있으면 그 봇이 올리고, 봇 없는 직원은 웹훅', async () => {
    const s = setup();
    await approvedTickets(s);
    await s.engine.runUntilIdle();
    const hook = new FakeMirror();
    const bots = new FakeStaffBots(['developer']);
    const mirror = new Mirror(s.ctx, routeMirror(hook, bots), { maxPerFlush: 100 });
    while ((await mirror.flush()) > 0);
    expect(bots.posts.length).toBeGreaterThan(0);
    expect(bots.posts.every((p) => p.id === 'developer' && p.threadId === 'thread-T-1')).toBe(true);
    expect(hook.posts.map((p) => p.username)).not.toContain('개발팀장');
    expect(hook.posts.map((p) => p.username)).toContain('리뷰어 · 감사관');
  });

  it('직원 봇이 실패하면 그 글을 웹훅으로 올리고 기록한다', async () => {
    const hook = new FakeMirror();
    const bots = new FakeStaffBots(['pm']);
    bots.failing.add('pm');
    const logs: string[] = [];
    await routeMirror(hook, bots, (l) => logs.push(l)).post('th', { username: '기획실장', content: '계획', employeeId: 'pm' });
    expect(hook.posts).toEqual([{ threadId: 'th', username: '기획실장', content: '계획', employeeId: 'pm' }]);
    expect(logs[0]).toContain('웹훅으로');
  });
});

describe('직원 봇은 아무것도 받지 않는다 (코드로 집행)', () => {
  const src = readFileSync(join(import.meta.dirname, '../src/discord/bot.ts'), 'utf8');
  const body = src.slice(src.indexOf('export async function startStaffBots'));

  it('게이트웨이 권한은 Guilds만, 처리기는 연결 확인 하나뿐, 명령 등록 없음', () => {
    expect(body).toContain('intents: [GatewayIntentBits.Guilds] }');
    expect(body).not.toMatch(/GuildMessages|MessageContent|DirectMessages/);
    expect(body.match(/\.on\(|\.once\(/g)).toEqual(['.once(']);
    expect(body).toContain('client.once(Events.ClientReady');
    expect(body).not.toMatch(/applicationGuildCommands|InteractionCreate|MessageCreate/);
  });

  it('멘션을 걸지 않고, 토큰을 로그에 쓰지 않는다', () => {
    expect(body).toContain('allowedMentions: { parse: [] }');
    expect(body).not.toMatch(/log\([^)]*token/);
  });
});
