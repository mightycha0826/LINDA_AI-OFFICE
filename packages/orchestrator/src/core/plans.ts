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
import { checkTempRules, dismissAllTemps, hireTemp, isTempRef, tempBrain, tempRef } from '../staff/temp-staff.ts';
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
 * boundProjectId: 프로젝트 #작업 채널에서 온 지시의 프로젝트. 비우면 코드가 채우고, 다른 프로젝트는 받지 않는다 (6장 PM)
 */
export function checkPlanRules(c: Ctx, out: PmPlanOutput, boundProjectId?: string | null): string[] {
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
  if (boundProjectId && out.projectId && out.projectId !== boundProjectId) {
    problems.push(`이 지시는 ${boundProjectId} 프로젝트 채널에서 왔으므로 projectId는 ${boundProjectId}여야 함 (비워도 됨)`);
  }
  const projectId = out.projectId ?? boundProjectId ?? null;
  if (out.tickets.some((t) => t.type === 'coding')) {
    if (!projectId) problems.push('코딩 티켓이 있으면 projectId(등록된 프로젝트)가 필요함');
    else if (!c.db.select().from(projects).where(eq(projects.id, projectId)).get()) problems.push(`등록되지 않은 프로젝트: ${projectId}`);
  }
  problems.push(
    ...checkTempRules(out.tempStaff, out.tickets, (id) => {
      const r = staff.get(id);
      return r ? brainModel(r.brain) : null;
    }),
  );
  out.tickets.forEach((tk, i) => {
    const label = `티켓 ${i + 1}(${tk.title})`;
    if (NOT_REVIEWERS.includes(tk.reviewer)) problems.push(`${label}: ${tk.reviewer}은(는) 티켓을 검토하지 않음`);
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
    if (a.id === r.id) problems.push(`${label}: 담당자와 검토자가 같음 → ${reviewerHint([...staff.values()], a)}`);
    else if (brainModel(a.brain) === brainModel(r.brain)) {
      problems.push(`${label}: 담당자(${a.id})와 검토자(${r.id})가 같은 모델(${brainModel(a.brain)})임 → ${reviewerHint([...staff.values()], a)}`);
    }
    // 코드는 클라우드 모델만 판정한다 (7장 7-3)
    if (tk.type === 'coding' && r.brain.provider === 'ollama') problems.push(`${label}: 코드는 로컬 모델이 검토하지 않음(${r.id}) → 개발팀장이나 리뷰어로`);
  });
  return problems;
}

type StaffRow = typeof employees.$inferSelect;

/** 티켓을 검토하지 않는 직원. 비서실장은 헤르메스 쪽 대화·보고 담당이다 (6장 PM) */
export const NOT_REVIEWERS: readonly string[] = ['chief-of-staff'];

/**
 * 검토자를 코드가 바꿀 때의 순서 (6장 PM, 2026-10-19 CEO 승인).
 * 코딩: 리뷰어(GPT) → 개발팀장(Claude). GPT 개발자의 코드는 첫 후보가 같은 모델이라 개발팀장이 본다(7-3). 로컬은 코드를 보지 않는다.
 * 그 밖: 검토 담당(Gemma) → 리뷰어(GPT).
 */
export const REVIEWER_ORDER: Record<'coding' | 'other', readonly string[]> = { coding: ['reviewer', 'developer'], other: ['qa-local', 'reviewer'] };

/** 담당자를 검토할 수 있는 직원: 상근 AI 직원 중 담당자와 다른 모델 (6장 PM) */
export function reviewerCandidates(staff: StaffRow[], assignee: StaffRow): StaffRow[] {
  return staff.filter(
    (r) => !r.isTemporary && r.brain.provider !== 'none' && !NOT_REVIEWERS.includes(r.id) && r.id !== assignee.id && brainModel(r.brain) !== brainModel(assignee.brain),
  );
}

