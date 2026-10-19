// 임시 직원 (2장, 6장, 13장, 2.5단계 결정 D·E).
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PmPlanOutputSchema, type PmPlanOutput } from '@ai-office/shared';
import { claudeProfileFor } from '../src/brains/claude-code.ts';
import { DevOutputSchema, DocOutputSchema } from '@ai-office/shared';
import { planOutput } from '../src/brains/mock.ts';
import { budgetOf } from '../src/core/budget.ts';
import { checkPlanRules } from '../src/core/plans.ts';
import { employees, plans, usage } from '../src/db/schema.ts';
import { roleCard } from '../src/staff/role-cards.ts';
import { approvedTickets, eventsOf, orderUntilPlanApproval, setup, ticket } from './helpers.ts';

const base = planOutput().tickets[0]!;
const writerPlan = (over: Partial<PmPlanOutput> = {}) =>
  planOutput({
    tempStaff: [{ key: 'writer-1', kind: 'writer', reason: '긴 안내문이 필요함' }],
    tickets: [{ ...base, title: '안내문', type: 'writing', assignee: 'temp:writer-1', reviewer: 'reviewer', acceptanceCriteria: ['요금 항목 포함'] }],
    ...over,
  });

const temps = (s: ReturnType<typeof setup>) => s.db.select().from(employees).where(eq(employees.isTemporary, true)).all();

describe('고용과 내보내기', () => {
  it('계획 승인 때 들어오고(방문증), 맡은 티켓이 끝나면 나간다', async () => {
    const s = setup({ handlers: { plan: () => writerPlan() } });
    const { order, tickets: [tk] } = await approvedTickets(s);
    const [w] = temps(s);
    expect(w).toMatchObject({
      id: 'tmp-o1-writer-1',
      role: 'temp',
      tempKind: 'writer',
      displayName: '작가',
      isTemporary: true,
      orderId: order.id,
      spriteSet: 'temp-1',
      canSearchWeb: true,
      brain: { provider: 'ollama', model: 'gemma4:12b-64k' },
      leftAt: null,
    });
    expect(tk!.assigneeId).toBe('tmp-o1-writer-1');
    expect(eventsOf(s, 'employee.move').map((e) => (e.payload as { direction: string }).direction)).toEqual(['in']);

    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('done');
    expect(temps(s)[0]!.leftAt).not.toBeNull();
    expect(eventsOf(s, 'employee.move').map((e) => (e.payload as { direction: string }).direction)).toEqual(['in', 'out']);
  });

  it('동시에 있는 임시 직원은 서로 다른 temp-* 스프라이트를 받는다', async () => {
    const s = setup({
      handlers: {
        plan: () =>
          planOutput({
            tempStaff: [
              { key: 'writer-1', kind: 'writer', reason: 'a' },
              { key: 'res-1', kind: 'researcher', reason: 'b' },
            ],
            tickets: [
              { ...base, title: '글', type: 'writing', assignee: 'temp:writer-1', reviewer: 'qa-local' },
              { ...base, title: '조사', type: 'research', assignee: 'temp:res-1', reviewer: 'qa-local' },
            ],
          }),
      },
    });
    await approvedTickets(s);
    expect(temps(s).map((t) => t.spriteSet).sort()).toEqual(['temp-1', 'temp-2']);
  });

  it('반려된 계획서의 지시에는 아무도 들어오지 않는다', async () => {
    const s = setup({ handlers: { plan: () => writerPlan() } });
    const { approval } = await orderUntilPlanApproval(s);
    s.engine.decide({ approvalId: approval!.id, discordUserId: s.config.ceoDiscordId, decision: 'rejected' });
    expect(temps(s)).toHaveLength(0);
  });
});

