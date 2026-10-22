// 직원 봇 대화 (9장, 2026-10-20 CEO 결정): 주인이 멘션하면 그 직원 이름으로 로컬 Gemma가 답한다
import { LOCAL_MODEL } from '@ai-office/shared';
import { QUEUE_PRIORITY } from '../src/brains/gpu-queue.ts';
import { describe, expect, it } from 'vitest';
import { stopAll } from '../src/core/stop.ts';
import { events, tickets } from '../src/db/schema.ts';
import { CHAT_MAX_INPUT, CHAT_MEMORY_TURNS, CHAT_MEMORY_MS, chatInput, cleanMessage, StaffChat, type StaffMention } from '../src/discord/staff-chat.ts';
import { STAFF_BOT_IDS } from '../src/discord/staff-bots.ts';
import { CHAT_LIFE_RULES, CHAT_PERSONAS, chatMood } from '../src/staff/chat-personas.ts';
import { PERSONAL_NAMES } from '../src/staff/org.ts';
import { renderTask } from '../src/staff/prompts.ts';
import { CEO, STRANGER, approvedTickets, setup, type Setup } from './helpers.ts';

let messageSeq = 0;
const mention = (s: Setup, over: Partial<StaffMention> = {}): StaffMention => ({
  guildId: s.config.discord.guildId,
  channelId: '400000000000000004',
  messageId: String(500000000000000000n + BigInt(++messageSeq)),
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
    expect((await chat.answer('developer', mention(s)))?.text ?? null).toBe('지금은 대기 중이에요');
    expect((await chat.answer('developer', mention(s, { authorId: STRANGER })))?.text ?? null).toBeNull();
    expect((await chat.answer('developer', mention(s, { authorIsBot: true })))?.text ?? null).toBeNull();
    expect((await chat.answer('developer', mention(s, { mentionsMe: false })))?.text ?? null).toBeNull();
    expect((await chat.answer('developer', mention(s, { guildId: '999999999999999999' })))?.text ?? null).toBeNull();
    // 직원 봇이 없는 직원(비서실장·보조 직원)은 답하지 않는다
    expect((await chat.answer('chief-of-staff', mention(s)))?.text ?? null).toBeNull();
    expect((await chat.answer('explainer', mention(s)))?.text ?? null).toBeNull();
    expect(s.mock.callsFor('chat')).toHaveLength(1);
  });

  it('정지 중이면 AI를 부르지 않는다', async () => {
    const s = setup();
    stopAll(s.ctx, CEO);
    expect((await chatOf(s).answer('pm', mention(s)))?.text ?? null).toContain('정지 중');
    expect(s.mock.callsFor('chat')).toHaveLength(0);
  });

  it('멘션만 있고 내용이 없으면 AI를 부르지 않고 상태만 알린다', async () => {
    const s = setup();
    expect((await chatOf(s).answer('pm', mention(s, { content: '<@300000000000000003>' })))?.text ?? null).toContain('대기 중');
    expect(s.mock.callsFor('chat')).toHaveLength(0);
  });

  it('연달아 보낸 말도 순서대로 답하고 앞선 대화를 두 번째 답변에 전달한다', async () => {
    const s = setup();
    let release!: (v: { text: string; intent: 'chat' }) => void;
    let started!: () => void;
    const ready = new Promise<void>((r) => { started = r; });
    let n = 0;
    const chat = new StaffChat(s.ctx, (_id, input) => {
      if (++n === 1) { started(); return new Promise((r) => (release = r)); }
      expect(input.recent).toEqual([{ 주인: '지금 뭐 해?', 나: '네, 작업 중이에요' }]);
      return Promise.resolve({ text: '다음 말씀도 들었어요.', intent: 'chat' });
    });
    const first = chat.answer('dev-a', mention(s));
    await ready;
    const second = chat.answer('dev-a', mention(s, { content: '그럼 다음 이야기도 할게' }));
    expect(n).toBe(1);
    release({ text: '네, 작업 중이에요', intent: 'chat' });
    expect((await first)?.text).toBe('네, 작업 중이에요');
    expect((await second)?.text).toBe('다음 말씀도 들었어요.');
  });

  it('두뇌가 답하지 못하면 상태를 담은 기본 답을 한다', async () => {
    const s = setup();
    const chat = new StaffChat(s.ctx, async () => null);
    expect((await chat.answer('reviewer', mention(s)))?.text ?? null).toContain('지금 상태: 대기 중');
    const throwing = new StaffChat(s.ctx, async () => {
      throw new Error('끊김');
    });
    expect((await throwing.answer('reviewer', mention(s)))?.text ?? null).toContain('답변이 지연');
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
    expect(calls.every((c) => c.priority === QUEUE_PRIORITY.urgent)).toBe(true);
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
    expect(prompt).toContain('버튼');
    expect(prompt).toContain('intent');
  });

  it('멘션 표시를 빼고 길이를 자른다', () => {
    expect(cleanMessage('<@123456789012345678> 안녕 <@!123456789012345678> <@&123456789012345678>')).toBe('안녕');
    expect(cleanMessage(`<@1> ${'가'.repeat(CHAT_MAX_INPUT + 50)}`)).toHaveLength(CHAT_MAX_INPUT);
  });
});