/**
 * 검토자 짝을 코드가 고친다 (6장 PM). 검토자가 담당자와 같은 모델·담당자 본인·비서실장이면
 * REVIEWER_ORDER에서 담당자와 다른 모델인 첫 직원으로 바꾸고 기록을 남긴다.
 * 담당자나 검토자가 없는 직원이면 고치지 않는다(규칙 검사가 PM에게 돌려보낸다).
 */
export function fixReviewers(c: Ctx, out: PmPlanOutput): { out: PmPlanOutput; changes: string[] } {
  const staff = new Map(
    c.db
      .select()
      .from(employees)
      .all()
      .filter((e) => !e.isTemporary)
      .map((e) => [e.id, e]),
  );
  const temps = new Map(out.tempStaff.map((r) => [tempRef(r.key), r]));
  const changes: string[] = [];
  const tickets = out.tickets.map((tk, i) => {
    const temp = temps.get(tk.assignee);
    const assignee = staff.get(tk.assignee);
    const model = temp ? brainModel(tempBrain(temp)) : assignee && assignee.brain.provider !== 'none' ? brainModel(assignee.brain) : null;
    const r = staff.get(tk.reviewer);
    if (!model || !r) return tk;
    const coding = tk.type === 'coding';
    const reason = NOT_REVIEWERS.includes(r.id)
      ? `${r.id}은(는) 검토하지 않음`
      : r.id === tk.assignee
        ? '담당자와 같음'
        : brainModel(r.brain) === model
          ? `같은 모델 ${model}`
          : coding && r.brain.provider === 'ollama'
            ? '로컬 모델은 코드를 검토하지 않음'
            : null;
    if (!reason) return tk;
    const pick = REVIEWER_ORDER[coding ? 'coding' : 'other'].find((id) => {
      const x = staff.get(id);
      return x && x.brain.provider !== 'none' && !(coding && x.brain.provider === 'ollama') && id !== tk.assignee && brainModel(x.brain) !== model;
    });
    if (!pick) return tk;
    changes.push(`티켓 ${i + 1}(${tk.title}): 검토자 ${r.id} → ${pick} (${reason})`);
    return { ...tk, reviewer: pick };
  });
  return { out: changes.length ? { ...out, tickets } : out, changes };
}

/** 규칙 위반을 고칠 때 PM이 바로 고를 수 있게 후보를 적어 준다 */
function reviewerHint(staff: StaffRow[], assignee: StaffRow): string {
  const ok = reviewerCandidates(staff, assignee).map((r) => `${r.id}(${brainModel(r.brain)})`);
  return ok.length ? `검토자를 이 중에서 고를 것: ${ok.join(', ')}` : '검토할 수 있는 다른 모델 직원이 없음';
}

/** 새 계획서 버전을 만든다. 살아 있는 이전 버전은 superseded로, 그 결재는 expired로. */
export function createPlanVersion(c: Ctx, orderId: string, pmOut: PmPlanOutput, opts: { afterGateRejection: boolean }): PlanRow {
  return inTx(c, (t) => {
    const order = t.db.select().from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError(`지시 ${orderId}`);
    // 검토자 짝은 코드가 먼저 고친다 (6장 PM). 나머지 위반은 그대로 PM에게 돌려보낸다
    const { out, changes: reviewerChanges } = fixReviewers(t, pmOut);
    const problems = checkPlanRules(t, out, order.projectId);
    if (problems.length) throw new PlanRuleError(problems);
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
        reviewerChanges,
        // 프로젝트 채널에서 온 지시는 PM이 비워도 그 프로젝트 (6장 PM)
        projectId: out.projectId ?? order.projectId ?? null,
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
  // 계획에 프로젝트가 없으면 지시의 프로젝트(프로젝트 채널에서 정해진 것)를 지우지 않는다
  c.db.update(orders).set({ status: 'in-progress', ...(plan.projectId ? { projectId: plan.projectId } : {}) }).where(eq(orders.id, plan.orderId)).run();
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