describe('권한과 몫', () => {
  it('Claude를 쓰는 임시 직원은 개발자 몫에서 깎인다', async () => {
    const s = setup({ handlers: { plan: () => writerPlan({ tempStaff: [{ key: 'writer-1', kind: 'writer', reason: '정밀한 글', brain: 'claude' }] }) } });
    await approvedTickets(s);
    const [w] = temps(s);
    expect(w!.brain).toEqual({ provider: 'claude-code', budget: 'dev' });
    expect(budgetOf(w!)).toBe('dev');
    await s.engine.runUntilIdle();
    const rows = s.db.select().from(usage).all().filter((u) => u.ticketId === 'T-1' && u.budget === 'dev');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('Claude를 쓰는 임시 직원도 파일 수정·명령 실행 권한이 없다 (2단계 버그 수정)', async () => {
    const s = setup({ handlers: { plan: () => writerPlan({ tempStaff: [{ key: 'writer-1', kind: 'writer', reason: 'x', brain: 'claude' }] }) } });
    await approvedTickets(s);
    const [w] = temps(s);
    const req = { employee: w!, task: 'work' as const, schema: DocOutputSchema, input: {}, prompt: { system: '', user: '' }, attempt: 1, signal: new AbortController().signal };
    expect(claudeProfileFor(req)).toBe('research'); // 작가: 검색·읽기만
    const designer = { ...w!, tempKind: 'designer' as const, canSearchWeb: false };
    expect(claudeProfileFor({ ...req, employee: designer })).toBe('readonly');
    // 상시 개발자는 그대로 작업 권한
    const dev = s.db.select().from(employees).where(eq(employees.id, 'developer')).get()!;
    expect(claudeProfileFor({ ...req, employee: dev, schema: DevOutputSchema })).toBe('dev-work');
  });

  it('역할 카드는 임시 직원 종류에 맞고, 파일 수정·명령 실행 금지가 붙는다', async () => {
    const s = setup({ handlers: { plan: () => writerPlan() } });
    await approvedTickets(s);
    const card = roleCard(s.ctx, temps(s)[0]!, 'work', DocOutputSchema, 'writing');
    expect(card).toContain('임시 직원(작가, 방문증)');
    expect(card).toContain('글과 문구 초안');
    expect(card).toContain('파일 수정이나 명령 실행을 하지 않는다');
  });
});

describe('계획서 규칙', () => {
  const s = setup();
  const problems = (p: PmPlanOutput) => checkPlanRules(s.ctx, p);

  it('임시 직원은 계획서당 최대 3명', () => {
    const four = ['a', 'b', 'c', 'd'].map((k) => ({ key: k, kind: 'writer' as const, reason: 'x' }));
    expect(PmPlanOutputSchema.safeParse({ ...writerPlan(), tempStaff: four }).success).toBe(false);
  });

  it('tempStaff에 없는 임시 직원, 코딩 티켓, 검토 맡기기는 안 된다', () => {
    expect(problems(writerPlan({ tickets: [{ ...base, type: 'writing', assignee: 'temp:ghost', reviewer: 'qa-local' }] }))).toEqual([expect.stringContaining('없는 임시 직원')]);
    expect(problems(writerPlan({ tickets: [{ ...base, type: 'coding', assignee: 'temp:writer-1', reviewer: 'reviewer' }] }))).toEqual([expect.stringContaining('coding 티켓을 맡지 않음')]);
    expect(problems(writerPlan({ tickets: [{ ...base, type: 'coding', assignee: 'developer', reviewer: 'temp:writer-1' }] }))).toEqual(
      expect.arrayContaining([expect.stringContaining('검토를 맡지 않음')]),
    );
  });

  it('임시 직원과 검토자도 다른 모델이어야 한다', () => {
    expect(problems(writerPlan({ tickets: [{ ...base, type: 'writing', assignee: 'temp:writer-1', reviewer: 'qa-local' }] }))).toEqual([expect.stringContaining('같은 모델(gemma4:12b-64k)')]);
    expect(problems(writerPlan())).toEqual([]);
  });

  it('디자인 시스템 담당은 티켓을 맡지 않는다', () => {
    const p = writerPlan({
      tempStaff: [{ key: 'ds', kind: 'design-system', reason: '화면 프로젝트' }],
      tickets: [{ ...base, type: 'writing', assignee: 'temp:ds', reviewer: 'reviewer' }],
    });
    expect(problems(p)).toEqual([expect.stringContaining('디자인 시스템 담당은(는) writing 티켓을 맡지 않음')]);
  });
});

describe('디자인 시스템 담당 (6장, 17장, 결정 D)', () => {
  it('관문 전에 조합을 고르고 바로 나간다. 조합은 계획서와 결재 요청에 붙고, Claude 한도를 쓰지 않는다', async () => {
    const s = setup({
      handlers: {
        plan: () => planOutput({ tempStaff: [{ key: 'ds', kind: 'design-system', reason: '관리 화면', brain: 'claude' }] }),
      },
    });
    const { approval } = await orderUntilPlanApproval(s);
    const plan = s.db.select().from(plans).get()!;
    expect(plan.designCombo).toEqual({ combo: 2, mode: 'light', reason: '관리 화면이라 오래 들여다봄' });
    expect(approval!.summary).toContain('디자인 조합 2(light)');

    const design = s.mock.callsFor('design');
    expect(design).toHaveLength(1);
    // Claude를 요청해도 로컬(7-2부터 Gemma 64K)로 고른다
    expect(design[0]!.employee.brain).toEqual({ provider: 'ollama', model: 'gemma4:12b-64k' });
    expect(design[0]!.prompt.user).toContain('코발트와 주황'); // 저장소의 조합 표를 넘긴다
    // 관문(GPT)은 조합을 고른 뒤에 봤다
    const order = s.mock.calls.map((c) => c.task);
    expect(order.indexOf('design')).toBeLessThan(order.indexOf('gate'));

    const [ds] = temps(s);
    expect(ds).toMatchObject({ tempKind: 'design-system', leftAt: expect.any(String) });
    expect(s.db.select().from(usage).all().filter((u) => u.budget === 'dev')).toHaveLength(0);
  });
});
