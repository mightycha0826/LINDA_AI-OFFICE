// 계획서 (DESIGN.md 5장 "지시 → 계획서 흐름", 6장 PM).
// - 지시당 버전이 올라가고, 새 버전이 생기면 이전 버전은 superseded가 된다. 이전 버전의 결재 버튼도 막힌다.
// - 최신 버전만 awaiting-ceo가 될 수 있다 (DB 부분 유일 인덱스로도 강제).
// - GPT 관문 반려는 최대 2회. 그다음에도 반려면 반대 의견을 붙여 CEO에게 올린다.
import { and, desc, eq, inArray } from 'drizzle-orm';
import { brainModel, type DesignComboOutput, type PmPlanOutput } from '@ai-office/shared';
import { emit, inTx, nextSeqId, nowIso, type Ctx } from '../context.ts';
import { employees, orders, plans, projects, tickets } from '../db/schema.ts';
import { NotFoundError, OfficeError, PlanRuleError } from '../errors.ts';
import { expirePendingApprovals, requestApproval, type ApprovalDecision } from './approvals.ts';
import { saveMinutes } from './meeting.ts';
import { applyTicketEvent } from './tickets.ts';
import { checkTempRules, dismissAllTemps, hireTemp, isTempRef, tempRef } from '../staff/temp-staff.ts';
import type { Actor } from './transitions.ts';
import { DS_LINT_CRITERION } from '../design/ds-lint.ts';

export type PlanRow = typeof plans.$inferSelect;

/** 관문 검사를 하는 직원 (GPT 감사관) */
export const GATE_REVIEWER_ID = 'reviewer';

const LIVE_STATUSES = ['draft', 'gate-review', 'awaiting-ceo', 'revision-requested'] as const;

export function getPlan(c: Ctx, id: string): PlanRow {
  const row = c.db.select().from(plans).where(eq(plans.id, id)).get();
  if (!row) throw new NotFoundError(`계획서 ${id}`);
  return row;
}

export function latestPlan(c: Ctx, orderId: string): PlanRow | undefined {
  return c.db.select().from(plans).where(eq(plans.orderId, orderId)).orderBy(desc(plans.version)).limit(1).get();
}

export function isLatestPlanVersion(c: Ctx, plan: PlanRow): boolean {
  return latestPlan(c, plan.orderId)?.id === plan.id;
}

/**
 * 계획서가 코드 규칙을 지키는지 검사한다 (6장 PM 제약 + 4장 불변 조건).
 * PM이 정한 배정이라도 규칙에 어긋나면 받지 않는다.
 */
export function checkPlanRules(c: Ctx, out: PmPlanOutput): string[] {
  const problems: string[] = [];
  // 다른 지시의 임시 직원은 배정할 수 없다. 임시 직원은 tempStaff와 "temp:<key>"로만 부른다.
  const staff = new Map(
    c.db
      .select()
      .from(employees)
      .all()
      .filter((e) => !e.isTemporary)
      .map((e) => [e.id, e]),
  );
  if (out.tickets.some((t) => t.type === 'coding')) {
    if (!out.projectId) problems.push('코딩 티켓이 있으면 projectId(등록된 프로젝트)가 필요함');
    else if (!c.db.select().from(projects).where(eq(projects.id, out.projectId)).get()) problems.push(`등록되지 않은 프로젝트: ${out.projectId}`);
  }
  problems.push(
    ...checkTempRules(out.tempStaff, out.tickets, (id) => {
      const r = staff.get(id);
      return r ? brainModel(r.brain) : null;
    }),
  );
  out.tickets.forEach((tk, i) => {
    const label = `티켓 ${i + 1}(${tk.title})`;
    if (isTempRef(tk.assignee)) {
      // 임시 직원 담당 티켓은 checkTempRules가 본다. 검토자만 확인한다.
      const r = staff.get(tk.reviewer);
      if (!r) problems.push(`${label}: 검토자 ${tk.reviewer}이(가) 없음`);
      else if (r.brain.provider === 'none') problems.push(`${label}: ${r.id}은(는) AI 직원이 아니라 검토자가 될 수 없음`);
      return;
    }
    const a = staff.get(tk.assignee);
    const r = staff.get(tk.reviewer);
    if (!a) problems.push(`${label}: 담당자 ${tk.assignee}이(가) 없음`);
    if (!r) problems.push(`${label}: 검토자 ${tk.reviewer}이(가) 없음`);
    if (!a || !r) return;
    if (a.brain.provider === 'none') problems.push(`${label}: ${a.id}은(는) AI 직원이 아니라 담당자가 될 수 없음`);
    if (r.brain.provider === 'none') problems.push(`${label}: ${r.id}은(는) AI 직원이 아니라 검토자가 될 수 없음`);
    if (a.id === r.id) problems.push(`${label}: 담당자와 검토자가 같음`);
    else if (brainModel(a.brain) === brainModel(r.brain)) {
      problems.push(`${label}: 담당자(${a.id})와 검토자(${r.id})가 같은 모델(${brainModel(a.brain)})임`);
    }
  });
  return problems;
}

