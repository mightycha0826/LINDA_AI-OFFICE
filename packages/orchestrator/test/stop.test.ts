// 비상 정지 (DESIGN.md 7장): /정지, /재개.
import { describe, expect, it } from 'vitest';
import { recordUsage } from '../src/core/budget.ts';
import { NotCeoError } from '../src/errors.ts';
import { CEO, STRANGER, approvedTickets, eventsOf, setup, ticket } from './helpers.ts';

describe('/정지와 /재개', () => {
  it('CEO 계정만 쓸 수 있다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    expect(() => s.engine.stop(STRANGER)).toThrow(NotCeoError);
    expect(() => s.engine.resume(STRANGER)).toThrow(NotCeoError);
    expect(ticket(s, tk!.id).status).toBe('in_progress');
  });

  it('/정지: 모든 티켓을 멈추고, 엔진은 아무 일도 하지 않는다. /재개: 정지 전 상태로', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.step(); // in_review
    s.engine.stop(CEO);
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'paused', pauseReason: 'ceo-stop', pausedFrom: 'in_review' });
    const calls = s.mock.calls.length;
    expect(await s.engine.step()).toBe(0);
    expect(s.mock.calls.length).toBe(calls);
    expect(eventsOf(s, 'system.paused')).toHaveLength(1);

    s.engine.resume(CEO);
    expect(ticket(s, tk!.id).status).toBe('in_review');
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('done');
  });

  it('/정지는 진행 중인 AI 호출을 끊는다', async () => {
    const s = setup({
      handlers: {
        work: (req) => {
          // 작업 도중 CEO가 /정지를 누른다
          s.engine.stop(CEO);
          if (req.signal.aborted) throw new DOMException('정지됨', 'AbortError');
          return { summary: '끝까지 감', changedFiles: [], criteriaSelfCheck: [] };
        },
      },
    });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.step();
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'paused', pauseReason: 'ceo-stop', pausedFrom: 'in_progress' });
  });

  it('한도 소진으로 멈춘 티켓은 /재개로 풀리지 않는다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    recordUsage(s.ctx, { budget: 'dev', inputTokens: 1, outputTokens: 1, estimatedPct: 55, estimatedWeeklyPct: 11, source: 'estimated' });
    await s.engine.step();
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'paused', pauseReason: 'budget' });
    s.engine.stop(CEO);
    s.engine.resume(CEO);
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'paused', pauseReason: 'budget' });
  });

  it('/정지 중에는 한도가 다시 차도 티켓이 깨어나지 않는다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    recordUsage(s.ctx, { budget: 'dev', inputTokens: 1, outputTokens: 1, estimatedPct: 55, estimatedWeeklyPct: 11, source: 'estimated' });
    await s.engine.step();
    s.engine.stop(CEO);
    s.clock.advanceHours(6);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'paused', pauseReason: 'budget' });
    s.engine.resume(CEO);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('done');
  });
});