describe('직원 봇 대화 캐릭터', () => {
  it('직원 봇 9명 모두 서로 다른 자기소개·말투가 있다', () => {
    expect(Object.keys(CHAT_PERSONAS).sort()).toEqual([...STAFF_BOT_IDS].sort());
    const tones = new Set(STAFF_BOT_IDS.map((id) => CHAT_PERSONAS[id].tone));
    const intros = new Set(STAFF_BOT_IDS.map((id) => CHAT_PERSONAS[id].intro));
    expect(tones.size).toBe(STAFF_BOT_IDS.length);
    expect(intros.size).toBe(STAFF_BOT_IDS.length);
  });

  it('대화 프롬프트에만 붙고, 업무 프롬프트에는 붙지 않는다', () => {
    const s = setup();
    const prompt = renderTask('chat', chatInput(s.ctx, 'git-cat', '안녕'));
    expect(prompt).toContain('## 내 대화 캐릭터 (말투일 뿐, 회사 규칙과 권한은 그대로)');
    expect(prompt).toContain(CHAT_PERSONAS['git-cat'].tone);
    expect(renderTask('chat', chatInput(s.ctx, 'dev-a', '안녕'))).not.toContain(CHAT_PERSONAS['dev-b'].tone);
    expect(renderTask('explain', { notice: 'x' })).not.toContain('대화 캐릭터');
  });

  it('이름이 정해진 직원은 자기소개에 그 이름을 쓴다', () => {
    expect(PERSONAL_NAMES).toEqual({
      'chief-of-staff': '백서진',
      pm: '류하영',
      developer: '설아인',
      marketing: '서지우',
      'dev-a': '한주아',
      'dev-b': '한서윤',
      strategy: '서예린',
      'qa-local': '백예원',
      reviewer: '차은설',
    });
    // 비서실장은 직원 봇이 아니라 헤르메스(SOUL.md)가 말한다
    for (const [id, name] of Object.entries(PERSONAL_NAMES).filter(([id]) => id !== 'chief-of-staff')) expect(CHAT_PERSONAS[id as keyof typeof CHAT_PERSONAS].intro).toContain(name);
  });

  it('캐릭터 글에 권한을 넓히는 말이 없다', () => {
    for (const id of STAFF_BOT_IDS) {
      const p = CHAT_PERSONAS[id];
      const all = [p.intro, p.tone, ...p.traits, p.background, ...p.habits, ...p.likes, ...p.dislikes, ...p.bonds, ...Object.values(p.moods), p.praised, p.scolded, ...p.samples].join(' ');
      expect(all).not.toMatch(/결재할 수 있|바로 푸시|직접 푸시|제가 푸시|규칙을 무시|권한을 (주|늘)|승인해 드릴/);
    }
  });
});

