// 검토자 짝은 코드가 고친다 (6장 PM, 2026-10-19 CEO 승인).
// 같은 모델·담당자 본인·비서실장이면 코딩 → reviewer, 그 밖 → qa-local 순서로 바꾸고 계획서에 남긴다.
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PmPlanOutputSchema, type PmPlanOutput } from '@ai-office/shared';
import { planOutput } from '../src/brains/mock.ts';
import { checkPlanRules, fixReviewers } from '../src/core/plans.ts';
import { approvals, employees, plans } from '../src/db/schema.ts';
import { approvalMessageFor } from '../src/discord/messages.ts';
import { roleCard } from '../src/staff/role-cards.ts';
import { orderUntilPlanApproval, setup } from './helpers.ts';

const base = planOutput().tickets[0]!;
const plan = (tickets: Partial<PmPlanOutput['tickets'][number]>[], over: Partial<PmPlanOutput> = {}) =>
  planOutput({ tickets: tickets.map((t, i) => ({ ...base, title: `일${i + 1}`, ...t })), ...over });

describe('fixReviewers', () => {
  it('문서 티켓: 같은 모델(claude) 검토자는 qa-local로', () => {
    const s = setup();
    const { out, changes } = fixReviewers(s.ctx, plan([{ type: 'writing', assignee: 'strategy', reviewer: 'pm' }]));
    expect(out.tickets[0]!.reviewer).toBe('qa-local');
    expect(changes).toEqual(['티켓 1(일1): 검토자 pm → qa-local (같은 모델 claude)']);
    expect(checkPlanRules(s.ctx, out)).toEqual([]);
  });

  it('코딩 티켓: 같은 모델(claude) 검토자는 reviewer(Codex)로', () => {
    const s = setup();
    const { out, changes } = fixReviewers(s.ctx, plan([{ type: 'coding', assignee: 'developer', reviewer: 'strategy' }]));
    expect(out.tickets[0]!.reviewer).toBe('reviewer');
    expect(changes).toEqual([expect.stringContaining('같은 모델 claude')]);
  });

  it('첫 후보가 담당자와 같은 모델이면 다음 후보로', () => {
    const s = setup();
    // qa-local(gemma) 담당 문서를 비서실장(gemma)이 검토 → qa-local은 본인이라 건너뛰고 reviewer
    const r1 = fixReviewers(s.ctx, plan([{ type: 'writing', assignee: 'qa-local', reviewer: 'chief-of-staff' }]));
    expect(r1.out.tickets[0]!.reviewer).toBe('reviewer');
    expect(r1.changes[0]).toContain('chief-of-staff은(는) 검토하지 않음');
    // reviewer(gpt) 담당 코딩을 reviewer 본인이 검토 → 코드는 로컬이 보지 않으므로 개발팀장(Claude) (7-3)
    const r2 = fixReviewers(s.ctx, plan([{ type: 'coding', assignee: 'reviewer', reviewer: 'reviewer' }]));
    expect(r2.out.tickets[0]!.reviewer).toBe('developer');
    expect(r2.changes[0]).toContain('담당자와 같음');
  });

  it('비서실장은 다른 모델이어도 검토자가 되지 않는다', () => {
    const s = setup();
    const { out } = fixReviewers(s.ctx, plan([{ type: 'writing', assignee: 'strategy', reviewer: 'chief-of-staff' }]));
    expect(out.tickets[0]!.reviewer).toBe('qa-local');
    expect(checkPlanRules(s.ctx, plan([{ type: 'writing', assignee: 'strategy', reviewer: 'chief-of-staff' }]))).toEqual([expect.stringContaining('검토하지 않음')]);
  });

  it('임시 직원 담당 티켓도 그 직원의 두뇌 모델로 고친다', () => {
    const s = setup();
    const { out, changes } = fixReviewers(
      s.ctx,
      plan([{ type: 'writing', assignee: 'temp:writer-1', reviewer: 'marketing' }], { tempStaff: [{ key: 'writer-1', kind: 'writer', reason: '긴 안내문' }] }),
    );
    // 7-2부터 로컬은 Gemma 하나라 qa-local도 같은 모델 → 다음 후보 GPT 리뷰어
    expect(out.tickets[0]!.reviewer).toBe('reviewer');
    expect(changes[0]).toContain('같은 모델 gemma4:12b-64k');
  });

  it('맞는 짝과 없는 직원은 건드리지 않는다 (없는 직원은 규칙 검사가 PM에게 돌려보냄)', () => {
    const s = setup();
    const ok = plan([{ type: 'coding', assignee: 'developer', reviewer: 'reviewer' }]);
    expect(fixReviewers(s.ctx, ok)).toEqual({ out: ok, changes: [] });
    const ghost = plan([{ type: 'writing', assignee: 'marketing', reviewer: 'ghost' }]);
    expect(fixReviewers(s.ctx, ghost).changes).toEqual([]);
    expect(checkPlanRules(s.ctx, fixReviewers(s.ctx, ghost).out)).toEqual([expect.stringContaining('검토자 ghost')]);
  });
});

describe('계획서에 반영', () => {
  it('PM이 같은 모델 검토자를 골라도 다시 시키지 않고 고쳐서 결재에 올린다. 결재 메시지에 보인다', async () => {
    const s = setup({ handlers: { plan: () => plan([{ type: 'writing', assignee: 'strategy', reviewer: 'pm', acceptanceCriteria: ['자기소개 항목 포함'] }], { projectId: undefined }) } });
    const { order, approval } = await orderUntilPlanApproval(s);
    expect(s.mock.callsFor('plan')).toHaveLength(1);
    const p = s.db.select().from(plans).where(eq(plans.orderId, order.id)).get()!;
    expect(p.tickets[0]!.reviewer).toBe('qa-local');
    expect(p.reviewerChanges).toEqual(['티켓 1(일1): 검토자 pm → qa-local (같은 모델 claude)']);
    const a = s.db.select().from(approvals).where(eq(approvals.id, approval!.id)).get()!;
    const msg = approvalMessageFor(a, p, null).content;
    expect(msg).toContain('검토자 자동 변경');
    expect(msg).toContain('pm → qa-local');
  });

  it('고친 것이 없으면 결재 메시지에 표시하지 않는다', async () => {
    const s = setup();
    const { order, approval } = await orderUntilPlanApproval(s);
    const p = s.db.select().from(plans).where(eq(plans.orderId, order.id)).get()!;
    expect(p.reviewerChanges).toEqual([]);
    const a = s.db.select().from(approvals).where(eq(approvals.id, approval!.id)).get()!;
    expect(approvalMessageFor(a, p, null).content).not.toContain('검토자 자동 변경');
  });

  it('PM 역할 카드의 검토자 표에 비서실장이 후보로 나오지 않는다', () => {
    const s = setup();
    const pm = s.db.select().from(employees).where(eq(employees.id, 'pm')).get()!;
    const table = roleCard(s.ctx, pm, 'plan', PmPlanOutputSchema).split('## 6.')[1]!;
    expect(table).not.toMatch(/검토:[^\n]*chief-of-staff/);
  });
});
