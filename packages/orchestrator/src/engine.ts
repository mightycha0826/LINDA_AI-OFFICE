// 오케스트레이터 엔진. 직원 호출 순서를 돌리고, 결과를 core의 규칙 함수로만 반영한다.
// AI는 출력(JSON)만 낸다. 상태 전환, 결재, 한도, 상한 판단은 모두 core가 한다 (설계 원칙 1).
// 한 바퀴(step) 안에서 일은 동시에 시작되고, 실제 호출은 차선(Claude 1 · Codex 1 · GPU 대기열 1)이 줄을 세운다 (8장).
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  brainModel,
  LOCAL_MODEL,
  DevOutputSchema,
  DocOutputSchema,
  GateOutputSchema,
  MeetingPositionSchema,
  PmPlanOutputSchema,
  ProofreadOutputSchema,
  type ProofreadOutput,
  ReviewOutputSchema,
  DesignComboOutputSchema,
  SearchQueriesSchema,
  type DevOutput,
  type DocOutput,
  type TicketType,
} from '@ai-office/shared';
import { BrainError, type BrainTask, type TestRunner } from './brains/brain.ts';
import { Lanes } from './brains/lanes.ts';
import type { BrainFor } from './brains/registry.ts';
import { estimatePct } from './brains/usage-estimate.ts';
import { Connectivity } from './connectivity.ts';
import { decideApproval, requestApproval, type DecideInput } from './core/approvals.ts';
import { blockBudget, budgetOf, enforceBudgets, isExhausted, recordUsage, type EmployeeRow } from './core/budget.ts';
import { isOverCap, recordMessage, recordTurn } from './core/guards.ts';
import { agendaFromLastReview, concludeMeeting, saveMinutes, type RoundPositions } from './core/meeting.ts';
import { registerOrder } from './core/orders.ts';
import { checkPlanRules, createPlanVersion, fixReviewers, GATE_REVIEWER_ID, latestPlan, recordGateResult, setDesignCombo, startGateReview, type PlanRow } from './core/plans.ts';
import { designComboTable } from './staff/design-combos.ts';
import { dismissAllTemps, dismissTemp, hireTemp, needsDesignCombo } from './staff/temp-staff.ts';
import { claimLinks, createWeb, type Web } from './web/research.ts';
import { CommitDraftSchema, type CommitDraft, type CommitTicketInfo } from './gitcat/commit-message.ts';
import { resumeAll, stopAll } from './core/stop.ts';
import { applyTicketEvent, getTicket, type TicketRow } from './core/tickets.ts';
import type { TicketEvent } from './core/transitions.ts';
import { clearState, emit, getState, inTx, isStopped, setState, type Ctx } from './context.ts';
import { employees, messages, orders, tickets } from './db/schema.ts';
import { FormatError, NotCeoError, NotFoundError, OfficeError } from './errors.ts';
import { renderTask } from './staff/prompts.ts';
import { ASSIGNABLE_ASSISTANTS, queuePriorityOf } from './staff/assistants.ts';
import { roleCard } from './staff/role-cards.ts';
import { activeRuleRows, recordRuleApplications } from './retro/rules.ts';
import { listProjects } from './workspace/projects.ts';
import type { Workspace } from './workspace/worktrees.ts';

export interface EngineDeps {
  ctx: Ctx;
  /** 직원에게 맞는 두뇌 (brains/registry.ts). 테스트는 MockLLM. */
  brainFor: BrainFor;
  tests: TestRunner;
  workspace: Workspace;
  connectivity?: Connectivity;
  /** 웹 검색·근거 링크 읽기 (15장). 기본은 설정의 SearXNG와 fetchPage */
  web?: Web;
  log?: (line: string) => void;
}

interface CallOptions {
  check?: (out: never) => string[];
  lowPrecision?: boolean;
  workdir?: string;
  ticketType?: TicketType;
}

const orchestrator = { kind: 'orchestrator' } as const;
/** 교정 1차 점검을 하는 직원 (16장 7-4) */
const PROOFREADER_ID = 'qa-local';
const planBlockedKey = (orderId: string) => `planBlocked:${orderId}`;
const isCloud = (e: EmployeeRow) => e.brain.provider === 'claude-code' || e.brain.provider === 'codex';
/** 클라우드 직원의 호출 차선. 로컬 모델은 GPU 대기열이 따로 줄을 세운다 */
const laneOf = (e: EmployeeRow) => (e.brain.provider === 'claude-code' ? 'claude' : e.brain.provider === 'codex' ? 'codex' : null);
/** 인터넷 끊김·한도 도달: 직원 탓이 아니라 기다리면 풀리는 실패 */
const isQuiet = (err: unknown): err is BrainError => err instanceof BrainError && (err.failure === 'offline' || err.failure === 'limit');
/** 이미 멈췄거나 끝난 티켓은 다시 멈추지 않는다 */
const SETTLED: readonly string[] = ['paused', 'done', 'cancelled'];