/** 새 계획서 버전을 만든다. 살아 있는 이전 버전은 superseded로, 그 결재는 expired로. */
export function createPlanVersion(c: Ctx, orderId: string, out: PmPlanOutput, opts: { afterGateRejection: boolean }): PlanRow {
  return inTx(c, (t) => {
    const problems = checkPlanRules(t, out);
    if (problems.length) throw new PlanRuleError(problems);
    const order = t.db.select().from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError(`지시 ${orderId}`);
    if (!['planning', 'awaiting-plan-approval'].includes(order.status)) {
      throw new OfficeError('order-closed', `지시 ${orderId}는 계획을 받을 수 없는 상태예요(${order.status})`);
    }

    const prev = latestPlan(t, orderId);
    const live = t.db.select().from(plans).where(and(eq(plans.orderId, orderId), inArray(plans.status, [...LIVE_STATUSES]))).all();
    for (const p of live) {
      t.db.update(plans).set({ status: 'superseded' }).where(eq(plans.id, p.id)).run();
      expirePendingApprovals(t, 'plan', p.id);
      emit(t, 'plan.status', { planId: p.id, orderId, version: p.version, status: 'superseded' });
    }

    const plan = t.db
      .insert(plans)
      .values({
        id: nextSeqId(t, 'plans', 'P'),
        orderId,
        version: (prev?.version ?? 0) + 1,
        goal: out.goal,
        questions: out.questions,
        tickets: out.tickets,
        tempStaff: out.tempStaff,
        projectId: out.projectId ?? null,
        estimate: out.estimate,
        // 관문 반려 뒤 고친 버전은 반려 횟수를 이어 간다. CEO 수정 요청 뒤에는 새로 센다.
        gateAttempts: opts.afterGateRejection && prev ? prev.gateAttempts : 0,
        createdAt: nowIso(t),
      })
      .returning()
      .get();
    t.db.update(orders).set({ status: 'planning' }).where(eq(orders.id, orderId)).run();
    emit(t, 'plan.status', { planId: plan.id, orderId, version: plan.version, status: plan.status });
    return plan;
  });
}

/** 디자인 시스템 담당이 고른 조합을 초안에 붙인다 (CEO가 계획서와 함께 승인한다). */
/** 17장: 디자인 조합이 붙은 계획서의 개발(UI) 티켓에는 "디자인 시스템 lint 통과"가 자동으로 붙는다 */
export function withDesignLint(criteria: string[], type: string, hasDesign: boolean): string[] {
  if (!hasDesign || type !== 'coding' || criteria.includes(DS_LINT_CRITERION)) return criteria;
  return [...criteria, DS_LINT_CRITERION];
}

export function setDesignCombo(c: Ctx, planId: string, combo: DesignComboOutput): void {
  inTx(c, (t) => {
    const plan = getPlan(t, planId);
    if (plan.status !== 'draft') throw new OfficeError('plan-state', `디자인 조합은 초안에만 붙여요(${plan.status})`);
    t.db.update(plans).set({ designCombo: combo }).where(eq(plans.id, planId)).run();
    emit(t, 'plan.status', { planId, orderId: plan.orderId, version: plan.version, status: plan.status, designCombo: combo });
  });
}

