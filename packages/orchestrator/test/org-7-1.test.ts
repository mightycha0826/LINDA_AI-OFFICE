// 7-1 조직 개편: 기획과 한도 (2-0 조직도, 8장, 16장 7단계).
// GPT 몫 100%, 기획실장(PM)은 Claude(기획 몫), 기획 몫이 떨어지면 로컬로 바꾸지 않고 기다린다,
// GPT 관문은 직원별 모델 표를 함께 받는다.
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../src/config.ts';
import { recordUsage } from '../src/core/budget.ts';
import { employees, plans } from '../src/db/schema.ts';
import { brainLabel } from '../src/screen/snapshot.ts';
import { seedStaff } from '../src/seed.ts';
import { orderUntilPlanApproval, setup } from './helpers.ts';

describe('7-1 한도와 기획실장', () => {
  it('GPT는 한도 전부를 회사가 쓰고, Claude 몫은 그대로다', () => {
    expect(DEFAULTS.limits.gpt).toEqual({ fiveHour: { review: 100 }, weekly: { review: 100 } });
    expect(DEFAULTS.limits.claude).toEqual({ fiveHour: { dev: 55, research: 15 }, weekly: { dev: 39.5, research: 10.5 } });
  });

  it('기획실장은 Claude(기획 몫)다. 예전 DB의 Qwen PM도 다시 켤 때 맞춘다', () => {
    const s = setup();
    s.db.update(employees).set({ brain: { provider: 'ollama', model: 'qwen3:14b' }, displayName: 'PM' }).where(eq(employees.id, 'pm')).run();
    seedStaff(s.ctx);
    const pm = s.db.select().from(employees).where(eq(employees.id, 'pm')).get()!;
    expect(pm).toMatchObject({ brain: { provider: 'claude-code', budget: 'research' }, displayName: '기획실장', department: '기획실' });
    expect(brainLabel('pm', pm.brain)).toBe('Claude');
  });

  it('기획 몫이 떨어지면 계획은 기다린다. 로컬(저정밀)로 바꾸지 않는다', async () => {
    const s = setup();
    recordUsage(s.ctx, { budget: 'research', inputTokens: 1000, outputTokens: 500, estimatedPct: 15, estimatedWeeklyPct: 3, source: 'estimated' });
    const { order, approval } = await orderUntilPlanApproval(s);
    expect(approval).toBeUndefined();
    expect(s.mock.callsFor('plan')).toHaveLength(0);
    expect(s.db.select().from(plans).where(eq(plans.orderId, order.id)).all()).toHaveLength(0);
    // 5시간 창이 지나면 Claude로 이어 쓴다
    s.clock.advanceHours(5.1);
    await s.engine.runUntilIdle();
    expect(s.mock.callsFor('plan')).toHaveLength(1);
    expect(s.mock.callsFor('plan')[0]!.lowPrecision).toBeFalsy();
  });

  it('GPT 관문은 직원별 모델 표를 함께 받는다 (담당·검토가 다른 모델인지 확인할 수 있게)', async () => {
    const s = setup();
    await orderUntilPlanApproval(s);
    const input = s.mock.callsFor('gate')[0]!.input as { staffModels: { id: string; model: string }[] };
    expect(input.staffModels).toEqual(
      expect.arrayContaining([
        { id: 'pm', role: 'pm', model: 'claude' },
        { id: 'developer', role: 'developer', model: 'claude' },
        { id: 'reviewer', role: 'reviewer', model: 'gpt' },
        { id: 'qa-local', role: 'qa-local', model: 'gemma4:12b-64k' },
      ]),
    );
    expect(input.staffModels.map((x) => x.id)).not.toContain('git-cat'); // AI가 아닌 직원은 빼고
  });
});
