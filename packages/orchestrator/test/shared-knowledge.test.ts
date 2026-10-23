// 직원끼리 아는 것 나누기 (6장, 2026-10-23 CEO 결정): 회사 기억, 글에 적힌 티켓 기록, #비서실 대화, PM → 개발팀장 질문.
import { describe, expect, it } from 'vitest';
import { claudeProfileFor } from '../src/brains/claude-code.ts';
import { chatLines, snowflakeAt } from '../src/chief/secretary-chat.ts';
import { ChiefTools } from '../src/chief/tools.ts';
import { answerClarification, clarificationOf, MAX_CONSULT_ROUNDS } from '../src/core/clarifications.ts';
import { blockBudget } from '../src/core/budget.ts';
import { allNotes, COMPANY_SCOPE, forget, MAX_NOTES_PER_SCOPE, memoryFor, remember } from '../src/core/memory.ts';
import { InteractionHandler } from '../src/discord/interactions.ts';
import { Notifier } from '../src/discord/notifier.ts';
import { Engine } from '../src/engine.ts';
import { registerProject } from '../src/workspace/projects.ts';
import { FakeDiscord } from './fakes/fake-discord.ts';
import { CEO, orderUntilPlanApproval, setup, STRANGER } from './helpers.ts';

let seq = 0;
const msgId = () => `14000000000000${String(++seq).padStart(5, '0')}`;

describe('회사 기억', () => {
  it('사장님 답변은 원문 그대로 기억에 남고, 다음 지시의 PM과 티켓 작업에도 보인다', async () => {
    const s = setup({ handlers: { clarify: (_req, n) => ({ understanding: '병합', questions: n === 1 ? ['jhwchn 병합은 어디에 합치나요?'] : [] }) } });
    const { order } = s.engine.submitOrder({ discordMessageId: msgId(), rawText: '끝나면 jhwchn 병합', projectId: 'demo' });
    await s.engine.runUntilIdle();
    answerClarification(s.ctx, order.id, 1, 'jhwchn 저장소 main에 합쳐', CEO);
    expect(memoryFor(s.ctx, 'demo')).toEqual([{ text: 'PM 질문: 1. jhwchn 병합은 어디에 합치나요?\n사장님 답변: jhwchn 저장소 main에 합쳐', at: expect.any(String) }]);
    expect(allNotes(s.ctx)[0]).toMatchObject({ scope: 'demo', source: 'answer', orderId: order.id });
    // 같은 프로젝트의 다음 지시: PM이 기억을 읽는다
    await s.engine.runUntilIdle();
    s.engine.submitOrder({ discordMessageId: msgId(), rawText: '다른 기능도', projectId: 'demo' });
    await s.engine.runUntilIdle();
    expect(s.mock.callsFor('clarify').at(-1)!.prompt.user).toContain('jhwchn 저장소 main에 합쳐');
    expect(s.mock.callsFor('plan').at(-1)!.prompt.user).toContain('회사 기억');
  });

  it('티켓 작업·검토에도 그 프로젝트 기억이 붙고, 다른 프로젝트 기억은 붙지 않는다', async () => {
    const s = setup();
    registerProject(s.ctx, { id: 'other', repoUrl: 'https://github.com/owner/other.git', localPath: `${s.root}/repos/other`, testCommand: 'npm test' });
    remember(s.ctx, 'demo', { text: '데모는 pnpm을 쓴다', source: 'ceo' });
    remember(s.ctx, 'other', { text: '다른 프로젝트 비밀 규칙', source: 'ceo' });
    remember(s.ctx, COMPANY_SCOPE, { text: '회사는 한국어로 쓴다', source: 'ceo' });
    const { approval } = await orderUntilPlanApproval(s, 'demo 프로젝트에 로그인 기능 추가해줘');
    s.engine.decide({ approvalId: approval!.id, discordUserId: CEO, decision: 'approved' });
    await s.engine.runUntilIdle();
    for (const task of ['work', 'review'] as const) {
      const prompt = s.mock.callsFor(task)[0]!.prompt.user;
      expect(prompt).toContain('데모는 pnpm을 쓴다');
      expect(prompt).toContain('회사는 한국어로 쓴다');
      expect(prompt).not.toContain('다른 프로젝트 비밀 규칙');
    }
  });

  it('범위마다 최근 30개만 남기고, 지우기는 사장님만', () => {
    const s = setup();
    for (let i = 1; i <= MAX_NOTES_PER_SCOPE + 2; i++) remember(s.ctx, 'demo', { text: `기억 ${i}`, source: 'ceo' });
    remember(s.ctx, COMPANY_SCOPE, { text: '회사 것', source: 'ceo' });
    const demo = allNotes(s.ctx).filter((n) => n.scope === 'demo');
    expect(demo).toHaveLength(MAX_NOTES_PER_SCOPE);
    expect(demo[0]!.text).toBe('기억 3');
    expect(() => remember(s.ctx, 'demo', { text: '  ', source: 'ceo' })).toThrow('기억할 내용');
    expect(() => forget(s.ctx, demo[0]!.id, STRANGER)).toThrow();
    forget(s.ctx, demo[0]!.id, CEO);
    expect(allNotes(s.ctx).some((n) => n.id === demo[0]!.id)).toBe(false);
  });

  it('/기억으로 추가·보기·지우기, 비서실장은 읽기만', async () => {
    const s = setup();
    const h = new InteractionHandler(s.ctx, s.engine);
    const cmd = (options: Record<string, string>) => h.handle({ type: 'command', userId: CEO, name: '기억', options, id: msgId() });
    expect(await cmd({ 추가: '배포는 Cloudflare Pages', 프로젝트: 'demo' })).toMatchObject({ kind: 'reply', content: expect.stringContaining('기억 1번') });
    expect(await cmd({ 추가: '없는 곳', 프로젝트: 'nope' })).toMatchObject({ ephemeral: true, content: expect.stringContaining('프로젝트가 없어요') });
    expect(await cmd({})).toMatchObject({ content: expect.stringContaining('배포는 Cloudflare Pages') });
    expect(await new ChiefTools(s.ctx, s.engine, null).call('get_memory', { projectId: 'demo' })).toEqual([{ text: '배포는 Cloudflare Pages', at: expect.any(String) }]);
    expect(await cmd({ 지우기: '1' })).toMatchObject({ content: expect.stringContaining('지웠어요') });
    expect(allNotes(s.ctx)).toHaveLength(0);
    expect(await h.handle({ type: 'command', userId: STRANGER, name: '기억', options: { 추가: '몰래' }, id: msgId() })).toEqual({ kind: 'ignore' });
  });
});

