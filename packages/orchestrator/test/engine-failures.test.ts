// 두뇌 호출 실패 처리 (3장 인터넷 끊김, 8장 한도, 10장 시스템 이상)와 차선 (8장 동시 실행).
import { describe, expect, it } from 'vitest';
import { BrainError } from '../src/brains/brain.ts';
import { planOutput } from '../src/brains/mock.ts';
import { budgetStatus } from '../src/core/budget.ts';
import { approvedTickets, setup, ticket } from './helpers.ts';

const base = planOutput().tickets[0]!;
const twoTickets = () =>
  planOutput({
    tickets: [
      { ...base, title: '코드' },
      { ...base, title: '문구', type: 'marketing', assignee: 'marketing', reviewer: 'qa-local' },
    ],
  });

describe('인터넷 끊김', () => {
  it('클라우드 직원 티켓만 멈추고 로컬 직원은 계속 일한다. 연결되면 이어간다', async () => {
    let online = true;
    let failed = false;
    const s = setup({
      probe: async () => online,
      handlers: {
        plan: twoTickets,
        work: (req) => {
          if (req.employee.id === 'developer' && !failed) {
            failed = true;
            online = false;
            throw new BrainError('offline', 'getaddrinfo ENOTFOUND api.anthropic.com');
          }
          return req.employee.id === 'developer'
            ? { summary: '구현', changedFiles: [], criteriaSelfCheck: [] }
            : { document: '# 문구', claims: [] };
        },
      },
    });
    const { tickets: [code, copy] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, code!.id)).toMatchObject({ status: 'paused', pauseReason: 'offline', pausedFrom: 'in_progress' });
    expect(ticket(s, copy!.id).status).toBe('done'); // 로컬(Qwen → Gemma)은 끝까지 갔다
    expect(s.engine.connectivity.isOnline()).toBe(false);

    online = true;
    await s.engine.runUntilIdle();
    expect(ticket(s, code!.id).status).toBe('done');
    expect(s.engine.connectivity.isOnline()).toBe(true);
  });

  it('끊긴 동안 다른 클라우드 티켓도 시작하지 않고 멈춘다', async () => {
    const s = setup({ probe: async () => false });
    const { tickets: [tk] } = await approvedTickets(s);
    s.engine.connectivity.markOffline('테스트');
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'paused', pauseReason: 'offline' });
    expect(s.mock.callsFor('work')).toHaveLength(0);
  });
});

describe('제공자가 알려 온 한도 도달', () => {
  it('그 몫을 초기화 시각까지 막고, 개발 티켓을 멈췄다가, 시각이 지나면 이어간다', async () => {
    let hit = false;
    const s = setup({
      handlers: {
        work: (req) => {
          if (!hit) {
            hit = true;
            throw new BrainError('limit', 'usage limit reached', new Date(s.clock.now().getTime() + 2 * 3_600_000).toISOString());
          }
          return { summary: '구현', changedFiles: [], criteriaSelfCheck: [] };
        },
      },
    });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'paused', pauseReason: 'budget' });
    expect(budgetStatus(s.ctx, 'dev')).toMatchObject({ exhausted: true, blockedUntil: expect.any(String) });

    s.clock.advanceHours(2.1);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('done');
  });

  it('GPT 한도 도달이면 티켓은 in_review에서 기다린다 (멈추고 풀리기를 반복하지 않는다)', async () => {
    let hit = false;
    const s = setup({
      handlers: {
        review: (req) => {
          if (!hit) {
            hit = true;
            throw new BrainError('limit', "You've hit your usage limit");
          }
          const t = (req.input as { ticket: { acceptanceCriteria: string[] } }).ticket;
          return { verdict: 'pass', criteria: t.acceptanceCriteria.map((criterion) => ({ criterion, pass: true })), fixRequests: [] };
        },
      },
    });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('in_review');
    s.clock.advanceHours(1.1); // 초기화 시각을 모르면 1시간 막는다
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('done');
  });
});

describe('시간 초과·비정상 종료', () => {
  it('한 번은 다시 시도한다', async () => {
    let n = 0;
    const s = setup({
      handlers: {
        work: () => {
          if (++n === 1) throw new BrainError('crash', 'boom');
          return { summary: '구현', changedFiles: [], criteriaSelfCheck: [] };
        },
      },
    });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('done');
    expect(s.mock.callsFor('work').map((c) => c.attempt)).toEqual([1, 2]);
  });

  it('두 번 실패하면 그 티켓만 멈춘다(system-error)', async () => {
    const s = setup({
      handlers: {
        plan: twoTickets,
        work: (req) => {
          if (req.employee.id === 'developer') throw new BrainError('timeout', '30분 초과');
          return { document: '# 문구', claims: [] };
        },
      },
    });
    const { tickets: [code, copy] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, code!.id)).toMatchObject({ status: 'paused', pauseReason: 'system-error' });
    expect(ticket(s, copy!.id).status).toBe('done');
  });

  it('PM 호출이 두 번 실패하면 그 지시의 계획 작성을 멈춘다', async () => {
    const s = setup({ handlers: { plan: () => { throw new BrainError('crash', 'Ollama 꺼짐'); } } });
    s.engine.submitOrder({ discordMessageId: '1300000000000000555', rawText: 'x' });
    await s.engine.runUntilIdle();
    expect(s.mock.callsFor('plan')).toHaveLength(2);
    // CEO가 다시 시도하기 전에는 다시 부르지 않는다 (한도를 헛되이 쓰지 않음)
    await s.engine.runUntilIdle();
    expect(s.mock.callsFor('plan')).toHaveLength(2);
  });
});

describe('차선', () => {
  it('티켓 여러 개가 동시에 진행돼도 Claude·Codex는 각각 한 번에 하나만 돈다', async () => {
    const s = setup({
      handlers: {
        plan: () => planOutput({ tickets: [1, 2, 3, 4].map((i) => ({ ...base, title: `코드 ${i}` })) }),
      },
    });
    const { tickets: all } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(all.map((t) => ticket(s, t.id).status)).toEqual(['done', 'done', 'done', 'done']);
    expect(s.engine.lanes.peak.get('claude')).toBe(1);
    expect(s.engine.lanes.peak.get('codex')).toBe(1);
  });
});