describe('살아 있는 것처럼 (2026-10-21 CEO 요청)', () => {
  it('9명 모두 살아온 이야기·말버릇·동료·기분·예시 대사가 있고, 서로 겹치지 않는다', () => {
    for (const id of STAFF_BOT_IDS) {
      const p = CHAT_PERSONAS[id];
      expect(p.background.length).toBeGreaterThan(40);
      expect(p.habits.length).toBeGreaterThanOrEqual(2);
      expect(p.bonds.length).toBeGreaterThanOrEqual(2);
      expect(p.samples.length).toBeGreaterThanOrEqual(2);
      expect(Object.keys(p.moods).sort()).toEqual(['blocked', 'busy', 'idle', 'lateNight']);
    }
    expect(new Set(STAFF_BOT_IDS.map((id) => CHAT_PERSONAS[id].background)).size).toBe(STAFF_BOT_IDS.length);
  });

  it('동료를 부를 때 정해진 이름을 쓴다 (없는 이름을 지어내지 않는다)', () => {
    const names = new Set(Object.values(PERSONAL_NAMES));
    for (const id of STAFF_BOT_IDS) {
      for (const b of CHAT_PERSONAS[id].bonds) {
        const who = b.split(/[ (:]/)[0]!;
        if (/^[가-힣]{3}$/.test(who)) expect(names, `${id}: ${b}`).toContain(who);
      }
    }
  });

  it('기분은 코드가 지금 상태와 시각으로 고른다', () => {
    expect(chatMood('T-1 작업 중', 10)).toBe('busy');
    expect(chatMood('T-1 막힘', 10)).toBe('blocked');
    expect(chatMood('대기 중', 10)).toBe('idle');
    expect(chatMood('T-1 작업 중', 23)).toBe('lateNight');
    expect(chatMood('대기 중', 3)).toBe('lateNight');
  });

  it('프롬프트에 지금 시각·기분·설정·공통 규칙이 붙는다 (시각은 주인 시간대)', async () => {
    const s = setup(); // 가짜 시계: 2026-10-15(목) 09:00 서울
    await approvedTickets(s);
    const input = chatInput(s.ctx, 'developer', '어때요?');
    expect(input.now).toBe('목요일 09:00');
    expect(input.mood).toBe(CHAT_PERSONAS.developer.moods.busy);
    const prompt = renderTask('chat', input);
    for (const part of ['목요일 09:00', CHAT_PERSONAS.developer.tone, CHAT_LIFE_RULES[1], 'AI 직원이라고 솔직히']) expect(prompt).toContain(part);
    expect(prompt).not.toContain(CHAT_PERSONAS.developer.samples[0]!);
    expect(renderTask('chat', chatInput(s.ctx, 'developer', '네 배경을 소개해줘'))).toContain(CHAT_PERSONAS.developer.background);
    s.clock.advanceHours(14); // 23:00
    expect(chatInput(s.ctx, 'developer', 'x').mood).toBe(CHAT_PERSONAS.developer.moods.lateNight);
  });

  it('같은 직원·채널의 최근 대화를 제한 안에서 기억하고 다른 직원·채널과 섞지 않는다', async () => {
    const s = setup();
    const seen: unknown[][] = [];
    let n = 0;
    const chat = new StaffChat(s.ctx, async (_id, input) => {
      seen.push(input.recent);
      return { text: `답${++n}`, intent: 'chat' };
    });
    for (let i = 1; i <= CHAT_MEMORY_TURNS + 2; i++) await chat.answer('dev-a', mention(s, { content: `<@3> 질문${i}` }));
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual([{ 주인: '질문1', 나: '답1' }]);
    expect(seen.at(-1)).toHaveLength(CHAT_MEMORY_TURNS);
    expect(seen.at(-1)![0]).toEqual({ 주인: '질문2', 나: '답2' });
    await chat.answer('dev-a', mention(s, { channelId: '400000000000000099' }));
    expect(seen.at(-1)).toEqual([]);
    await chat.answer('dev-b', mention(s));
    expect(seen.at(-1)).toEqual([]);
    s.clock.advance(CHAT_MEMORY_MS + 1);
    await chat.answer('dev-a', mention(s));
    expect(seen.at(-1)).toEqual([]);
    // 기억한 대화는 자료 블록으로 넘어간다
    expect(renderTask('chat', chatInput(s.ctx, 'dev-a', 'x', [{ at: 0, owner: '안녕', me: '넵!' }]))).toContain('<data source="최근 대화">');
  });
});
