// 오케스트레이터 엔진. 직원 호출 순서를 돌리고, 결과를 core의 규칙 함수로만 반영한다.
// AI는 출력(JSON)만 낸다. 상태 전환, 결재, 한도, 상한 판단은 모두 core가 한다 (설계 원칙 1).
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  DevOutputSchema,
  DocOutputSchema,
  GateOutputSchema,
  MeetingPositionSchema,
  PmPlanOutputSchema,
  ReviewOutputSchema,
  type DevOutput,
  type DocOutput,
} from '@ai-office/shared';
import type { Brain, BrainTask, TestRunner } from './brains/brain.ts';
import { decideApproval, requestApproval, type DecideInput } from './core/approvals.ts';
import { budgetOf, enforceBudgets, isExhausted, recordUsage, type EmployeeRow } from './core/budget.ts';
import { isOverCap, recordMessage, recordTurn } from './core/guards.ts';
import { agendaFromLastReview, concludeMeeting, saveMinutes, type RoundPositions } from './core/meeting.ts';
import { registerOrder } from './core/orders.ts';
import { checkPlanRules, createPlanVersion, GATE_REVIEWER_ID, latestPlan, recordGateResult, startGateReview } from './core/plans.ts';
import { resumeAll, stopAll } from './core/stop.ts';
import { applyTicketEvent, getTicket, type TicketRow } from './core/tickets.ts';
import type { TicketEvent } from './core/transitions.ts';
import { clearState, emit, getState, inTx, isStopped, setState, type Ctx } from './context.ts';
import { employees, messages, orders, tickets } from './db/schema.ts';
import { FormatError, NotCeoError, NotFoundError, OfficeError } from './errors.ts';

export interface EngineDeps {
  ctx: Ctx;
  /** 직원에게 맞는 두뇌. 1단계는 모두 MockLLM. */
  brainFor: (employee: EmployeeRow) => Brain;
  tests: TestRunner;
  log?: (line: string) => void;
}

const orchestrator = { kind: 'orchestrator' } as const;
const planBlockedKey = (orderId: string) => `planBlocked:${orderId}`;

export class Engine {
  private readonly c: Ctx;
  private readonly brainFor: (e: EmployeeRow) => Brain;
  private readonly tests: TestRunner;
  private readonly log: (line: string) => void;
  private controller = new AbortController();

  constructor(deps: EngineDeps) {
    this.c = deps.ctx;
    this.brainFor = deps.brainFor;
    this.tests = deps.tests;
    this.log = deps.log ?? (() => {});
  }

  // --- 바깥(결재 봇, 비서실장)에서 들어오는 요청 ----------------------------