export class Engine {
  private readonly c: Ctx;
  private readonly brainFor: BrainFor;
  private readonly tests: TestRunner;
  private readonly workspace: Workspace;
  readonly connectivity: Connectivity;
  private readonly web: Web;
  readonly lanes: Lanes;
  private readonly log: (line: string) => void;
  private readonly inFlight = new Set<string>();
  private controller = new AbortController();

  constructor(deps: EngineDeps) {
    this.c = deps.ctx;
    this.brainFor = deps.brainFor;
    this.tests = deps.tests;
    this.workspace = deps.workspace;
    this.connectivity = deps.connectivity ?? new Connectivity(deps.ctx);
    this.lanes = new Lanes({ claude: 1, codex: deps.ctx.config.codex.concurrency });
    this.web = deps.web ?? createWeb(deps.ctx.config);
    this.log = deps.log ?? (() => {});
  }

  // --- 바깥(결재 봇, 비서실장)에서 들어오는 요청 ----------------------------

  submitOrder(input: { discordMessageId: string; rawText: string; projectId?: string }) {
    return registerOrder(this.c, input);
  }

  decide(input: DecideInput) {
    return decideApproval(this.c, input);
  }

  /** #막힘의 [다시 시도] [방향 지시] [취소] */
  ceoTicketAction(ticketId: string, discordUserId: string, action: 'retry' | 'direct' | 'cancel', note = '') {
    const ev: TicketEvent = action === 'retry' ? { type: 'ceo.retry' } : action === 'direct' ? { type: 'ceo.direct', note } : { type: 'ceo.cancel' };
    return applyTicketEvent(this.c, ticketId, ev, { kind: 'approval-bot', discordUserId });
  }

  /** 형식 오류로 멈춘 계획 작성을 CEO가 다시 시도시킨다. */
  retryPlanning(orderId: string, discordUserId: string): void {
    if (discordUserId !== this.c.config.ceoDiscordId) throw new NotCeoError();
    clearState(this.c, planBlockedKey(orderId));
  }

  /** 계획 작성이 멈춘 지시를 CEO가 취소한다(#막힘 [취소]). 아직 계획 단계인 지시만. */
  cancelBlockedOrder(orderId: string, discordUserId: string): void {
    if (discordUserId !== this.c.config.ceoDiscordId) throw new NotCeoError();
    inTx(this.c, (t) => {
      const order = t.db.select().from(orders).where(eq(orders.id, orderId)).get();
      if (!order) throw new NotFoundError(`지시 ${orderId}`);
      if (order.status !== 'planning') throw new OfficeError('order-closed', `${orderId}는 이미 계획 단계가 아니라 취소할 수 없어요(${order.status})`);
      t.db.update(orders).set({ status: 'cancelled' }).where(eq(orders.id, orderId)).run();
      clearState(t, planBlockedKey(orderId));
      recordMessage(t, { orderId, fromId: 'orchestrator', kind: 'system', content: 'CEO가 계획 작성이 멈춘 지시를 취소함' });
      emit(t, 'plan.status', { orderId, status: 'cancelled' });
    });
    dismissAllTemps(this.c, orderId);
  }

  /** /정지: 진행 중인 AI 호출(자식 프로세스 포함)을 끊고 모든 티켓을 멈춘다. */
  stop(discordUserId: string): string[] {
    return stopAll(this.c, discordUserId, () => {
      this.controller.abort();
      this.controller = new AbortController();
    });
  }

  resume(discordUserId: string): string[] {
    return resumeAll(this.c, discordUserId);
  }

  /**
   * 정기 보고문 관문 검사 (10장: 보고는 CEO에게 가기 전에 GPT 관문을 거친다).
   * GPT 한도가 없거나 연결이 끊겨 검사할 수 없으면 null ("관문 미통과"로 올린다).
   */
  async gateReport(report: string): Promise<z.infer<typeof GateOutputSchema> | null> {
    const gate = this.employee(GATE_REVIEWER_ID);
    if (this.spendMode(gate) !== 'ok') return null;
    try {
      return await this.callStructured(gate, 'gate', GateOutputSchema, { report }, {}, { workdir: this.workspace.sandbox('gate-report') });
    } catch (err) {
      if (isQuiet(err)) this.handleQuietFailure(err, gate);
      if (err instanceof BrainError || err instanceof FormatError) return null;
      throw err;
    }
  }

  /**
   * Git 고양이의 커밋 메시지 초안 (11장: 로컬은 초안만, 형식은 코드). 실패하면 null(기본 형식을 쓴다).
   * 7-5부터 커밋 서기(로컬 보조 직원)가 쓴다. 커밋 서기가 없는 예전 DB면 Git 고양이 이름으로 로컬 두뇌를 빌린다.
   */
  async draftCommit(info: CommitTicketInfo, diffStat: string): Promise<CommitDraft | null> {
    const scribe = this.c.db.select().from(employees).where(eq(employees.id, 'commit-scribe')).get();
    const drafter: EmployeeRow = scribe ?? { ...this.employee('git-cat'), brain: { provider: 'ollama', model: LOCAL_MODEL } };
    try {
      return await this.callStructured(drafter, 'commit', CommitDraftSchema, { ticket: { id: info.id, title: info.title, type: 'coding', acceptanceCriteria: info.acceptanceCriteria }, diffStat }, {});
    } catch {
      return null;
    }
  }

