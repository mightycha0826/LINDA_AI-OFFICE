// 7-5 로컬 보조 직원 (16장): 막힘 해설가, 변경 요약가(gitcat.test.ts), 거울 통역사, 커밋 서기, 회고 서기,
// 보고 초안가(discord-notify.test.ts), 초안 작가. GPU 우선순위, 역할 'assistant'를 넣는 직원 표 다시 만들기(0008).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PmPlanOutputSchema } from '@ai-office/shared';
import { GpuQueue, QUEUE_PRIORITY } from '../src/brains/gpu-queue.ts';
import { planOutput } from '../src/brains/mock.ts';
import { setState } from '../src/context.ts';
import { checkPlanRules, fixReviewers } from '../src/core/plans.ts';
import { employees, messages, tickets } from '../src/db/schema.ts';
import { Mirror } from '../src/discord/mirror.ts';
import { Notifier } from '../src/discord/notifier.ts';
import { ASSISTANTS, queuePriorityOf } from '../src/staff/assistants.ts';
import { roleCard } from '../src/staff/role-cards.ts';
import { FakeDiscord, FakeMirror } from './fakes/fake-discord.ts';
import { approvedTickets, setup, ticket } from './helpers.ts';

const MIGRATION_0008 = fileURLToPath(new URL('../drizzle/0008_assistant_role.sql', import.meta.url));

describe('7-5 직원 표 다시 만들기 (0008)', () => {
  it('티켓이 직원을 가리키고 있어도 표를 다시 만들 수 있고, 외래 키·데이터가 그대로다', async () => {
    const s = setup();
    const { tickets: all } = await approvedTickets(s);
    expect(all.length).toBeGreaterThan(0);
    const raw = s.db.$client;
    const before = raw.prepare('select count(*) n from employees').get() as { n: number };
    // 운영 DB가 0008을 처음 받는 상황을 흉내 낸다: 같은 SQL을 외래 키를 끈 채 다시 돌린다 (openDb와 같은 방식)
    const statements = readFileSync(MIGRATION_0008, 'utf8')
      .split('--> statement-breakpoint')
      .map((x) => x.trim())
      .filter((x) => x && !x.startsWith('PRAGMA'));
    raw.pragma('foreign_keys = OFF');
    raw.transaction(() => {
      for (const sql of statements) raw.exec(sql);
    })();
    raw.pragma('foreign_keys = ON');
    expect(raw.pragma('foreign_key_check')).toEqual([]);
    expect(raw.prepare('select count(*) n from employees').get()).toEqual(before);
    // 티켓의 담당자가 여전히 직원 표에 있다
    const [tk] = s.db.select().from(tickets).all();
    expect(s.db.select().from(employees).where(eq(employees.id, tk!.assigneeId)).get()).toBeDefined();
    // 새 역할도 들어가고, 없는 역할은 여전히 막힌다
    expect(() => raw.prepare("update employees set role = 'assistant' where id = 'drafter'").run()).not.toThrow();
    expect(() => raw.prepare("update employees set role = 'boss' where id = 'drafter'").run()).toThrow(/CHECK/);
  });
});