describe('지시에 적힌 티켓 기록', () => {
  it('지시 글의 T-번호는 코드가 기록을 찾아 PM에게 붙인다 (사장님께 붙여 달라고 묻지 않게)', async () => {
    const s = setup();
    const { approval } = await orderUntilPlanApproval(s, '로그인 기능 추가해줘');
    s.engine.decide({ approvalId: approval!.id, discordUserId: CEO, decision: 'approved' });
    await s.engine.runUntilIdle();
    s.engine.submitOrder({ discordMessageId: msgId(), rawText: '대상: T-1 (T-99 제외). 작업 재개' });
    await s.engine.runUntilIdle();
    const prompt = s.mock.callsFor('clarify').at(-1)!.prompt.user;
    expect(prompt).toContain('지시에 적힌 티켓·지시의 기록');
    expect(prompt).toContain('"id": "T-1"');
    expect(prompt).toContain('acceptanceCriteria');
    expect(prompt).not.toContain('"id": "T-99"');
  });
});

describe('#비서실 대화', () => {
  const secretaryConfig = { config: { discord: { guildId: 'guild', channels: { secretary: 'secretary' } } } };

  it('지시 직전 2시간의 사장님·봇 말만, 오래된 순으로', () => {
    const s = setup(secretaryConfig);
    const before = snowflakeAt('2026-10-23T03:00:00.000Z');
    const at = (iso: string) => snowflakeAt(iso);
    const raw = [
      { id: at('2026-10-23T02:59:00.000Z'), content: '어 등록해줘', author: { id: CEO, bot: false, username: 'ceo', global_name: '1차유근' } },
      { id: at('2026-10-23T02:58:00.000Z'), content: 'T-9 README와 jhwchn 병합 진행할까요?', author: { id: '1', bot: true, username: 'baek', global_name: '백서진' } },
      { id: at('2026-10-23T02:57:00.000Z'), content: '모르는 사람', author: { id: '2', bot: false, username: 'x', global_name: null } },
      { id: at('2026-10-23T00:30:00.000Z'), content: '오래된 말', author: { id: CEO, bot: false, username: 'ceo', global_name: null } },
    ];
    expect(chatLines(s.ctx, raw as never, before).map((l) => `${l.from}: ${l.text}`)).toEqual(['백서진: T-9 README와 jhwchn 병합 진행할까요?', '사장님: 어 등록해줘']);
  });

  it('#비서실에서 온 지시는 한 번 읽어 저장하고 PM에게 넘긴다. 다른 채널 지시는 읽지 않는다', async () => {
    const s = setup({ ...secretaryConfig, handlers: { clarify: (_req, n) => ({ understanding: '이해', questions: n === 1 ? ['무엇을 먼저?'] : [] }) } });
    let reads = 0;
    const engine = new Engine({
      ctx: s.ctx, brainFor: () => s.mock, tests: { run: async () => ({ passed: true, summary: 'ok' }) }, workspace: s.workspace,
      readSecretaryChat: async () => { reads++; return [{ at: '2026-10-23T02:58:00.000Z', from: '백서진', text: 'jhwchn은 T-15 변환기가 있는 저장소예요' }]; },
    });
    const { order } = engine.submitOrder({ discordMessageId: msgId(), rawText: 'T-15 이어서', channelId: 'secretary' });
    await engine.runUntilIdle();
    expect(s.mock.callsFor('clarify')[0]!.prompt.user).toContain('jhwchn은 T-15 변환기가 있는 저장소예요');
    answerClarification(s.ctx, order.id, 1, '변환기부터', CEO);
    await engine.runUntilIdle();
    expect(s.mock.callsFor('plan')[0]!.prompt.user).toContain('#비서실 대화');
    expect(reads).toBe(1);
    engine.submitOrder({ discordMessageId: msgId(), rawText: '다른 일', channelId: 'project-work' });
    await engine.runUntilIdle();
    expect(reads).toBe(1);
  });

  it('대화를 못 읽어도 지시는 대화 없이 진행한다', async () => {
    const s = setup(secretaryConfig);
    const engine = new Engine({
      ctx: s.ctx, brainFor: () => s.mock, tests: { run: async () => ({ passed: true, summary: 'ok' }) }, workspace: s.workspace,
      readSecretaryChat: async () => { throw new Error('Missing Access'); },
    });
    engine.submitOrder({ discordMessageId: msgId(), rawText: '예약 도구', channelId: 'secretary' });
    await engine.runUntilIdle();
    expect(s.mock.callsFor('plan')).toHaveLength(1);
  });
});

