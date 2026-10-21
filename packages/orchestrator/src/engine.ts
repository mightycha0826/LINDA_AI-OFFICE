// 오케스트레이터 엔진. 직원 호출 순서를 돌리고, 결과를 core의 규칙 함수로만 반영한다.
// AI는 출력(JSON)만 낸다. 상태 전환, 결재, 한도, 상한 판단은 모두 core가 한다 (설계 원칙 1).
// 한 바퀴(step) 안에서 일은 동시에 시작되고, 실제 호출은 차선(Claude 1 · Codex 2 · GPU 대기열 1)이 줄을 세운다 (8장).
//
// 나눈 곳 (2026-10-20 리팩터링):
// - engine/brain-calls.ts  AI 호출 계층: 차선, 재시도, 형식 검사, 사용량·턴 기록, 한도·연결 판단
// - engine/planning.ts     계획 단계: 기획실장 계획서, 디자인 조합, GPT 관문, 계획 멈춤
// - engine/ticket-work.ts  티켓 단계: 작업 · 검토(교정 1차 점검 포함) · 회의
// 이 파일은 바깥(결재 봇, 비서실장, Git 고양이, 회고)이 부르는 입구와 한 바퀴(step)만 둔다.
import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { GateOutputSchema, LOCAL_MODEL, StaffChatOutputSchema } from '@ai-office/shared';
import { BrainError, type BrainTask, type TestRunner } from './brains/brain.ts';
import { Lanes } from './brains/lanes.ts';
import type { BrainFor } from './brains/registry.ts';
import { Connectivity } from './connectivity.ts';
import { clearState, emit, inTx, isStopped, type Ctx } from './context.ts';
import { decideApproval, type DecideInput } from './core/approvals.ts';
import { enforceBudgets, type EmployeeRow } from './core/budget.ts';
import { recordMessage } from './core/guards.ts';
import { registerOrder } from './core/orders.ts';
import { GATE_REVIEWER_ID } from './core/plans.ts';
import { resumeAll, stopAll } from './core/stop.ts';
import { applyTicketEvent, getTicket } from './core/tickets.ts';
import type { TicketEvent } from './core/transitions.ts';
import { employees, orders, tickets } from './db/schema.ts';
import { BrainCalls, isQuiet } from './engine/brain-calls.ts';
import { Planning, planBlockedKey } from './engine/planning.ts';
import { TicketWork } from './engine/ticket-work.ts';
import { assertCeo, FormatError, NotFoundError, OfficeError } from './errors.ts';
import { CommitDraftSchema, type CommitDraft, type CommitTicketInfo } from './gitcat/commit-message.ts';
import { dismissAllTemps } from './staff/temp-staff.ts';
import { createWeb, type Web } from './web/research.ts';
import type { Workspace } from './workspace/worktrees.ts';

export { submissionForReview, type WorkOutput } from './engine/ticket-work.ts';

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

export class Engine {
  private readonly c: Ctx;
  private readonly workspace: Workspace;
  readonly connectivity: Connectivity;
  readonly lanes: Lanes;
  private readonly log: (line: string) => void;
  private readonly inFlight = new Set<string>();
  private readonly calls: BrainCalls;
  private readonly planning: Planning;
  private readonly ticketWork: TicketWork;

  constructor(deps: EngineDeps) {
    this.c = deps.ctx;
    this.workspace = deps.workspace;
    this.connectivity = deps.connectivity ?? new Connectivity(deps.ctx);
    this.lanes = new Lanes({ claude: 1, codex: deps.ctx.config.codex.concurrency });
    this.log = deps.log ?? (() => {});
    this.calls = new BrainCalls({ c: this.c, brainFor: deps.brainFor, connectivity: this.connectivity, lanes: this.lanes, log: this.log });
    this.planning = new Planning({ c: this.c, calls: this.calls, workspace: this.workspace, log: this.log });
    this.ticketWork = new TicketWork({ c: this.c, calls: this.calls, tests: deps.tests, workspace: this.workspace, web: deps.web ?? createWeb(deps.ctx.config), log: this.log });
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
    assertCeo(this.c.config, discordUserId);
    clearState(this.c, planBlockedKey(orderId));
  }

