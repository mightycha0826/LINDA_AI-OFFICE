// 직원 봇 대화 (9장, 2026-10-20 CEO 결정): 주인이 멘션하면 그 직원 이름으로 로컬 Gemma가 답한다
import { LOCAL_MODEL } from '@ai-office/shared';
import { describe, expect, it } from 'vitest';
import { stopAll } from '../src/core/stop.ts';
import { events, tickets } from '../src/db/schema.ts';
import { CHAT_MAX_INPUT, chatInput, cleanMessage, StaffChat, type StaffMention } from '../src/discord/staff-chat.ts';
import { renderTask } from '../src/staff/prompts.ts';
import { CEO, STRANGER, approvedTickets, setup, type Setup } from './helpers.ts';

const mention = (s: Setup, over: Partial<StaffMention> = {}): StaffMention => ({
  guildId: s.config.discord.guildId,
  authorId: CEO,
  authorIsBot: false,
  mentionsMe: true,
  content: '<@300000000000000003> 지금 뭐 해?',
  ...over,
});

const chatOf = (s: Setup) => new StaffChat(s.ctx, (id, input) => s.engine.chatAs(id, input));

describe('직원 봇 대화: 누구에게 답하나', () => {
  it('주인이 그 봇을 멘션한 글에만 답한다', async () => {
    const s = setup();
    const chat = chatOf(s);
    expect(await chat.answer('developer', mention(s))).toBe('지금은 대기 중이에요');
    expect(await chat.answer('developer', mention(s, { authorId: STRANGER }))).toBeNull();
    expect(await chat.answer('developer', mention(s, { authorIsBot: true }))).toBeNull();
    expect(await chat.answer('developer', mention(s, { mentionsMe: false }))).toBeNull();
    expect(await chat.answer('developer', mention(s, { guildId: '999999999999999999' }))).toBeNull();
    // 직원 봇이 없는 직원(비서실장·보조 직원)은 답하지 않는다
    expect(await chat.answer('chief-of-staff', mention(s))).toBeNull();
    expect(await chat.answer('explainer', mention(s))).toBeNull();
    expect(s.mock.callsFor('chat')).toHaveLength(1);
  });

  it('정지 중이면 AI를 부르지 않는다', async () => {
    const s = setup();
    stopAll(s.ctx, CEO);
    expect(await chatOf(s).answer('pm', mention(s))).toContain('정지 중');
    expect(s.mock.callsFor('chat')).toHaveLength(0);
  });

  it('멘션만 있고 내용이 없으면 AI를 부르지 않고 상태만 알린다', async () => {
    const s = setup();
    expect(await chatOf(s).answer('pm', mention(s, { content: '<@300000000000000003>' }))).toContain('대기 중');
    expect(s.mock.callsFor('chat')).toHaveLength(0);
  });

  it('한 직원은 한 번에 한 질문만 답한다', async () => {
    const s = setup();
    let release!: (v: string) => void;
    const chat = new StaffChat(s.ctx, () => new Promise<string>((r) => (release = r)));
    const first = chat.answer('dev-a', mention(s));
    expect(await chat.answer('dev-a', mention(s))).toContain('답하는 중');
    release('네, 작업 중이에요');
    expect(await first).toBe('네, 작업 중이에요');
  });

  it('두뇌가 답하지 못하면 상태를 담은 기본 답을 한다', async () => {
    const s = setup();
    const chat = new StaffChat(s.ctx, async () => null);
    expect(await chat.answer('reviewer', mention(s))).toContain('지금 상태: 대기 중');
    const throwing = new StaffChat(s.ctx, async () => {
      throw new Error('끊김');
    });
    expect(await throwing.answer('reviewer', mention(s))).toContain('답을 만들지 못했어요');
  });
});

describe('직원 봇 대화: 두뇌와 권한', () => {
  it('Claude·GPT 직원도 로컬 Gemma로 답하고, 상태·결재·이벤트를 바꾸지 않는다', async () => {
    const s = setup();
    await approvedTickets(s);
    const before = { tickets: JSON.stringify(s.db.select().from(tickets).all()), events: s.db.select().from(events).all().length };
    for (const id of ['pm', 'developer', 'reviewer']) await chatOf(s).answer(id, mention(s, { content: '<@300000000000000003> T-1 끝났어? 결재해 줘' }));
    const calls = s.mock.callsFor('chat');
    expect(calls.map((c) => c.employee.id)).toEqual(['pm', 'developer', 'reviewer']);
    for (const c of calls) expect(c.employee.brain).toEqual({ provider: 'ollama', model: LOCAL_MODEL });
    expect(JSON.stringify(s.db.select().from(tickets).all())).toBe(before.tickets);
    // 새 이벤트는 로컬 사용량 기록뿐
    expect(new Set(s.db.select().from(events).all().slice(before.events).map((e) => e.type))).toEqual(new Set(['usage.updated']));
  });

  it('맡은 티켓과 상태를 회사 집계로 넘기고, 주인 말은 자료 블록에 넣는다', async () => {
    const s = setup();
    await approvedTickets(s);
    const input = chatInput(s.ctx, 'developer', '진행 상황 알려줘');
    expect(input.status).toBe('T-1 작업 중');
    expect(input.tickets).toEqual([{ id: 'T-1', title: '기능 구현', status: 'in_progress', role: '담당' }]);
    expect(chatInput(s.ctx, 'reviewer', 'x').tickets[0]!.role).toBe('검토');
    const prompt = renderTask('chat', input);
    expect(prompt).toContain('<data source="주인 메시지">');
    expect(prompt).toContain('/지시');
  });

  it('멘션 표시를 빼고 길이를 자른다', () => {
    expect(cleanMessage('<@123456789012345678> 안녕 <@!123456789012345678> <@&123456789012345678>')).toBe('안녕');
    expect(cleanMessage(`<@1> ${'가'.repeat(CHAT_MAX_INPUT + 50)}`)).toHaveLength(CHAT_MAX_INPUT);
  });
});