describe('PM → 개발팀장 질문', () => {
  it('저장소 질문은 개발팀장이 읽기 전용으로 답하고, 사장님께는 묻지 않는다. 대화는 채널에 조용히 보인다', async () => {
    const s = setup({ handlers: { clarify: (_req, n) => ({ understanding: '변환기 점검', questions: [], ...(n === 1 ? { askDeveloper: ['변환기는 어디에 등록돼 있나요?'] } : {}) }) } });
    const port = new FakeDiscord();
    const notify = new Notifier(s.ctx, port);
    const { order } = s.engine.submitOrder({ discordMessageId: msgId(), rawText: 'demo 변환기 등록 점검' });
    await s.engine.runUntilIdle();
    const consult = s.mock.callsFor('consult');
    expect(consult).toHaveLength(1);
    expect(consult[0]!.employee.id).toBe('developer');
    expect(consult[0]!.workdir).toBe(await s.workspace.readView({ id: 'demo' } as never));
    expect(claudeProfileFor(consult[0]!)).toBe('readonly');
    expect(clarificationOf(s.ctx, order.id).rounds).toEqual([expect.objectContaining({ from: 'developer', questions: ['변환기는 어디에 등록돼 있나요?'], answer: expect.stringContaining('src/feature.ts') })]);
    // 개발팀장 답은 AI 출력이라 자료로 감싸 PM에게 간다
    expect(s.mock.callsFor('plan')[0]!.prompt.user).toMatch(/<data source="개발팀장 답변">[\s\S]*src\/feature\.ts/);
    await notify.tick();
    expect(port.in('secretary')).toEqual([expect.objectContaining({ employeeId: 'developer', silent: true, content: expect.stringContaining('PM → 개발팀장 질문') })]);
    expect(port.in('secretary').some((m) => m.content.includes('PM 확인 질문'))).toBe(false);
  });

  it(`개발팀장에게는 지시마다 ${MAX_CONSULT_ROUNDS}번까지만 묻는다`, async () => {
    const s = setup({ handlers: { clarify: () => ({ understanding: '계속 궁금', questions: [], askDeveloper: ['또 궁금한 것'] }) } });
    s.engine.submitOrder({ discordMessageId: msgId(), rawText: 'demo 작업', projectId: 'demo' });
    await s.engine.runUntilIdle();
    expect(s.mock.callsFor('consult')).toHaveLength(MAX_CONSULT_ROUNDS);
    expect(s.mock.callsFor('clarify').at(-1)!.prompt.user).toContain('개발팀장에게는 더 물을 수 없다');
  });

  it('개발 몫이 없거나 답을 못 받으면 그 질문은 사장님께 여쭌다', async () => {
    const s = setup({ handlers: { clarify: (_req, n) => ({ understanding: '점검', questions: n === 1 ? ['목적은요?'] : [], ...(n === 1 ? { askDeveloper: ['브랜치가 있나요?'] } : {}) }) } });
    blockBudget(s.ctx, 'dev');
    const { order } = s.engine.submitOrder({ discordMessageId: msgId(), rawText: 'demo 점검', projectId: 'demo' });
    await s.engine.runUntilIdle();
    expect(s.mock.callsFor('consult')).toHaveLength(0);
    expect(clarificationOf(s.ctx, order.id).rounds.at(-1)).toMatchObject({ questions: ['목적은요?', '브랜치가 있나요?'], answer: null });

    const bad = setup({ handlers: { consult: () => ({ nope: true }), clarify: (_req, n) => ({ understanding: '점검', questions: [], ...(n === 1 ? { askDeveloper: ['브랜치가 있나요?'] } : {}) }) } });
    const o2 = bad.engine.submitOrder({ discordMessageId: msgId(), rawText: 'demo 점검', projectId: 'demo' }).order;
    await bad.engine.runUntilIdle();
    const rounds = clarificationOf(bad.ctx, o2.id).rounds;
    expect(rounds[0]).toMatchObject({ from: 'developer', answer: expect.stringContaining('답하지 못함') });
    expect(rounds[1]).toMatchObject({ questions: ['브랜치가 있나요?'], answer: null });
  });

  it('프로젝트를 알 수 없으면 개발팀장에게 묻지 않는다', async () => {
    const s = setup({ handlers: { clarify: () => ({ understanding: '모름', questions: [], askDeveloper: ['어느 저장소?'] }) } });
    registerProject(s.ctx, { id: 'other', repoUrl: 'https://github.com/owner/other.git', localPath: `${s.root}/repos/other`, testCommand: 'npm test' });
    s.engine.submitOrder({ discordMessageId: msgId(), rawText: '그거 고쳐줘' });
    await s.engine.runUntilIdle();
    expect(s.mock.callsFor('consult')).toHaveLength(0);
    expect(s.mock.callsFor('clarify')[0]!.prompt.user).toContain('개발팀장에게는 더 물을 수 없다');
  });
});
