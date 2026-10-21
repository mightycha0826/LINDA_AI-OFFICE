// 7-4 리서치·콘텐츠 (16장): 전략가·카피라이터는 GPT(읽기 전용, 웹 도구 없음 — 오케스트레이터가 대신 검색),
// 문서 티켓은 검토 전에 교정 담당(Gemma)이 1차 점검한다. 교정은 판정하지 않고, 실패해도 티켓을 멈추지 않는다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { planOutput } from '../src/brains/mock.ts';
import { recordUsage } from '../src/core/budget.ts';
import { employees, messages } from '../src/db/schema.ts';
import { approvedTickets, setup, ticket } from './helpers.ts';

const base = planOutput().tickets[0]!;
const docPlan = (assignee: string, reviewer = 'qa-local', type: 'writing' | 'research' | 'strategy' | 'marketing' = 'writing') =>
  planOutput({ projectId: undefined, tickets: [{ ...base, title: '소개 원고', type, assignee, reviewer, acceptanceCriteria: ['자기소개 항목 포함'] }] });

describe('7-4 직원 구성', () => {
  it('카피라이터·전략가는 GPT(Codex), 교정 담당은 Gemma', () => {
    const s = setup();
    const e = (id: string) => s.db.select().from(employees).where(eq(employees.id, id)).get()!;
    expect(e('marketing')).toMatchObject({ displayName: '카피라이터', department: '마케팅 · 콘텐츠팀', brain: { provider: 'codex' }, canSearchWeb: true });
    expect(e('strategy')).toMatchObject({ displayName: '전략가', department: '리서치 · 전략팀', brain: { provider: 'codex' }, canSearchWeb: true });
    expect(e('qa-local')).toMatchObject({ displayName: '교정 담당', department: '품질보증팀', brain: { provider: 'ollama', model: 'gemma4:12b-64k' } });
  });

  it('Codex의 --search(모델 쪽 웹 검색)는 쓰지 않는다', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/brains/codex.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/'--search'|web_search/);
  });
});

describe('7-4 GPT 전략가의 웹 검색은 오케스트레이터가 대신', () => {
  it('검색어는 전략가가 정하고(샌드박스, 읽기 전용), 검색은 회사가 해서 결과를 자료로 넘긴다', async () => {
    const s = setup({ handlers: { plan: () => docPlan('strategy', 'qa-local', 'research') } });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('done');
    const search = s.mock.callsFor('search')[0]!;
    expect(search.employee.id).toBe('strategy');
    expect(search.workdir).toMatch(/_sandbox/);
    expect(s.web.queries).toEqual(['소개 원고']);
    const work = s.mock.callsFor('work')[0]!;
    expect((work.input as { searchResults: unknown[] }).searchResults).toHaveLength(1);
    expect(work.lowPrecision).toBeFalsy();
  });

  it('Claude 리서치 몫이 떨어져도 GPT 전략가는 그대로 일한다 (리서치 몫은 이제 기획실장만)', async () => {
    const s = setup({ handlers: { plan: () => docPlan('strategy', 'qa-local', 'research') } });
    const { tickets: [tk] } = await approvedTickets(s);
    recordUsage(s.ctx, { budget: 'research', inputTokens: 1, outputTokens: 1, estimatedPct: 15, estimatedWeeklyPct: 3, source: 'estimated' });
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'done', lowPrecision: false });
  });
});

describe('7-4 교정 1차 점검', () => {
  it('문서 티켓은 검토 전에 교정 담당이 지적 목록을 내고, 검토자는 그것을 자료로 받는다', async () => {
    const s = setup({ handlers: { plan: () => docPlan('marketing') } });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('done');
    const order = s.mock.calls.map((c) => c.task).filter((t) => ['work', 'proofread', 'review'].includes(t));
    expect(order).toEqual(['work', 'proofread', 'review']);
    expect(s.mock.callsFor('proofread')[0]!.employee.id).toBe('qa-local');
    const reviewInput = s.mock.callsFor('review')[0]!.input as { proofread: { issues: unknown[] } };
    expect(reviewInput.proofread).toMatchObject({ issues: expect.any(Array) });
    // 두뇌가 읽는 프롬프트에도 자료 블록으로 실린다 (2026-10-21: 입력에만 있고 프롬프트에 빠져 있던 문제)
    const prompt = s.mock.callsFor('review')[0]!.prompt.user;
    expect(prompt).toContain('## 교정 담당 1차 점검 (자료)');
    expect(prompt).toContain('<data source="교정 담당 지적 목록">');
    expect(prompt).toContain('판정은 완료 조건으로만');
    const note = s.db.select().from(messages).where(eq(messages.ticketId, tk!.id)).all().find((m) => m.fromId === 'qa-local' && m.content.includes('교정'));
    expect(note).toBeDefined();
  });

  it('교정이 실패해도 티켓은 멈추지 않고 교정 없이 검토로 간다', async () => {
    const s = setup({
      handlers: {
        plan: () => docPlan('marketing'),
        proofread: () => {
          throw new Error('모델 문제');
        },
      },
    });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('done');
    expect((s.mock.callsFor('review')[0]!.input as { proofread?: unknown }).proofread).toBeUndefined();
    expect(s.mock.callsFor('review')[0]!.prompt.user).not.toContain('교정 담당 1차 점검');
  });

  it('코딩 티켓과 교정 담당 자신이 쓴 문서는 교정하지 않는다', async () => {
    const coding = setup();
    await approvedTickets(coding);
    await coding.engine.runUntilIdle();
    expect(coding.mock.callsFor('proofread')).toHaveLength(0);

    const self = setup({ handlers: { plan: () => docPlan('qa-local', 'reviewer') } });
    await approvedTickets(self);
    await self.engine.runUntilIdle();
    expect(self.mock.callsFor('proofread')).toHaveLength(0);
  });
});