describe('7-5 보조 직원 명단', () => {
  it('일곱 명 모두 로컬 Gemma, 역할 assistant, 각자 하는 일이 역할 카드에 들어간다', () => {
    const s = setup();
    expect(ASSISTANTS.map((a) => a.id)).toEqual(['explainer', 'diff-summarizer', 'interpreter', 'commit-scribe', 'retro-scribe', 'briefer', 'drafter']);
    for (const a of ASSISTANTS) {
      const e = s.db.select().from(employees).where(eq(employees.id, a.id)).get()!;
      expect(e).toMatchObject({ role: 'assistant', displayName: a.displayName, department: a.department, brain: { provider: 'ollama', model: 'gemma4:12b-64k' }, canSearchWeb: false });
      const card = roleCard(s.ctx, e, a.task, PmPlanOutputSchema);
      expect(card).toContain(`보조 직원(${a.displayName})`);
      expect(card).toContain(a.does[0]!);
    }
  });

  it('보조 직원은 검토자가 될 수 없고, 초안 작가만 writing·marketing 티켓을 맡는다', () => {
    const s = setup();
    const base = planOutput().tickets[0]!;
    const one = (t: Partial<typeof base>) => planOutput({ projectId: undefined, tickets: [{ ...base, type: 'writing', ...t }] });
    expect(checkPlanRules(s.ctx, one({ assignee: 'drafter', reviewer: 'reviewer' }))).toEqual([]);
    expect(checkPlanRules(s.ctx, one({ assignee: 'drafter', reviewer: 'reviewer', type: 'research' }))).toEqual([expect.stringContaining('보조 직원 drafter')]);
    expect(checkPlanRules(s.ctx, one({ assignee: 'explainer', reviewer: 'reviewer' }))).toEqual([expect.stringContaining('보조 직원 explainer')]);
    expect(checkPlanRules(s.ctx, one({ assignee: 'strategy', reviewer: 'interpreter' }))).toEqual(expect.arrayContaining([expect.stringContaining('interpreter은(는) 티켓을 검토하지 않음')]));
    // 코드가 고칠 때도 보조 직원으로 바꾸지 않는다
    expect(fixReviewers(s.ctx, one({ assignee: 'drafter', reviewer: 'retro-scribe' })).out.tickets[0]!.reviewer).toBe('reviewer');
  });

  it('기획실장에게 보여 주는 직원 목록과 검토자 표에는 맡을 수 있는 보조 직원(초안 작가)만 나온다', async () => {
    const s = setup();
    await approvedTickets(s);
    const staff = (s.mock.callsFor('plan')[0]!.input as { staff: { id: string }[] }).staff.map((x) => x.id);
    expect(staff).toContain('drafter');
    for (const id of ['explainer', 'diff-summarizer', 'interpreter', 'commit-scribe', 'retro-scribe', 'briefer']) expect(staff).not.toContain(id);
    const pm = s.db.select().from(employees).where(eq(employees.id, 'pm')).get()!;
    const table = roleCard(s.ctx, pm, 'plan', PmPlanOutputSchema).split('## 6.')[1]!;
    expect(table).toContain('- drafter(gemma4:12b-64k) 담당');
    expect(table).not.toMatch(/explainer|interpreter|retro-scribe/);
  });
});

describe('7-5 GPU 우선순위', () => {
  it('기다리는 요청 중 급한 것부터, 같은 순위는 먼저 온 순서. 오래 기다린 요청은 순위보다 먼저', async () => {
    let now = 0;
    const q = new GpuQueue({ maxWaitMs: 1000, now: () => now });
    const order: string[] = [];
    let release!: () => void;
    const first = q.enqueue('m', () => new Promise<void>((r) => (release = r)));
    const job = (name: string) => async () => void order.push(name);
    const all = [
      q.enqueue('m', job('뒤-거울'), undefined, QUEUE_PRIORITY.background),
      q.enqueue('m', job('보통-작업'), undefined, QUEUE_PRIORITY.normal),
      q.enqueue('m', job('급함-해설'), undefined, QUEUE_PRIORITY.urgent),
    ];
    release();
    await Promise.all([first, ...all]);
    expect(order).toEqual(['급함-해설', '보통-작업', '뒤-거울']);

    // 오래 기다린 뒤 순위 요청
    const order2: string[] = [];
    let release2!: () => void;
    const first2 = q.enqueue('m', () => new Promise<void>((r) => (release2 = r)));
    const old = q.enqueue('m', async () => void order2.push('오래된-뒤'), undefined, QUEUE_PRIORITY.background);
    now = 2000;
    const fresh = q.enqueue('m', async () => void order2.push('새-급함'), undefined, QUEUE_PRIORITY.urgent);
    release2();
    await Promise.all([first2, old, fresh]);
    expect(order2).toEqual(['오래된-뒤', '새-급함']);
  });

  it('직원별 순위: 해설·요약은 급함, 거울·회고는 뒤, 나머지는 보통. 엔진이 로컬 호출에 순위를 붙인다', async () => {
    expect(queuePriorityOf('explainer')).toBe(QUEUE_PRIORITY.urgent);
    expect(queuePriorityOf('diff-summarizer')).toBe(QUEUE_PRIORITY.urgent);
    expect(queuePriorityOf('interpreter')).toBe(QUEUE_PRIORITY.background);
    expect(queuePriorityOf('retro-scribe')).toBe(QUEUE_PRIORITY.background);
    expect(queuePriorityOf('qa-local')).toBe(QUEUE_PRIORITY.normal);
    const s = setup();
    await s.engine.callAs('explainer', 'explain', (await import('@ai-office/shared')).ExplainOutputSchema, { notice: 'x' });
    expect(s.mock.callsFor('explain')[0]!.priority).toBe(QUEUE_PRIORITY.urgent);
  });
});