export function startGateReview(c: Ctx, planId: string): PlanRow {
  return inTx(c, (t) => {
    const plan = getPlan(t, planId);
    if (plan.status !== 'draft') throw new OfficeError('plan-state', `관문 검사는 초안에서만 시작해요(${plan.status})`);
    t.db.update(plans).set({ status: 'gate-review' }).where(eq(plans.id, planId)).run();
    emit(t, 'plan.status', { planId, orderId: plan.orderId, version: plan.version, status: 'gate-review' });
    return getPlan(t, planId);
  });
}

export type GateOutcome = 'to-ceo' | 'revise' | 'to-ceo-with-objection';

export function recordGateResult(c: Ctx, planId: string, gate: { passed: boolean; issues: string[]; objection: string | null }): GateOutcome {
  return inTx(c, (t) => {
    const plan = getPlan(t, planId);
    if (plan.status !== 'gate-review') throw new OfficeError('plan-state', `관문 결과는 관문 검사 중에만 받아요(${plan.status})`);
    if (!isLatestPlanVersion(t, plan)) throw new OfficeError('plan-state', '최신 버전이 아니에요');

    let outcome: GateOutcome;
    let gateResult = gate;
    if (gate.passed) {
      outcome = 'to-ceo';
    } else if (plan.gateAttempts < t.config.maxGateRejections) {
      outcome = 'revise';
    } else {
      outcome = 'to-ceo-with-objection';
      gateResult = { ...gate, objection: gate.objection?.trim() || gate.issues.join(' / ') };
    }

    const status = outcome === 'revise' ? 'revision-requested' : 'awaiting-ceo';
    t.db
      .update(plans)
      .set({ status, gateResult, gateAttempts: gate.passed ? plan.gateAttempts : plan.gateAttempts + 1 })
      .where(eq(plans.id, planId))
      .run();
    emit(t, 'plan.status', { planId, orderId: plan.orderId, version: plan.version, status, gate: gateResult });

    if (outcome !== 'revise') {
      t.db.update(orders).set({ status: 'awaiting-plan-approval' }).where(eq(orders.id, plan.orderId)).run();
      requestApproval(t, {
        kind: 'plan',
        targetId: planId,
        targetVersion: plan.version,
        reversible: 'reversible',
        summary: `계획서 #${plan.id} · v${plan.version} — ${plan.goal}${plan.designCombo ? ` · 디자인 조합 ${plan.designCombo.combo}(${plan.designCombo.mode})` : ''}`,
      });
      if (plan.gateAttempts > 0 || !gate.passed) saveGateMinutes(t, getPlan(t, planId));
    }
    return outcome;
  });
}

/**
 * 관문에서 반려를 주고받은 기록을 회의록 양식으로 남긴다 (5장 회의록).
 * 이번 관문 주기(CEO 수정 요청 뒤 첫 버전부터 지금까지)의 계획서 JSON에서 코드가 채운다.
 */
function saveGateMinutes(c: Ctx, current: PlanRow): void {
  const byVersion = new Map(c.db.select().from(plans).where(eq(plans.orderId, current.orderId)).all().map((p) => [p.version, p]));
  // 버전이 만들어질 때 이어받은 반려 횟수. 0보다 크면 관문 반려 뒤 고친 버전이라 앞 버전과 같은 주기다.
  const carried = (p: PlanRow) => p.gateAttempts - (p.gateResult && !p.gateResult.passed ? 1 : 0);
  const cycle: PlanRow[] = [current];
  for (let p = current; carried(p) > 0; ) {
    const prev = byVersion.get(p.version - 1);
    if (!prev) break;
    cycle.unshift(prev);
    p = prev;
  }
  const rejected = cycle.filter((p) => p.gateResult && !p.gateResult.passed);
  saveMinutes(c, {
    planId: current.id,
    kind: 'gate-review',
    participants: ['pm', GATE_REVIEWER_ID],
    agenda: rejected.flatMap((p) => p.gateResult!.issues.map((issue) => ({ criterion: `v${p.version}`, reason: issue, reasonCategory: 'criteria-unmet' as const }))),
    rounds: cycle.map((p, i) => ({
      round: i + 1,
      positions: [
        { employeeId: 'pm', claim: `v${p.version} 제출: ${p.goal}` },
        { employeeId: GATE_REVIEWER_ID, claim: p.gateResult ? (p.gateResult.passed ? '통과' : p.gateResult.issues.join(' / ')) : '검사 전' },
      ],
    })),
    outcome: current.gateResult?.passed ? 'agreed' : 'disagreed',
    nextActions: current.gateResult?.passed ? ['CEO 결재'] : [`GPT 반대 의견을 첨부해 CEO 결재: ${current.gateResult?.objection ?? ''}`],
  });
}

