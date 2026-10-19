// 계획 작성 멈춤 (6장: PM이 두 번 틀리면 CEO가 다시 시도시킬 때까지 기다린다).
// #막힘에 [다시 시도][취소]로 알리고, PM에게는 같은 모델 검토자를 피할 수 있게 고를 수 있는 짝을 알려 준다.
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PmPlanOutputSchema } from '@ai-office/shared';
import { planOutput } from '../src/brains/mock.ts';
import { setState } from '../src/context.ts';
import { checkPlanRules } from '../src/core/plans.ts';
import { employees, orders, plans } from '../src/db/schema.ts';
import { InteractionHandler } from '../src/discord/interactions.ts';
import { Notifier } from '../src/discord/notifier.ts';
import { roleCard } from '../src/staff/role-cards.ts';
import { FakeDiscord } from './fakes/fake-discord.ts';
import { CEO, setup, STRANGER } from './helpers.ts';

/** 마케팅(qwen) 담당을 PM(qwen)이 검토하는, 늘 규칙에 걸리는 계획서 */
const sameModelPlan = () =>
  planOutput({ tickets: [{ title: '콘텐츠 정리', type: 'writing', assignee: 'marketing', reviewer: 'pm', acceptanceCriteria: ['자기소개 항목 포함'], needsCeoApproval: false, estimatedTokens: 5_000 }] });

