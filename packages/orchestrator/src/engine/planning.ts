// 계획 단계 (6장 PM, 7장 관문): 기획실장이 계획서를 쓰고, 필요하면 디자인 조합을 고르고, GPT 관문이 검사한다.
// 상태 전환은 core/plans.ts의 규칙 함수만 한다. 형식 오류·호출 실패가 두 번이면 멈추고 CEO의 [다시 시도]를 기다린다.
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { brainModel, DesignComboOutputSchema, GateOutputSchema, PmPlanOutputSchema } from '@ai-office/shared';
import { BrainError } from '../brains/brain.ts';
import { emit, getState, inTx, setState, type Ctx } from '../context.ts';
import { recordMessage } from '../core/guards.ts';
import { checkPlanRules, createPlanVersion, fixReviewers, GATE_REVIEWER_ID, latestPlan, recordGateResult, setDesignCombo, startGateReview, type PlanRow } from '../core/plans.ts';
import { employees, orders } from '../db/schema.ts';
import { FormatError } from '../errors.ts';
import { ASSIGNABLE_ASSISTANTS } from '../staff/assistants.ts';
import { designComboTable } from '../staff/design-combos.ts';
import { dismissTemp, hireTemp, needsDesignCombo } from '../staff/temp-staff.ts';
import { listProjects } from '../workspace/projects.ts';
import type { Workspace } from '../workspace/worktrees.ts';
import { isCloud, isQuiet, type BrainCalls } from './brain-calls.ts';

/** 계획 작성이 멈춘 지시의 상태 키. 값은 { issues, at } (at: 멈춘 시각, #막힘 알림 기준) */
export const planBlockedKey = (orderId: string) => `planBlocked:${orderId}`;

export class Planning {
  private readonly c: Ctx;
  private readonly calls: BrainCalls;
  private readonly workspace: Workspace;
  private readonly log: (line: string) => void;

  constructor(o: { c: Ctx; calls: BrainCalls; workspace: Workspace; log: (line: string) => void }) {
    this.c = o.c;
    this.calls = o.calls;
    this.workspace = o.workspace;
    this.log = o.log;
  }

  /** 지시 하나의 계획을 한 걸음 진행한다. 한 일이 있으면 true */
  async advance(orderId: string): Promise<boolean> {
    const c = this.c;
    if (getState<unknown>(c, planBlockedKey(orderId), null)) return false; // 형식 오류로 멈춤. CEO가 다시 시도해야 한다
    const plan = latestPlan(c, orderId);
    try {
      if (plan?.status === 'draft') {
        // 디자인 시스템 담당이 필요하면 관문 전에 조합부터 고른다 (6장)
        if (needsDesignCombo(plan.tempStaff) && !plan.designCombo) await this.chooseDesignCombo(plan);
        else startGateReview(c, plan.id);
        return true;
      }
      if (plan?.status === 'gate-review') return await this.gate(plan);
      if (plan && plan.status !== 'revision-requested') return false;
      return await this.write(orderId, plan);
    } catch (err) {
      if (isQuiet(err)) {
        this.calls.handleQuietFailure(err, this.calls.employee(plan?.status === 'gate-review' ? GATE_REVIEWER_ID : 'pm'));
        return false;
      }
      if (err instanceof FormatError || err instanceof BrainError) {
        this.block(orderId, err instanceof FormatError ? err.issues : err.message);
        return true;
      }
      throw err;
    }
  }

  /** GPT 관문 검사. GPT 소진이나 인터넷 끊김이면 기다린다 */
  private async gate(plan: PlanRow): Promise<boolean> {
    const gate = this.calls.employee(GATE_REVIEWER_ID);
    if (this.calls.spendMode(gate) !== 'ok') return false;
    // 직원별 모델 표를 함께 넘긴다: 관문이 "담당·검토 모델을 알 수 없다"며 반려하던 문제 (7-1)
    const out = await this.calls.call(gate, 'gate', GateOutputSchema, { plan, staffModels: this.staffModels() }, { orderId: plan.orderId }, { workdir: this.workspace.sandbox(`gate-${plan.orderId}`) });
    const outcome = recordGateResult(this.c, plan.id, out);
    this.log(`${plan.id} v${plan.version} 관문: ${outcome}`);
    return true;
  }