/** CEO의 계획서 결정을 반영한다. 승인되면 티켓을 만들고 planned → in_progress로 보낸다. */
export function applyCeoPlanDecision(c: Ctx, planId: string, decision: ApprovalDecision, note: string | null, ceo: Actor): void {
  const plan = getPlan(c, planId);
  if (plan.status !== 'awaiting-ceo') throw new OfficeError('plan-state', `CEO 결재 대기 중인 계획서가 아니에요(${plan.status})`);

  if (decision === 'revision') {
    // ceoNote가 null이 아니면 CEO 수정 요청이다(관문 반려와 구분). 내용이 없어도 빈 문자열로 남긴다.
    c.db.update(plans).set({ status: 'revision-requested', ceoNote: note ?? '' }).where(eq(plans.id, planId)).run();
    c.db.update(orders).set({ status: 'planning' }).where(eq(orders.id, plan.orderId)).run();
    emit(c, 'plan.status', { planId, orderId: plan.orderId, version: plan.version, status: 'revision-requested', ceoNote: note });
    return;
  }
  if (decision === 'rejected') {
    c.db.update(plans).set({ status: 'rejected', ceoNote: note }).where(eq(plans.id, planId)).run();
    c.db.update(orders).set({ status: 'rejected' }).where(eq(orders.id, plan.orderId)).run();
    emit(c, 'plan.status', { planId, orderId: plan.orderId, version: plan.version, status: 'rejected' });
    dismissAllTemps(c, plan.orderId);
    return;
  }

  c.db.update(plans).set({ status: 'approved', ceoNote: note }).where(eq(plans.id, planId)).run();
  c.db.update(orders).set({ status: 'in-progress', projectId: plan.projectId }).where(eq(orders.id, plan.orderId)).run();
  emit(c, 'plan.status', { planId, orderId: plan.orderId, version: plan.version, status: 'approved' });

  // 임시 직원을 들인다 (디자인 시스템 담당은 계획 단계에서 이미 다녀갔다)
  const hired = new Map<string, string>();
  for (const req of plan.tempStaff) {
    if (req.kind === 'design-system') continue;
    hired.set(tempRef(req.key), hireTemp(c, plan.orderId, req).id);
  }
  const resolve = (id: string) => (isTempRef(id) ? hired.get(id) : id);

  const caps = c.config.ticketCaps;
  for (const tk of plan.tickets) {
    const assigneeId = resolve(tk.assignee);
    if (!assigneeId) throw new OfficeError('plan-rule', `고용되지 않은 임시 직원: ${tk.assignee}`);
    const id = nextSeqId(c, 'tickets', 'T');
    c.db
      .insert(tickets)
      .values({
        id,
        orderId: plan.orderId,
        planId,
        title: tk.title,
        type: tk.type,
        assigneeId,
        reviewerId: tk.reviewer,
        acceptanceCriteria: withDesignLint(tk.acceptanceCriteria, tk.type, !!plan.designCombo),
        needsCeoApproval: tk.needsCeoApproval,
        estimatedTokens: tk.estimatedTokens,
        tokenCap: Math.max(caps.minTokens, Math.ceil(tk.estimatedTokens * caps.tokenMultiplier)),
        turnCap: caps.maxTurns,
      })
      .run();
    emit(c, 'ticket.status', { ticketId: id, from: null, to: 'planned', event: 'ticket.created' });
    applyTicketEvent(c, id, { type: 'plan.approved' }, ceo);
  }
}