describe('같은 모델 검토자', () => {
  it('규칙 위반 안내에 고를 수 있는 검토자를 적어 준다 (PM이 다시 쓸 때 바로 고치게)', () => {
    const s = setup();
    const [problem] = checkPlanRules(s.ctx, sameModelPlan());
    expect(problem).toContain('같은 모델(qwen3:14b)');
    expect(problem).toContain('검토자를 이 중에서 고를 것');
    expect(problem).toContain('qa-local(gemma4:12b)');
    expect(problem).not.toMatch(/고를 것:.*\bpm\(/); // 같은 모델은 후보가 아니다
    expect(problem).not.toMatch(/고를 것:.*\bmarketing\(/);
  });

  it('PM 계획서 역할 카드에 담당자별 검토 가능 직원 표가 붙는다. 다른 직원·다른 일에는 없다', () => {
    const s = setup();
    const staff = (id: string) => s.db.select().from(employees).where(eq(employees.id, id)).get()!;
    const card = roleCard(s.ctx, staff('pm'), 'plan', PmPlanOutputSchema);
    expect(card).toContain('## 6. 검토자 고르기');
    const line = card.split('\n').find((l) => l.startsWith('- marketing(qwen3:14b) 담당'))!;
    expect(line).toContain('qa-local');
    expect(line).not.toMatch(/검토:.*\bpm\b/);
    expect(roleCard(s.ctx, staff('pm'), 'retro', PmPlanOutputSchema)).not.toContain('## 6.');
    expect(roleCard(s.ctx, staff('developer'), 'work', PmPlanOutputSchema)).not.toContain('## 6.');
  });
});

/** PM이 계속 같은 실수를 해서 계획 작성이 멈춘 상태까지 */
async function blockedOrder(handlers: Parameters<typeof setup>[0] = { handlers: { plan: () => sameModelPlan() } }) {
  const s = setup(handlers);
  const discord = new FakeDiscord();
  const notifier = new Notifier(s.ctx, discord);
  const bot = new InteractionHandler(s.ctx, s.engine);
  const { order } = s.engine.submitOrder({ discordMessageId: '1300000000000000401', rawText: '포트폴리오 웹사이트 만들어줘' });
  await s.engine.runUntilIdle();
  const click = (action: 'retry' | 'cancel', userId = CEO) => bot.handle({ type: 'button', userId, customId: `pb:${order.id}:${action}` });
  return { ...s, discord, notifier, order, click };
}

describe('#막힘: 계획 작성 멈춤', () => {
  it('멈추면 이유와 [다시 시도][취소] 버튼을 한 번만 올린다', async () => {
    const s = await blockedOrder();
    expect(s.mock.callsFor('plan')).toHaveLength(2); // 한 번 고쳐 쓰게 하고 멈춤
    await s.notifier.tick();
    const msgs = s.discord.in('blocked');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toContain(`계획 작성 멈춤 · ${s.order.id}`);
    expect(msgs[0]!.content).toContain('같은 모델(qwen3:14b)');
    expect(msgs[0]!.buttons!.flat().map((b) => [b.id, b.label])).toEqual([
      [`pb:${s.order.id}:retry`, '다시 시도'],
      [`pb:${s.order.id}:cancel`, '취소'],
    ]);
    await s.notifier.tick();
    expect(s.discord.in('blocked')).toHaveLength(1);
  });

  it('[다시 시도]를 누르면 PM이 다시 쓰고, 또 멈추면 다시 알린다', async () => {
    let n = 0;
    const s = await blockedOrder({ handlers: { plan: () => (++n <= 4 ? sameModelPlan() : planOutput()) } });
    await s.notifier.tick();
    expect(await s.click('retry')).toMatchObject({ kind: 'update', content: expect.stringContaining('다시 시도해요'), buttons: [] });
    s.clock.advance(60_000); // PM 호출 사이에는 시간이 흐른다
    await s.engine.runUntilIdle(); // 3·4번째도 틀려 또 멈춤 (알림 확인이 그사이 돌지 않아도 새 멈춤으로 안다)
    await s.notifier.tick();
    expect(s.discord.in('blocked')).toHaveLength(2);
    await s.click('retry');
    await s.engine.runUntilIdle(); // 5번째는 규칙대로
    expect(s.db.select().from(plans).where(eq(plans.orderId, s.order.id)).get()).toBeTruthy();
    expect(s.db.select().from(orders).where(eq(orders.id, s.order.id)).get()!.status).not.toBe('cancelled');
  });

  it('[취소]를 누르면 지시를 취소하고 PM을 더 부르지 않는다. 다시 누르면 이미 끝났다고 알린다', async () => {
    const s = await blockedOrder();
    await s.notifier.tick();
    expect(await s.click('cancel')).toMatchObject({ kind: 'update', content: expect.stringContaining('취소했어요'), buttons: [] });
    expect(s.db.select().from(orders).where(eq(orders.id, s.order.id)).get()!.status).toBe('cancelled');
    const calls = s.mock.callsFor('plan').length;
    await s.engine.runUntilIdle();
    expect(s.mock.callsFor('plan')).toHaveLength(calls);
    expect(await s.click('retry')).toMatchObject({ kind: 'update', content: expect.stringContaining('이미 계획 단계가 아니에요') });
    await s.notifier.tick();
    expect(s.discord.in('blocked')).toHaveLength(1);
  });

  it('이 기능이 생기기 전에 멈춘 지시(이유만 글자로 저장됨)도 한 번 올린다', async () => {
    const s = setup();
    const discord = new FakeDiscord();
    const { order } = s.engine.submitOrder({ discordMessageId: '1300000000000000402', rawText: '비밀번호 찾기 추가해줘' });
    setState(s.ctx, `planBlocked:${order.id}`, '코딩 티켓이 있으면 projectId(등록된 프로젝트)가 필요함');
    const n = new Notifier(s.ctx, discord);
    await n.tick();
    await n.tick();
    expect(discord.in('blocked').map((m) => m.content)).toEqual([expect.stringContaining('projectId')]);
  });

  it('CEO가 아닌 계정의 클릭은 무시한다', async () => {
    const s = await blockedOrder();
    expect(await s.click('cancel', STRANGER)).toEqual({ kind: 'ignore' });
    expect(s.db.select().from(orders).where(eq(orders.id, s.order.id)).get()!.status).toBe('planning');
  });
});