  /**
   * 회고(6단계)처럼 티켓 밖에서 직원을 부른다. 한도가 없거나 끊겼거나 형식 오류·호출 실패면 null.
   * 실패해도 티켓을 멈추지 않는다. 다음 바퀴에 다시 시도한다.
   */
  async callAs<S extends z.ZodType>(employeeId: string, task: BrainTask, schema: S, input: unknown, opts: { workdir?: string; check?: (o: z.infer<S>) => string[] } = {}): Promise<z.infer<S> | null> {
    const e = this.employee(employeeId);
    if (this.spendMode(e) !== 'ok') return null;
    try {
      return await this.callStructured(e, task, schema, input, {}, { workdir: this.workspace.sandbox(opts.workdir ?? `${task}-${employeeId}`), ...(opts.check ? { check: opts.check as (out: never) => string[] } : {}) });
    } catch (err) {
      if (isQuiet(err)) {
        this.handleQuietFailure(err, e);
        return null;
      }
      if (err instanceof BrainError) {
        this.log(`${employeeId} ${task} 실패: ${err.message}`);
        return null;
      }
      if (err instanceof FormatError) {
        this.log(`${employeeId} ${task} 형식 오류 2회: ${err.issues}`);
        return null;
      }
      throw err;
    }
  }

  // --- 한 바퀴 ----------------------------------------------------------------

  /** 할 수 있는 일을 한 바퀴 돈다. 실제로 한 일의 수를 돌려준다. */
  async step(): Promise<number> {
    if (isStopped(this.c)) return 0;
    let actions = (await this.connectivity.refresh()).length;
    const budget = enforceBudgets(this.c);
    actions += budget.paused.length + budget.resumed.length;

    const jobs: Promise<boolean>[] = [];
    for (const o of this.c.db.select().from(orders).where(eq(orders.status, 'planning')).all()) {
      jobs.push(this.once(`order:${o.id}`, () => this.advancePlanning(o.id)));
    }
    const active = this.c.db
      .select()
      .from(tickets)
      .where(inArray(tickets.status, ['rework', 'in_progress', 'in_review', 'meeting']))
      .orderBy(sql`rowid`)
      .all();
    for (const tk of active) jobs.push(this.once(tk.id, () => this.advanceTicket(getTicket(this.c, tk.id))));

    let unexpected: unknown;
    for (const r of await Promise.allSettled(jobs)) {
      if (r.status === 'fulfilled') {
        if (r.value) actions++;
        continue;
      }
      const err = r.reason as Error;
      if (err.name === 'AbortError') continue;
      if (err instanceof OfficeError) {
        // 그사이 상태가 바뀌었거나(정지, 상한) 규칙이 거부함. 결과는 버리고 다음 바퀴에 다시 본다.
        this.log(err.message);
        continue;
      }
      unexpected ??= err;
    }
    if (unexpected) throw unexpected;
    return actions;
  }