  /** 계획 작성이 멈춘 지시를 CEO가 취소한다(#막힘 [취소]). 아직 계획 단계인 지시만. */
  cancelBlockedOrder(orderId: string, discordUserId: string): void {
    assertCeo(this.c.config, discordUserId);
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
    return stopAll(this.c, discordUserId, () => this.calls.abortAll());
  }

  resume(discordUserId: string): string[] {
    return resumeAll(this.c, discordUserId);
  }

  /**
   * 정기 보고문 관문 검사 (10장: 보고는 CEO에게 가기 전에 GPT 관문을 거친다).
   * GPT 한도가 없거나 연결이 끊겨 검사할 수 없으면 null ("관문 미통과"로 올린다).
   */
  async gateReport(report: string): Promise<z.infer<typeof GateOutputSchema> | null> {
    const gate = this.calls.employee(GATE_REVIEWER_ID);
    if (this.calls.spendMode(gate) !== 'ok') return null;
    try {
      return await this.calls.call(gate, 'gate', GateOutputSchema, { report }, {}, { workdir: this.workspace.sandbox('gate-report') });
    } catch (err) {
      if (isQuiet(err)) this.calls.handleQuietFailure(err, gate);
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
    const drafter: EmployeeRow = scribe ?? { ...this.calls.employee('git-cat'), brain: { provider: 'ollama', model: LOCAL_MODEL } };
    try {
      return await this.calls.call(drafter, 'commit', CommitDraftSchema, { ticket: { id: info.id, title: info.title, type: 'coding', acceptanceCriteria: info.acceptanceCriteria }, diffStat }, {});
    } catch {
      return null;
    }
  }

  /**
   * 직원 봇 대화 (9장, 2026-10-20 CEO 결정). 주인이 멘션한 직원의 이름·역할 카드로, 두뇌는 누구든 로컬 Gemma를 쓴다
   * (Claude·GPT 한도를 쓰지 않는다). 답은 글뿐이고 상태를 바꾸지 않는다. 실패하면 null.
   */
  async chatAs(employeeId: string, input: unknown): Promise<string | null> {
    const e: EmployeeRow = { ...this.calls.employee(employeeId), brain: { provider: 'ollama', model: LOCAL_MODEL } };
    try {
      return (await this.calls.call(e, 'chat', StaffChatOutputSchema, input, {})).text;
    } catch (err) {
      if (isQuiet(err)) this.calls.handleQuietFailure(err, e);
      if (err instanceof BrainError || err instanceof FormatError) return null;
      throw err;
    }
  }

  /**
   * 회고(6단계)·보조 직원처럼 티켓 밖에서 직원을 부른다. 한도가 없거나 끊겼거나 형식 오류·호출 실패면 null.
   * 실패해도 티켓을 멈추지 않는다. 다음 바퀴에 다시 시도한다.
   */
  async callAs<S extends z.ZodType>(employeeId: string, task: BrainTask, schema: S, input: unknown, opts: { workdir?: string; check?: (o: z.infer<S>) => string[] } = {}): Promise<z.infer<S> | null> {
    return this.calls.callOrNull(employeeId, task, schema, input, {
      workdir: this.workspace.sandbox(opts.workdir ?? `${task}-${employeeId}`),
      ...(opts.check ? { check: opts.check as (out: never) => string[] } : {}),
    });
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
      jobs.push(this.once(`order:${o.id}`, () => this.planning.advance(o.id)));
    }
    const active = this.c.db
      .select()
      .from(tickets)
      .where(inArray(tickets.status, ['rework', 'in_progress', 'in_review', 'meeting']))
      .orderBy(sql`rowid`)
      .all();
    for (const tk of active) jobs.push(this.once(tk.id, () => this.ticketWork.advance(getTicket(this.c, tk.id))));

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
}