  /** 기획실장이 계획서를 쓴다(처음, CEO 수정 요청 뒤, 관문 반려 뒤) */
  private async write(orderId: string, plan: PlanRow | undefined): Promise<boolean> {
    const c = this.c;
    const pm = this.calls.employee('pm');
    if (this.calls.spendMode(pm) !== 'ok') return false;
    const order = c.db.select().from(orders).where(eq(orders.id, orderId)).get()!;
    // 기획실장에게는 티켓을 맡을 수 있는 직원만 보여 준다 (보조 직원은 초안 작가만, 16장 7-5)
    const staff = c.db
      .select()
      .from(employees)
      .all()
      .filter((e) => e.brain.provider !== 'none' && (e.role !== 'assistant' || ASSIGNABLE_ASSISTANTS.includes(e.id)))
      .map((e) => ({ id: e.id, role: e.role, brain: e.brain }));
    // 프로젝트 채널에서 온 지시면 그 프로젝트 하나만 보여 준다 (6장 PM)
    const projects = listProjects(c)
      .filter((p) => !order.projectId || p.id === order.projectId)
      .map((p) => ({ id: p.id, repoUrl: p.repoUrl, testCommand: p.testCommand }));
    const afterGateRejection = !!plan && plan.ceoNote === null;
    const input = {
      order: { id: order.id, rawText: order.rawText },
      staff,
      projects,
      ...(order.projectId ? { fixedProjectId: order.projectId } : {}),
      ...(plan && !afterGateRejection ? { ceoNote: plan.ceoNote ?? '' } : {}),
      ...(plan && afterGateRejection ? { gateIssues: plan.gateResult?.issues ?? [] } : {}),
    };
    const out = await this.calls.call(pm, 'plan', PmPlanOutputSchema, input, { orderId }, {
      check: (o: z.infer<typeof PmPlanOutputSchema>) => checkPlanRules(c, fixReviewers(c, o).out, order.projectId),
      // 클라우드 PM(7-1부터 Claude)은 빈 샌드박스에서 읽기 전용으로 쓴다
      ...(isCloud(pm) ? { workdir: this.workspace.sandbox(`plan-${orderId}`) } : {}),
    });
    const created = createPlanVersion(c, orderId, out, { afterGateRejection });
    if (!needsDesignCombo(created.tempStaff)) startGateReview(c, created.id);
    this.log(`${created.id} v${created.version} 작성`);
    return true;
  }

  /** 형식 오류·호출 실패 두 번: 계획 작성을 멈추고 CEO의 [다시 시도]를 기다린다 (#막힘 알림은 notifier) */
  private block(orderId: string, issues: string): void {
    inTx(this.c, (t) => {
      // at: 멈춘 시각. 다시 시도 뒤 또 멈추면 #막힘에 새로 알리는 기준이 된다
      setState(t, planBlockedKey(orderId), { issues, at: t.clock.now().toISOString() });
      recordMessage(t, { orderId, fromId: 'orchestrator', kind: 'system', content: `계획 작성을 멈춤(다시 시도 필요): ${issues}` });
      emit(t, 'plan.status', { orderId, status: 'format-error' });
    });
  }

  /** 디자인 시스템 담당을 불러 조합을 고르고 바로 내보낸다 (6장, 2.5단계 결정 D). */
  private async chooseDesignCombo(plan: PlanRow): Promise<void> {
    const c = this.c;
    const req = plan.tempStaff.find((r) => r.kind === 'design-system')!;
    const ds = inTx(c, (t) => hireTemp(t, plan.orderId, req));
    const order = c.db.select().from(orders).where(eq(orders.id, plan.orderId)).get()!;
    try {
      const out = await this.calls.call(
        ds,
        'design',
        DesignComboOutputSchema,
        { order: { rawText: order.rawText }, plan: { goal: plan.goal, tickets: plan.tickets }, combos: designComboTable() },
        { orderId: plan.orderId },
      );
      setDesignCombo(c, plan.id, out);
    } finally {
      dismissTemp(c, ds.id);
    }
  }

  /** GPT 관문용: 상근 AI 직원의 모델 (담당·검토가 다른 모델인지 관문이 확인할 수 있게) */
  private staffModels(): { id: string; role: string; model: string }[] {
    return this.c.db
      .select()
      .from(employees)
      .all()
      .filter((e) => !e.isTemporary && e.brain.provider !== 'none')
      .map((e) => ({ id: e.id, role: e.role, model: brainModel(e.brain) }));
  }
}
