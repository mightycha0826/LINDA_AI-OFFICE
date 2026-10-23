// 계획 단계 (6장 PM, 7장 관문): 기획실장이 계획서를 쓰고, 필요하면 디자인 조합을 고르고, GPT 관문이 검사한다.
// 상태 전환은 core/plans.ts의 규칙 함수만 한다. 형식 오류·호출 실패가 두 번이면 멈추고 CEO의 [다시 시도]를 기다린다.
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { brainModel, ConsultOutputSchema, DesignComboOutputSchema, GateOutputSchema, PmClarificationOutputSchema, PmPlanOutputSchema } from '@ai-office/shared';
import { BrainError } from '../brains/brain.ts';
import { referencedRecords } from '../chief/reads.ts';
import { snowflakeAt, type ChatLine, type SecretaryChatReader } from '../chief/secretary-chat.ts';
import { emit, getState, inTx, setState, type Ctx } from '../context.ts';
import { isGuest } from '../core/budget.ts';
import { askClarification, clarificationKey, clarificationOf, consultRounds, MAX_CONSULT_ROUNDS, orderChannelKey, recordConsultation } from '../core/clarifications.ts';
import { recordMessage } from '../core/guards.ts';
import { memoryFor } from '../core/memory.ts';
import type { OrderRow } from '../core/orders.ts';
import { checkPlanRules, createPlanVersion, fixReviewers, GATE_REVIEWER_ID, latestPlan, recordGateResult, setDesignCombo, startGateReview, type PlanRow } from '../core/plans.ts';
import { employees, orders } from '../db/schema.ts';
import { FormatError } from '../errors.ts';
import { ASSIGNABLE_ASSISTANTS } from '../staff/assistants.ts';
import { designComboTable } from '../staff/design-combos.ts';
import { dismissTemp, hireTemp, needsDesignCombo } from '../staff/temp-staff.ts';
import { findProject, listProjects, type ProjectRow } from '../workspace/projects.ts';
import type { Workspace } from '../workspace/worktrees.ts';
import { isCloud, isQuiet, type BrainCalls } from './brain-calls.ts';

/** 계획 작성이 멈춘 지시의 상태 키. 값은 { issues, at } (at: 멈춘 시각, #막힘 알림 기준) */
export const planBlockedKey = (orderId: string) => `planBlocked:${orderId}`;
/** PM이 저장소에 관해 먼저 묻는 동료 (개발팀장, Claude) */
export const CONSULTANT_ID = 'developer';

export class Planning {
  private readonly c: Ctx;
  private readonly calls: BrainCalls;
  private readonly workspace: Workspace;
  private readonly log: (line: string) => void;
  private readonly readChat: SecretaryChatReader | null;

  constructor(o: { c: Ctx; calls: BrainCalls; workspace: Workspace; log: (line: string) => void; readSecretaryChat?: SecretaryChatReader }) {
    this.c = o.c;
    this.calls = o.calls;
    this.workspace = o.workspace;
    this.log = o.log;
    this.readChat = o.readSecretaryChat ?? null;
  }