describe('7-5 막힘 해설가', () => {
  it('계획 작성 멈춤 알림 뒤에 해설을 따로 조용히 올린다. 원래 알림은 그대로', async () => {
    const s = setup();
    const { order } = s.engine.submitOrder({ discordMessageId: '1300000000000000501', rawText: '포트폴리오 만들어줘' });
    setState(s.ctx, `planBlocked:${order.id}`, { issues: '티켓 1: 검토자 ghost가 없음', at: '2026-10-15T00:00:00.000Z' });
    const discord = new FakeDiscord();
    const notices: string[] = [];
    const n = new Notifier(s.ctx, discord, () => {}, async (notice) => (notices.push(notice), ['계획서가 규칙에 맞지 않아 멈췄어요', '[다시 시도]를 누르면 다시 써요']));
    await n.tick();
    const msgs = discord.in('blocked');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.content).toContain('계획 작성 멈춤');
    expect(msgs[1]).toMatchObject({ silent: true, content: expect.stringContaining('**해설** (막힘 해설가)\n- 계획서가 규칙에 맞지 않아 멈췄어요') });
    expect(notices[0]).toContain('검토자 ghost');
  });

  it('해설이 실패하면 해설 없이 원래 알림만', async () => {
    const s = setup();
    const { order } = s.engine.submitOrder({ discordMessageId: '1300000000000000502', rawText: '포트폴리오 만들어줘' });
    setState(s.ctx, `planBlocked:${order.id}`, '이유');
    const discord = new FakeDiscord();
    await new Notifier(s.ctx, discord, () => {}, async () => Promise.reject(new Error('모델 문제'))).tick();
    expect(discord.in('blocked')).toHaveLength(1);
  });
});

describe('7-5 거울 통역사', () => {
  it('JSON 메시지는 문장으로 바꿔 올리고, 그냥 글은 그대로. 통역이 실패하면 원문', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    const port = new FakeMirror();
    let fail = false;
    const seen: string[] = [];
    const m = new Mirror(s.ctx, port, { maxPerFlush: 50, interpret: async (from, content) => (seen.push(from), fail ? Promise.reject(new Error('x')) : `${from}가 결과를 보냈어요`) });
    await m.flush();
    const posts = port.posts.map((p) => p.content);
    expect(posts.some((c) => c.includes('가 결과를 보냈어요'))).toBe(true);
    expect(posts.some((c) => c.startsWith('{'))).toBe(false); // JSON 원문이 그대로 나가지 않았다
    expect(seen.length).toBeGreaterThan(0);
    // 실패하면 원문
    fail = true;
    const { recordMessage } = await import('../src/core/guards.ts');
    recordMessage(s.ctx, { ticketId: tk!.id, orderId: tk!.orderId, fromId: 'reviewer', kind: 'chat', content: '{"a":1}', countsForPingpong: false });
    await m.flush();
    expect(port.posts.at(-1)!.content).toContain('**a**: 1');
    expect(port.posts.at(-1)!.content).not.toContain('{"a":1}');
  });
});

describe('7-5 커밋 서기·회고 서기·초안 작가', () => {
  it('커밋 메시지 초안은 커밋 서기가 쓴다', async () => {
    const s = setup();
    await s.engine.draftCommit({ id: 'T-1', title: '섹션', acceptanceCriteria: [], reworkCount: 0, reviewPassed: true, reviewerName: 'r' }, ' a | 1 +');
    expect(s.mock.callsFor('commit')[0]!.employee.id).toBe('commit-scribe');
  });

  it('초안 작가가 맡은 결과물에는 "초안" 표시가 붙는다', async () => {
    const base = planOutput().tickets[0]!;
    const s = setup({ handlers: { plan: () => planOutput({ projectId: undefined, tickets: [{ ...base, title: '예시 문구', type: 'writing', assignee: 'drafter', reviewer: 'reviewer', acceptanceCriteria: ['예시 문구 3개 포함'] }] }) } });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('done');
    const handoff = s.db.select().from(messages).where(eq(messages.ticketId, tk!.id)).all().find((m) => m.kind === 'handoff')!;
    expect(handoff.content.startsWith('초안 작가의 초안 (다듬기 전)')).toBe(true);
  });
});