  submitOrder(input: { discordMessageId: string; rawText: string }) {
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

  /** /정지: 진행 중인 AI 호출을 끊고 모든 티켓을 멈춘다. */
  stop(discordUserId: string): string[] {
    return stopAll(this.c, discordUserId, () => {
      this.controller.abort();
      this.controller = new AbortController();
    });
  }

  resume(discordUserId: string): string[] {
    return resumeAll(this.c, discordUserId);
  }

  // --- 한 바퀴 ----------------------------------------------------------------

  /** 할 수 있는 일을 한 바퀴 돈다. 실제로 한 일의 수를 돌려준다. */
  async step(): Promise<number> {
    if (isStopped(this.c)) return 0;
    let actions = 0;
    const budget = enforceBudgets(this.c);
    actions += budget.paused.length + budget.resumed.length;

    const planning = this.c.db.select().from(orders).where(eq(orders.status, 'planning')).all();
    for (const o of planning) {
      if (isStopped(this.c)) return actions;
      if (await this.advancePlanning(o.id)) actions++;
    }

    const active = this.c.db
      .select()
      .from(tickets)
      .where(inArray(tickets.status, ['rework', 'in_progress', 'in_review', 'meeting']))
      .orderBy(sql`rowid`)
      .all();
    for (const tk of active) {
      if (isStopped(this.c)) return actions;
      try {
        if (await this.advanceTicket(getTicket(this.c, tk.id))) actions++;
      } catch (err) {
        if (err instanceof OfficeError && err.code !== 'format-error') {
          // 그사이 상태가 바뀌었거나(정지, 상한) 규칙이 거부함. 결과는 버리고 다음 바퀴에 다시 본다.
          this.log(`${tk.id}: ${err.message}`);
          continue;
        }
        if ((err as Error).name === 'AbortError') return actions;
        throw err;
      }
    }
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

  // --- 계획 -------------------------------------------------------------------

  private async advancePlanning(orderId: string): Promise<boolean> {
    const c = this.c;
    if (getState<string | null>(c, planBlockedKey(orderId), null)) return false; // 형식 오류로 멈춤. CEO가 다시 시도해야 한다
    const plan = latestPlan(c, orderId);
    if (plan?.status === 'draft') {
      startGateReview(c, plan.id);
      return true;
    }
    if (plan?.status === 'gate-review') {
      const gate = this.employee(GATE_REVIEWER_ID);
      if (isExhausted(c, 'review')) return false; // GPT 소진: 관문 검사는 기다린다
      const out = await this.callStructured(gate, 'gate', GateOutputSchema, { plan }, { orderId });
      const outcome = recordGateResult(c, plan.id, out);
      this.log(`${plan.id} v${plan.version} 관문: ${outcome}`);
      return true;
    }
    if (plan && plan.status !== 'revision-requested') return false;

    const pm = this.employee('pm');
    const order = c.db.select().from(orders).where(eq(orders.id, orderId)).get()!;
    const staff = c.db.select().from(employees).all().map((e) => ({ id: e.id, role: e.role, brain: e.brain }));
    const afterGateRejection = !!plan && plan.ceoNote === null;
    const feedback = plan ? (afterGateRejection ? (plan.gateResult?.issues ?? []) : [plan.ceoNote ?? '']) : [];
    let out;
    try {
      out = await this.callStructured(pm, 'plan', PmPlanOutputSchema, { order: { id: order.id, rawText: order.rawText }, staff, feedback }, { orderId }, (o) =>
        checkPlanRules(c, o),
      );
    } catch (err) {
      if (err instanceof FormatError) {
        inTx(c, (t) => {
          setState(t, planBlockedKey(orderId), err.issues);
          recordMessage(t, { orderId, fromId: 'orchestrator', kind: 'system', content: `계획서 형식 오류 2회로 멈춤: ${err.issues}` });
          emit(t, 'plan.status', { orderId, status: 'format-error' });
        });
        return true;
      }
      throw err;
    }
    const created = createPlanVersion(c, orderId, out, { afterGateRejection });
    startGateReview(c, created.id);
    this.log(`${created.id} v${created.version} 작성`);
    return true;
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
  private spendMode(e: EmployeeRow): 'ok' | 'low-precision' | 'wait' {
    const b = budgetOf(e);
    if (!b || b === 'local' || !isExhausted(this.c, b)) return 'ok';
    return b === 'research' ? 'low-precision' : 'wait';
  }

  private async work(tk: TicketRow): Promise<boolean> {
    const c = this.c;
    const assignee = this.employee(tk.assigneeId);
    const mode = this.spendMode(assignee);
    if (mode === 'wait') return false; // 개발 몫 소진은 enforceBudgets가 멈춘다
    if (this.pauseIfOverCap(tk)) return true;
    if (mode === 'low-precision') this.markLowPrecision(tk);

    const schema = tk.type === 'coding' ? DevOutputSchema : DocOutputSchema;
    const out = await this.ticketCall(tk, assignee, 'work', schema, { ticket: this.ticketInput(tk), feedback: this.feedbackFor(tk) }, mode === 'low-precision');
    if (!out || getTicket(c, tk.id).status !== 'in_progress') return true; // 그사이 멈췄으면 결과는 버린다
    const note = mode === 'low-precision' ? '저정밀 모드로 작성됨\n' : '';
    recordMessage(c, { ticketId: tk.id, orderId: tk.orderId, fromId: assignee.id, toId: tk.reviewerId, kind: 'handoff', content: note + JSON.stringify(out) });
    applyTicketEvent(c, tk.id, { type: 'ticket.submitted' }, { kind: 'employee', id: assignee.id });
    return true;
  }

  private async review(tk: TicketRow): Promise<boolean> {
    const c = this.c;
    const reviewer = this.employee(tk.reviewerId);
    const mode = this.spendMode(reviewer);
    if (mode === 'wait') return false; // GPT 소진: in_review에서 기다린다
    if (this.pauseIfOverCap(tk)) return true;

    // 테스트는 개발자의 말이 아니라 오케스트레이터가 직접 돌린 결과만 쓴다 (6장)
    const tests = tk.type === 'coding' ? await this.tests.run(tk.id, this.controller.signal) : null;
    const handoff = c.db
      .select()
      .from(messages)
      .where(and(eq(messages.ticketId, tk.id), eq(messages.kind, 'handoff')))
      .orderBy(desc(sql`rowid`))
      .limit(1)
      .get();
    const criteria = new Set(tk.acceptanceCriteria);
    const out = await this.ticketCall(
      tk,
      reviewer,
      'review',
      ReviewOutputSchema,
      { ticket: this.ticketInput(tk), submission: handoff?.content ?? '', tests },
      mode === 'low-precision',
      // 반려는 작업 시작 전에 정해진 완료 조건으로만 판정한다
      (r) => {
        const judged = new Set(r.criteria.map((x) => x.criterion));
        const unknown = [...judged].filter((x) => !criteria.has(x));
        const missing = [...criteria].filter((x) => !judged.has(x));
        return [
          ...unknown.map((x) => `완료 조건에 없는 기준으로 판정함: ${x}`),
          ...missing.map((x) => `판정하지 않은 완료 조건: ${x}`),
        ];
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
    if (people.some((p) => this.spendMode(p) === 'wait')) return false;
    if (this.pauseIfOverCap(tk)) return true;

    const agenda = agendaFromLastReview(c, tk.id);
    const rounds: RoundPositions[] = [];
    for (let round = 1; round <= c.config.meetingMaxRounds; round++) {
      const positions: RoundPositions['positions'] = [];
      for (const p of people) {
        const position = await this.ticketCall(tk, p, 'meeting', MeetingPositionSchema, {
          ticket: this.ticketInput(tk),
          agenda,
          previousRounds: rounds,
        });
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

  // --- 공통 -------------------------------------------------------------------

  private employee(id: string): EmployeeRow {
    const e = this.c.db.select().from(employees).where(eq(employees.id, id)).get();
    if (!e) throw new NotFoundError(`직원 ${id}`);
    return e;
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

  private markLowPrecision(tk: TicketRow): void {
    if (tk.lowPrecision) return;
    this.c.db.update(tickets).set({ lowPrecision: true }).where(eq(tickets.id, tk.id)).run();
    emit(this.c, 'ticket.status', { ticketId: tk.id, from: tk.status, to: tk.status, event: 'low-precision' });
  }

  /** 티켓 작업 호출. 형식 오류가 두 번이면 티켓을 멈추고(system-error) null을 돌려준다. */
  private async ticketCall<S extends z.ZodType>(
    tk: TicketRow,
    e: EmployeeRow,
    task: BrainTask,
    schema: S,
    input: unknown,
    lowPrecision = false,
    check?: (out: z.infer<S>) => string[],
  ): Promise<z.infer<S> | null> {
    try {
      return await this.callStructured(e, task, schema, input, { ticketId: tk.id, orderId: tk.orderId }, check, lowPrecision);
    } catch (err) {
      if (!(err instanceof FormatError)) throw err;
      recordMessage(this.c, { ticketId: tk.id, orderId: tk.orderId, fromId: 'orchestrator', kind: 'system', content: `형식 오류 2회로 멈춤 (${e.id}): ${err.issues}`, countsForPingpong: false });
      const now = getTicket(this.c, tk.id);
      if (now.status !== 'paused' && now.status !== 'done' && now.status !== 'cancelled') {
        applyTicketEvent(this.c, tk.id, { type: 'system.pause', reason: 'system-error' }, orchestrator);
      }
      return null;
    }
  }

  /**
   * AI를 부르고 출력을 Zod로 검사한다. 틀리면 오류를 붙여 한 번 다시 시키고, 또 틀리면 FormatError (6장).
   * 호출마다 사용량과 티켓 턴·토큰을 기록한다.
   */
  private async callStructured<S extends z.ZodType>(
    e: EmployeeRow,
    task: BrainTask,
    schema: S,
    input: unknown,
    refs: { ticketId?: string; orderId?: string },
    check?: (out: z.infer<S>) => string[],
    lowPrecision = false,
  ): Promise<z.infer<S>> {
    const brain = this.brainFor(e);
    const budget = lowPrecision ? 'local' : (budgetOf(e) ?? 'local');
    let previousError: string | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await brain.call({
        employee: e,
        task,
        schemaName: task,
        input,
        attempt,
        lowPrecision,
        signal: this.controller.signal,
        ...refs,
        ...(previousError ? { previousError } : {}),
      });
      recordUsage(this.c, { budget, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, estimatedPct: res.usage.estimatedPct, estimatedWeeklyPct: res.usage.estimatedWeeklyPct, source: res.usage.source, ...(refs.ticketId ? { ticketId: refs.ticketId } : {}) });
      if (refs.ticketId) recordTurn(this.c, refs.ticketId, res.usage.inputTokens + res.usage.outputTokens);

      const parsed = schema.safeParse(res.output);
      const problems = parsed.success ? (check?.(parsed.data as z.infer<S>) ?? []) : [z.prettifyError(parsed.error)];
      if (problems.length === 0) return parsed.data as z.infer<S>;
      previousError = problems.join('\n');
      this.log(`${e.id} ${task} 형식 오류(${attempt}회): ${previousError}`);
    }
    throw new FormatError(previousError ?? '알 수 없음');
  }
}

export type WorkOutput = DevOutput | DocOutput;