  /** 지시 하나의 계획을 한 걸음 진행한다. 한 일이 있으면 true */
  async advance(orderId: string): Promise<boolean> {
    const c = this.c;
    if (getState<unknown>(c, planBlockedKey(orderId), null)) return false; // 형식 오류로 멈춤. CEO가 다시 시도해야 한다
    const plan = latestPlan(c, orderId);
    try {
      if (clarificationOf(c, orderId).rounds.at(-1)?.answer === null) return false;
      if (plan?.questions.length && ['draft', 'gate-review', 'revision-requested'].includes(plan.status)) {
        askClarification(c, orderId, plan.questions);
        return true;
      }
      if (plan?.status === 'draft') {
        // 디자인 시스템 담당이 필요하면 관문 전에 조합부터 고른다 (6장)
        if (needsDesignCombo(plan.tempStaff) && !plan.designCombo) await this.chooseDesignCombo(plan);
        else startGateReview(c, plan.id);
        return true;
      }
      if (plan?.status === 'gate-review') return await this.gate(plan);
      if (plan && !['revision-requested', 'superseded'].includes(plan.status)) return false;
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
      // 파견 직원(친구 계정)은 출근 중일 때만, 담당으로만 보여 준다 (8장 2026-10-21)
      .filter((e) => e.brain.provider !== 'none' && (e.role !== 'assistant' || ASSIGNABLE_ASSISTANTS.includes(e.id)) && !(isGuest(e) && e.leftAt))
      .map((e) => ({ id: e.id, role: e.role, brain: e.brain, ...(isGuest(e) ? { guest: '파견 직원: 담당만 맡고 검토는 하지 않음' } : {}) }));
    // 프로젝트 채널에서 온 지시면 그 프로젝트 하나만 보여 준다 (6장 PM)
    const projects = listProjects(c)
      .filter((p) => !order.projectId || p.id === order.projectId)
      .map((p) => ({ id: p.id, repoUrl: p.repoUrl, testCommand: p.testCommand }));
    const afterGateRejection = !!plan && plan.ceoNote === null;
    const project = this.projectFor(order);
    const knowledge = await this.knowledge(order, project?.id ?? null);
    const input = {
      order: { id: order.id, rawText: order.rawText },
      staff,
      projects,
      ...knowledge,
      clarifications: clarificationOf(c, orderId).rounds,
      ...(order.projectId ? { fixedProjectId: order.projectId } : {}),
      ...(plan && !afterGateRejection ? { ceoNote: plan.ceoNote ?? '' } : {}),
      ...(plan && afterGateRejection ? { gateIssues: plan.gateResult?.issues ?? [] } : {}),
    };
    const clarification = clarificationOf(c, orderId);
    if (!clarification.ready || (plan?.status === 'revision-requested' && plan.ceoNote && getState(c, `clarifiedRevision:${orderId}`, '') !== plan.id)) {
      const canAskDeveloper = !!project && consultRounds(clarification) < MAX_CONSULT_ROUNDS;
      const assessment = await this.calls.call(pm, 'clarify', PmClarificationOutputSchema, { ...input, canAskDeveloper }, { orderId }, {
        ...(isCloud(pm) ? { workdir: this.workspace.sandbox(`clarify-${orderId}`) } : {}),
      });
      // 저장소를 보면 알 수 있는 것은 개발팀장에게 먼저 묻고, 답을 받으면 PM이 다시 판단한다 (2026-10-23 CEO 결정)
      const forDeveloper = canAskDeveloper ? assessment.askDeveloper ?? [] : [];
      if (forDeveloper.length && project && (await this.consult(order, project, forDeveloper, knowledge))) return true;
      const questions = [...assessment.questions, ...forDeveloper];
      if (questions.length) askClarification(c, orderId, questions);
      else {
        setState(c, clarificationKey(orderId), { ...clarification, ready: true });
        if (plan) setState(c, `clarifiedRevision:${orderId}`, plan.id);
      }
      return true;
    }
    const out = await this.calls.call(pm, 'plan', PmPlanOutputSchema, input, { orderId }, {
      check: (o: z.infer<typeof PmPlanOutputSchema>) => o.questions.length ? [] : checkPlanRules(c, fixReviewers(c, o).out, order.projectId),
      // 클라우드 PM(7-1부터 Claude)은 빈 샌드박스에서 읽기 전용으로 쓴다
      ...(isCloud(pm) ? { workdir: this.workspace.sandbox(`plan-${orderId}`) } : {}),
    });
    if (out.questions.length) {
      askClarification(c, orderId, out.questions);
      return true;
    }
    const created = createPlanVersion(c, orderId, out, { afterGateRejection });
    if (!needsDesignCombo(created.tempStaff)) startGateReview(c, created.id);
    this.log(`${created.id} v${created.version} 작성`);
    return true;
  }

  /** 지시의 프로젝트: 정해져 있으면 그것, 아니면 글에 이름이 하나만 나온 프로젝트, 등록된 게 하나뿐이면 그것 */
  private projectFor(order: OrderRow): ProjectRow | null {
    if (order.projectId) return findProject(this.c, order.projectId);
    const all = listProjects(this.c);
    const text = [order.rawText, ...clarificationOf(this.c, order.id).rounds.map((r) => r.answer ?? '')].join('\n');
    const named = all.filter((p) => new RegExp(`(^|[^a-z0-9-])${p.id}([^a-z0-9-]|$)`, 'i').test(text));
    return named.length === 1 ? named[0]! : all.length === 1 ? all[0]! : null;
  }

  /** 직원끼리 아는 것: 회사 기억, 글에 적힌 티켓·지시 기록, #비서실 대화 (2026-10-23 CEO 결정) */
  private async knowledge(order: OrderRow, projectId: string | null) {
    const answers = clarificationOf(this.c, order.id).rounds.map((r) => r.answer ?? '').join('\n');
    return {
      memory: memoryFor(this.c, projectId),
      references: referencedRecords(this.c, `${order.rawText}\n${answers}`, [order.id]),
      secretaryChat: await this.secretaryChat(order),
    };
  }

  /** #비서실에서 온 지시면 그 직전 대화. 처음 한 번만 읽어 저장한다. 못 읽으면 대화 없이 진행 */
  private async secretaryChat(order: OrderRow): Promise<ChatLine[]> {
    const c = this.c;
    const key = `secretaryChat:${order.id}`;
    const saved = getState<ChatLine[] | null>(c, key, null);
    if (saved) return saved;
    const secretary = c.config.discord.channels.secretary;
    if (!this.readChat || !secretary || getState<string | null>(c, orderChannelKey(order.id), null) !== secretary) return [];
    try {
      const lines = await this.readChat(snowflakeAt(order.createdAt));
      setState(c, key, lines);
      return lines;
    } catch (err) {
      this.log(`${order.id} #비서실 대화를 읽지 못해 없이 진행: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * PM이 저장소에 관해 개발팀장에게 먼저 묻는다(읽기 전용, 프로젝트 최신 상태). 답을 기록했으면 true.
   * 개발 몫이 없으면 false(사장님께 여쭌다). 답을 받지 못해도 한 번으로 세고 사장님께 여쭌다.
   */
  private async consult(order: OrderRow, project: ProjectRow, questions: string[], knowledge: Awaited<ReturnType<Planning['knowledge']>>): Promise<boolean> {
    const dev = this.calls.employee(CONSULTANT_ID);
    if (this.calls.spendMode(dev) !== 'ok') return false;
    try {
      const workdir = await this.workspace.readView(project);
      const out = await this.calls.call(dev, 'consult', ConsultOutputSchema, { order: { id: order.id, rawText: order.rawText }, questions, workdir, ...knowledge }, { orderId: order.id }, { workdir });
      recordConsultation(this.c, order.id, questions, out.answers.map((a) => `${a.question}\n→ ${a.known ? '' : '(모름) '}${a.answer}`).join('\n\n'));
      this.log(`${order.id} PM → 개발팀장 질문 ${questions.length}개 답 받음`);
      return true;
    } catch (err) {
      if (isQuiet(err)) throw err;
      recordConsultation(this.c, order.id, questions, `(개발팀장이 답하지 못함: ${(err as Error).message.slice(0, 200)})`);
      this.log(`${order.id} 개발팀장 질문 실패, 사장님께 여쭘: ${(err as Error).message}`);
      return false;
    }
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