  async runUntilIdle(maxSteps = 200): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxSteps; i++) {
      const n = await this.step();
      total += n;
      if (n === 0) return total;
    }
    throw new OfficeError('runaway', `${maxSteps}바퀴를 돌아도 끝나지 않았어요`);
  }

  /** 같은 대상의 일이 겹쳐 돌지 않게 한다. */
  private async once(key: string, fn: () => Promise<boolean>): Promise<boolean> {
    if (this.inFlight.has(key) || isStopped(this.c)) return false;
    this.inFlight.add(key);
    try {
      return await fn();
    } finally {
      this.inFlight.delete(key);
    }
  }

  // --- 계획 -------------------------------------------------------------------

  private async advancePlanning(orderId: string): Promise<boolean> {
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
      if (plan?.status === 'gate-review') {
        const gate = this.employee(GATE_REVIEWER_ID);
        if (this.spendMode(gate) !== 'ok') return false; // GPT 소진이나 인터넷 끊김: 관문 검사는 기다린다
        // 직원별 모델 표를 함께 넘긴다: 관문이 "담당·검토 모델을 알 수 없다"며 반려하던 문제 (7-1)
        const out = await this.callStructured(gate, 'gate', GateOutputSchema, { plan, staffModels: this.staffModels() }, { orderId }, { workdir: this.workspace.sandbox(`gate-${orderId}`) });
        const outcome = recordGateResult(c, plan.id, out);
        this.log(`${plan.id} v${plan.version} 관문: ${outcome}`);
        return true;
      }
      if (plan && plan.status !== 'revision-requested') return false;

      const pm = this.employee('pm');
      if (this.spendMode(pm) !== 'ok') return false;
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
      const out = await this.callStructured(pm, 'plan', PmPlanOutputSchema, input, { orderId }, {
        check: (o: z.infer<typeof PmPlanOutputSchema>) => checkPlanRules(c, fixReviewers(c, o).out, order.projectId),
        // 클라우드 PM(7-1부터 Claude)은 빈 샌드박스에서 읽기 전용으로 쓴다
        ...(isCloud(pm) ? { workdir: this.workspace.sandbox(`plan-${orderId}`) } : {}),
      });
      const created = createPlanVersion(c, orderId, out, { afterGateRejection });
      if (!needsDesignCombo(created.tempStaff)) startGateReview(c, created.id);
      this.log(`${created.id} v${created.version} 작성`);
      return true;
    } catch (err) {
      if (isQuiet(err)) {
        this.handleQuietFailure(err, this.employee(plan?.status === 'gate-review' ? GATE_REVIEWER_ID : 'pm'));
        return false;
      }
      if (err instanceof FormatError || err instanceof BrainError) {
        const issues = err instanceof FormatError ? err.issues : err.message;
        inTx(c, (t) => {
          // at: 멈춘 시각. 다시 시도 뒤 또 멈추면 #막힘에 새로 알리는 기준이 된다
          setState(t, planBlockedKey(orderId), { issues, at: t.clock.now().toISOString() });
          recordMessage(t, { orderId, fromId: 'orchestrator', kind: 'system', content: `계획 작성을 멈춤(다시 시도 필요): ${issues}` });
          emit(t, 'plan.status', { orderId, status: 'format-error' });
        });
        return true;
      }
      throw err;
    }
  }

  /** 디자인 시스템 담당을 불러 조합을 고르고 바로 내보낸다 (6장, 2.5단계 결정 D). */
  private async chooseDesignCombo(plan: PlanRow): Promise<void> {
    const c = this.c;
    const req = plan.tempStaff.find((r) => r.kind === 'design-system')!;
    const ds = inTx(c, (t) => hireTemp(t, plan.orderId, req));
    const order = c.db.select().from(orders).where(eq(orders.id, plan.orderId)).get()!;
    try {
      const out = await this.callStructured(
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

  // --- 티켓 -------------------------------------------------------------------

  private async advanceTicket(tk: TicketRow): Promise<boolean> {
    switch (tk.status) {
      case 'rework':
        applyTicketEvent(this.c, tk.id, { type: 'rework.started' }, orchestrator);
        return true;
      case 'in_progress':
        return this.work(tk);
      case 'in_review':
        return this.review(tk);
      case 'meeting':
        return this.meeting(tk);
      default:
        return false;
    }
  }

  /** 이 직원이 지금 AI를 부를 수 있는가. 리서치 몫 소진이면 로컬(저정밀)로 바꾼다. */
  private spendMode(e: EmployeeRow): 'ok' | 'low-precision' | 'wait' | 'offline' {
    const b = budgetOf(e);
    // 인터넷이 끊기면 클라우드 직원(개발자·리뷰어·경영전략)은 멈춘다 (3장)
    if (isCloud(e) && !this.connectivity.isOnline()) return 'offline';
    if (!b || b === 'local' || !isExhausted(this.c, b)) return 'ok';
    // 리서치 몫 소진 때 로컬로 바꾸는 것은 리서치 직원뿐. 기획실장(PM)은 기다린다(로컬 계획은 뒤에서 더 비싸다, 2-0)
    return b === 'research' && e.role !== 'pm' ? 'low-precision' : 'wait';
  }

  /** 인터넷이 끊겨 클라우드 직원이 일할 수 없으면 티켓을 멈춘다(연결되면 이어감). */
  private pauseIfOffline(tk: TicketRow, people: EmployeeRow[]): boolean {
    if (!people.some((p) => this.spendMode(p) === 'offline')) return false;
    applyTicketEvent(this.c, tk.id, { type: 'system.pause', reason: 'offline' }, orchestrator);
    return true;
  }

  /** 클라우드 직원이 일할 폴더: 코딩이면 worktree, 아니면 빈 샌드박스. 로컬 모델은 폴더가 필요 없다. */
  private workdirFor(tk: TicketRow, e: EmployeeRow, lowPrecision: boolean): string | undefined {
    if (!isCloud(e) || lowPrecision) return undefined;
    return getTicket(this.c, tk.id).worktreePath ?? this.workspace.sandbox(tk.id);
  }

  private async work(tk: TicketRow): Promise<boolean> {
    const c = this.c;
    const assignee = this.employee(tk.assigneeId);
    if (this.pauseIfOffline(tk, [assignee])) return true;
    const mode = this.spendMode(assignee);
    if (mode === 'wait') return false; // 개발 몫 소진은 enforceBudgets가 멈춘다
    if (this.pauseIfOverCap(tk)) return true;
    const lowPrecision = mode === 'low-precision';
    if (lowPrecision) this.markLowPrecision(tk);

    let worktree: string | undefined;
    if (tk.type === 'coding') {
      try {
        worktree = (await this.workspace.ensureWorktree(getTicket(c, tk.id))).path;
      } catch (err) {
        if (!(err instanceof OfficeError)) throw err;
        this.pauseSystemError(tk, `작업 공간 준비 실패: ${err.message}`);
        return true;
      }
    }

    let searchResults: unknown[] | undefined;
    // 웹 검색은 오케스트레이터가 대신 한다: 로컬·GPT 직원(웹 도구 없음, 15장 7-4). Claude는 자기 검색 도구가 있다
    if (assignee.canSearchWeb && (assignee.brain.provider !== 'claude-code' || lowPrecision)) {
      const found = await this.localSearch(tk, assignee, lowPrecision);
      if (!found || getTicket(c, tk.id).status !== 'in_progress') return true;
      searchResults = found;
    }

    const schema = tk.type === 'coding' ? DevOutputSchema : DocOutputSchema;
    const input = { ticket: this.ticketInput(tk), feedback: this.feedbackFor(tk), ...(worktree ? { worktree } : {}), ...(searchResults ? { searchResults } : {}) };
    const out = await this.ticketCall(tk, assignee, 'work', schema, input, { lowPrecision, ...this.dir(this.workdirFor(tk, assignee, lowPrecision)) });
    if (!out || getTicket(c, tk.id).status !== 'in_progress') return true; // 그사이 멈췄으면 결과는 버린다
    // 결과물 앞에 붙는 표시: 저정밀 모드, 초안 작가의 초안 (16장 7-5)
    const note = (lowPrecision ? '저정밀 모드로 작성됨\n' : '') + (ASSIGNABLE_ASSISTANTS.includes(assignee.id) ? '초안 작가의 초안 (다듬기 전)\n' : '');
    recordMessage(c, { ticketId: tk.id, orderId: tk.orderId, fromId: assignee.id, toId: tk.reviewerId, kind: 'handoff', content: note + JSON.stringify(out) });
    applyTicketEvent(c, tk.id, { type: 'ticket.submitted' }, { kind: 'employee', id: assignee.id });
    return true;
  }

  private async review(tk: TicketRow): Promise<boolean> {
    const c = this.c;
    const reviewer = this.employee(tk.reviewerId);
    if (this.pauseIfOffline(tk, [reviewer])) return true;
    const mode = this.spendMode(reviewer);
    if (mode === 'wait') return false; // GPT 소진: in_review에서 기다린다
    if (this.pauseIfOverCap(tk)) return true;
    const lowPrecision = mode === 'low-precision';

    // 테스트는 개발자의 말이 아니라 오케스트레이터가 직접 돌린 결과만 쓴다 (6장)
    const coding = tk.type === 'coding';
    const tests = coding ? await this.tests.run(tk.id, this.controller.signal) : null;
    const diff = coding ? await this.workspace.reviewDiff(getTicket(c, tk.id)) : '';
    const handoff = c.db
      .select()
      .from(messages)
      .where(and(eq(messages.ticketId, tk.id), eq(messages.kind, 'handoff')))
      .orderBy(desc(sql`rowid`))
      .limit(1)
      .get();
    const criteria = new Set(tk.acceptanceCriteria);
    const submission = submissionForReview(handoff?.content ?? '');
    // 문서 검토: 근거 링크 본문을 오케스트레이터가 직접 가져와 넘긴다 (15장 근거 규칙)
    const sources = coding ? [] : await this.readSources(submission);
    // 문서 티켓은 검토 전에 교정 담당이 1차 점검한다 (16장 7-4). 판정은 하지 않고, 실패해도 멈추지 않는다
    const proofread = coding ? null : await this.proofread(tk, submission);
    const out = await this.ticketCall(
      tk,
      reviewer,
      'review',
      ReviewOutputSchema,
      { ticket: this.ticketInput(tk), submission, tests, ...(diff ? { diff } : {}), ...(sources.length ? { sources } : {}), ...(proofread ? { proofread } : {}) },
      {
        lowPrecision,
        ...this.dir(this.workdirFor(tk, reviewer, lowPrecision)),
        // 반려는 작업 시작 전에 정해진 완료 조건으로만 판정한다
        check: (r: z.infer<typeof ReviewOutputSchema>) => {
          const judged = new Set(r.criteria.map((x) => x.criterion));
          return [
            ...[...judged].filter((x) => !criteria.has(x)).map((x) => `완료 조건에 없는 기준으로 판정함: ${x}`),
            ...[...criteria].filter((x) => !judged.has(x)).map((x) => `판정하지 않은 완료 조건: ${x}`),
          ];
        },
      },
    );
    if (!out || getTicket(c, tk.id).status !== 'in_review') return true; // 그사이 멈췄으면 결과는 버린다

    recordMessage(c, {
      ticketId: tk.id,
      orderId: tk.orderId,
      fromId: reviewer.id,
      toId: tk.assigneeId,
      kind: 'review',
      content: JSON.stringify(out),
      reviewVerdict: out.verdict,
      ...(out.reasonCategory ? { reasonCategory: out.reasonCategory } : {}),
    });
    if (getTicket(c, tk.id).status !== 'in_review') return true; // 핑퐁 차단으로 이미 옮겨짐
    const ev: TicketEvent = out.verdict === 'pass' ? { type: 'review.passed' } : { type: 'review.failed', reasonCategory: out.reasonCategory! };
    const d = applyTicketEvent(c, tk.id, ev, { kind: 'employee', id: reviewer.id });
    if (d.to === 'awaiting_approval') {
      requestApproval(c, {
        kind: tk.type === 'coding' ? 'deploy' : 'external-send',
        targetId: tk.id,
        reversible: 'partial',
        summary: `${tk.id} ${tk.title} — 검토 통과, CEO 결재 필요`,
      });
    }
    return true;
  }

  private async meeting(tk: TicketRow): Promise<boolean> {
    const c = this.c;
    const people = [this.employee(tk.assigneeId), this.employee(tk.reviewerId)];
    if (this.pauseIfOffline(tk, people)) return true;
    if (people.some((p) => this.spendMode(p) === 'wait')) return false;
    if (this.pauseIfOverCap(tk)) return true;

    const agenda = agendaFromLastReview(c, tk.id);
    const rounds: RoundPositions[] = [];
    for (let round = 1; round <= c.config.meetingMaxRounds; round++) {
      const positions: RoundPositions['positions'] = [];
      for (const p of people) {
        const lowPrecision = this.spendMode(p) === 'low-precision';
        const position = await this.ticketCall(
          tk,
          p,
          'meeting',
          MeetingPositionSchema,
          { ticket: this.ticketInput(tk), agenda, previousRounds: rounds },
          { lowPrecision, ...this.dir(this.workdirFor(tk, p, lowPrecision)) },
        );
        if (!position) return true;
        positions.push({ employeeId: p.id, position });
        const other = people.find((x) => x.id !== p.id)!;
        recordMessage(c, { ticketId: tk.id, orderId: tk.orderId, fromId: p.id, toId: other.id, kind: 'chat', content: JSON.stringify(position), countsForPingpong: false });
      }
      rounds.push({ round, positions });
      if (positions.every((p) => p.position.agree)) break;
    }

    // 회의록은 코드가 JSON에서 채운다. AI에게 요약을 시키지 않는다.
    const result = concludeMeeting(rounds);
    const minutes = saveMinutes(c, {
      ticketId: tk.id,
      kind: 'ticket-meeting',
      participants: people.map((p) => p.id),
      agenda,
      rounds: result.rounds,
      outcome: result.outcome,
      nextActions: result.nextActions,
    });
    recordMessage(c, {
      ticketId: tk.id,
      orderId: tk.orderId,
      fromId: 'orchestrator',
      kind: 'system',
      content: `회의록 ${minutes.id}: ${result.outcome === 'agreed' ? '합의' : '불합의'} · 다음 할 일 ${result.nextActions.join(', ') || '없음'}`,
      countsForPingpong: false,
    });
    if (getTicket(c, tk.id).status !== 'meeting') return true;
    applyTicketEvent(c, tk.id, { type: result.outcome === 'agreed' ? 'meeting.agreed' : 'meeting.failed' }, orchestrator);
    return true;
  }

  /**
   * 로컬 직원의 검색 (15장, 2.5단계 결정 C). 로컬 모델에게 도구 호출을 맡기지 않는다.
   * 1) 직원이 검색어를 정하고 2) 오케스트레이터가 SearXNG로 검색하고 3) 결과를 자료로 본 작업에 넘긴다.
   */
  private async localSearch(tk: TicketRow, e: EmployeeRow, lowPrecision: boolean): Promise<unknown[] | null> {
    const q = await this.ticketCall(tk, e, 'search', SearchQueriesSchema, { ticket: this.ticketInput(tk) }, { lowPrecision, ...this.dir(this.workdirFor(tk, e, lowPrecision)) });
    if (!q) return null;
    const results: unknown[] = [];
    let count = 0;
    for (const query of q.queries) {
      try {
        const found = await this.web.search.search(query, this.controller.signal);
        count += found.length;
        results.push({ query, results: found });
      } catch (err) {
        if (!(err instanceof OfficeError)) throw err;
        results.push({ query, error: err.message });
      }
    }
    recordMessage(this.c, { ticketId: tk.id, orderId: tk.orderId, fromId: 'orchestrator', toId: e.id, kind: 'system', content: `검색 ${q.queries.join(' / ')} → ${count}건`, countsForPingpong: false });
    return results;
  }

  /** 교정 1차 점검 (16장 7-4). 교정 담당 자신이 쓴 문서는 건너뛴다. 어떤 실패도 티켓을 멈추지 않는다(교정 없이 검토로) */
  private async proofread(tk: TicketRow, submission: unknown): Promise<ProofreadOutput | null> {
    if (tk.assigneeId === PROOFREADER_ID) return null;
    let out: ProofreadOutput | null;
    try {
      out = await this.callAs(PROOFREADER_ID, 'proofread', ProofreadOutputSchema, { ticket: this.ticketInput(tk), submission }, { workdir: `proofread-${tk.id}` });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      this.log(`${tk.id} 교정 실패(건너뜀): ${(err as Error).message}`);
      return null;
    }
    if (out) {
      recordMessage(this.c, { ticketId: tk.id, orderId: tk.orderId, fromId: PROOFREADER_ID, toId: tk.reviewerId, kind: 'chat', content: `교정 1차 점검: ${JSON.stringify(out)}`, countsForPingpong: false });
    }
    return out;
  }

  /** 제출물의 근거 링크를 가져온다. http(s)만, 내부 주소는 가지 않는다. 티켓당 최대 maxLinksPerTicket개. */
  private async readSources(submission: unknown): Promise<unknown[]> {
    const pages: unknown[] = [];
    for (const url of claimLinks(submission, this.c.config.web.maxLinksPerTicket)) {
      const p = await this.web.fetchPage(url, this.controller.signal);
      pages.push(p.ok ? { url, title: p.title, text: p.text, truncated: p.truncated ?? false } : { url, error: p.error ?? '가져오지 못함' });
    }
    return pages;
  }

  // --- 공통 -------------------------------------------------------------------

  /** GPT 관문용: 상근 AI 직원의 모델 (담당·검토가 다른 모델인지 관문이 확인할 수 있게) */
  private staffModels(): { id: string; role: string; model: string }[] {
    return this.c.db
      .select()
      .from(employees)
      .all()
      .filter((e) => !e.isTemporary && e.brain.provider !== 'none')
      .map((e) => ({ id: e.id, role: e.role, model: brainModel(e.brain) }));
  }

  private employee(id: string): EmployeeRow {
    const e = this.c.db.select().from(employees).where(eq(employees.id, id)).get();
    if (!e) throw new NotFoundError(`직원 ${id}`);
    return e;
  }

  private dir(workdir: string | undefined): { workdir?: string } {
    return workdir ? { workdir } : {};
  }

  private ticketInput(tk: TicketRow) {
    return { id: tk.id, title: tk.title, type: tk.type, acceptanceCriteria: tk.acceptanceCriteria };
  }

  /** 재작업이면 마지막 반려의 수정 요청, 회의 뒤면 회의 결론, CEO 방향 지시를 넘긴다. */
  private feedbackFor(tk: TicketRow): string[] {
    const recent = this.c.db
      .select()
      .from(messages)
      .where(and(eq(messages.ticketId, tk.id), inArray(messages.kind, ['review', 'system'])))
      .orderBy(desc(sql`rowid`))
      .limit(3)
      .all();
    return recent.map((m) => m.content);
  }

  private pauseIfOverCap(tk: TicketRow): boolean {
    if (!isOverCap(this.c, tk.id)) return false;
    applyTicketEvent(this.c, tk.id, { type: 'system.pause', reason: 'cap' }, orchestrator);
    return true;
  }

  private pauseSystemError(tk: TicketRow, message: string): void {
    recordMessage(this.c, { ticketId: tk.id, orderId: tk.orderId, fromId: 'orchestrator', kind: 'system', content: message, countsForPingpong: false });
    this.pauseUnlessSettled(tk, 'system-error');
  }

  /** 호출이 도는 사이 티켓이 멈췄거나 끝났을 수 있다. 그때는 그대로 둔다. */
  private pauseUnlessSettled(tk: TicketRow, reason: 'offline' | 'system-error'): void {
    if (SETTLED.includes(getTicket(this.c, tk.id).status)) return;
    applyTicketEvent(this.c, tk.id, { type: 'system.pause', reason }, orchestrator);
  }

  private markLowPrecision(tk: TicketRow): void {
    if (getTicket(this.c, tk.id).lowPrecision) return;
    this.c.db.update(tickets).set({ lowPrecision: true }).where(eq(tickets.id, tk.id)).run();
    emit(this.c, 'ticket.status', { ticketId: tk.id, from: tk.status, to: tk.status, event: 'low-precision' });
  }

  /** 인터넷 끊김은 연결 상태에, 한도 도달은 몫에 기록한다. 티켓 처리는 다음 바퀴의 규칙이 한다. */
  private handleQuietFailure(err: BrainError, e: EmployeeRow): void {
    if (err.failure === 'offline') this.connectivity.markOffline(err.message);
    if (err.failure === 'limit') {
      const b = budgetOf(e);
      if (b && b !== 'local') blockBudget(this.c, b, err.resetsAt);
    }
    this.log(err.message);
  }

  /** 티켓 작업 호출. 실패하면 종류에 맞게 티켓을 멈추고 null을 돌려준다. */
  private async ticketCall<S extends z.ZodType>(tk: TicketRow, e: EmployeeRow, task: BrainTask, schema: S, input: unknown, opts: CallOptions = {}): Promise<z.infer<S> | null> {
    try {
      return await this.callStructured(e, task, schema, input, { ticketId: tk.id, orderId: tk.orderId }, { ...opts, ticketType: tk.type });
    } catch (err) {
      if (err instanceof FormatError) {
        this.pauseSystemError(tk, `형식 오류 2회로 멈춤 (${e.id}): ${err.issues}`);
        return null;
      }
      if (isQuiet(err)) {
        this.handleQuietFailure(err, e);
        if (err.failure === 'offline') this.pauseUnlessSettled(tk, 'offline');
        return null;
      }
      if (err instanceof BrainError) {
        this.pauseSystemError(tk, `두뇌 호출 실패 2회로 멈춤 (${e.id}): ${err.message}`);
        return null;
      }
      if (err instanceof OfficeError && err.code === 'workdir') {
        this.pauseSystemError(tk, err.message);
        return null;
      }
      throw err;
    }
  }

  /**
   * AI를 부르고 출력을 Zod로 검사한다. 틀리면 오류를 붙여 한 번 다시 시키고, 또 틀리면 FormatError (6장).
   * 시간 초과·비정상 종료도 한 번 다시 시도한다. 호출마다 사용량과 티켓 턴·토큰을 기록한다.
   */
  private async callStructured<S extends z.ZodType>(
    e: EmployeeRow,
    task: BrainTask,
    schema: S,
    input: unknown,
    refs: { ticketId?: string; orderId?: string },
    opts: CallOptions = {},
  ): Promise<z.infer<S>> {
    const lowPrecision = opts.lowPrecision ?? false;
    const brain = this.brainFor(e, { lowPrecision });
    const budget = lowPrecision ? 'local' : (budgetOf(e) ?? 'local');
    const lane = lowPrecision ? null : laneOf(e);
    const system = roleCard(this.c, e, task, schema, opts.ticketType);
    // 회고 규칙 효과 측정(14장 6): 규칙이 붙은 채로 일한 대상(티켓, 계획이면 지시)을 센다
    const target = refs.ticketId ?? refs.orderId;
    if (target && (task === 'work' || task === 'plan' || task === 'review')) {
      recordRuleApplications(this.c, activeRuleRows(this.c, e.role, opts.ticketType).map((r) => r.id), target);
    }
    let previousError: string | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      let res;
      try {
        res = await this.lanes.run(lane, () =>
          brain.call({
            employee: e,
            task,
            schema,
            input,
            prompt: { system, user: renderTask(task, input, previousError) },
            attempt,
            lowPrecision,
            signal: this.controller.signal,
            // 로컬 GPU 줄 순위: 결재 직전 해설·요약이 먼저, 거울·회고는 뒤 (16장 7-5)
            priority: queuePriorityOf(e.id),
            ...refs,
            ...(opts.workdir ? { workdir: opts.workdir } : {}),
            ...(previousError ? { previousError } : {}),
          }),
        );
      } catch (err) {
        if (err instanceof BrainError && (err.failure === 'timeout' || err.failure === 'crash') && attempt === 1) {
          this.log(`${e.id} ${task} 실패(1회, 다시 시도): ${err.message}`);
          continue;
        }
        throw err;
      }
      const tokens = res.usage.inputTokens + res.usage.outputTokens;
      const est = estimatePct(this.c.config, budget, tokens);
      recordUsage(this.c, {
        budget,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        estimatedPct: res.usage.estimatedPct ?? est.fiveHour,
        estimatedWeeklyPct: res.usage.estimatedWeeklyPct ?? est.weekly,
        source: res.usage.source,
        ...(refs.ticketId ? { ticketId: refs.ticketId } : {}),
      });
      if (refs.ticketId) recordTurn(this.c, refs.ticketId, tokens);
      if (res.usage.account) setState(this.c, `account.${res.usage.account.provider}`, { ...res.usage.account, at: this.c.clock.now().toISOString() });

      const parsed = schema.safeParse(res.output);
      const problems = parsed.success ? ((opts.check as ((o: z.infer<S>) => string[]) | undefined)?.(parsed.data as z.infer<S>) ?? []) : [z.prettifyError(parsed.error)];
      if (problems.length === 0) return parsed.data as z.infer<S>;
      previousError = problems.join('\n');
      this.log(`${e.id} ${task} 형식 오류(${attempt}회): ${previousError}`);
    }
    throw new FormatError(previousError ?? '두뇌 호출이 두 번 실패했어요');
  }
}

/**
 * 리뷰어에게 넘길 제출물. 개발자의 자기 점검(criteriaSelfCheck)은 뺀다 (6장, 2단계 결정 B).
 * 판정이 개발자의 자기 평가에 끌려가지 않게 하기 위해서다.
 */
export function submissionForReview(content: string): unknown {
  const brace = content.indexOf('{');
  const note = brace > 0 ? content.slice(0, brace).trim() : '';
  try {
    const out = JSON.parse(brace >= 0 ? content.slice(brace) : content) as Record<string, unknown>;
    delete out.criteriaSelfCheck;
    return note ? { note, ...out } : out;
  } catch {
    return content;
  }
}

export type WorkOutput = DevOutput | DocOutput;
