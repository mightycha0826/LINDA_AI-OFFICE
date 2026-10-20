// 엔진의 AI 호출 계층. 직원 한 명을 부르고 출력을 Zod로 검사한다.
// 차선(Claude·Codex), GPU 줄 순위, 사용량·티켓 턴 기록, 재시도는 여기서만 한다 (6장, 8장).
// 상태 전환은 하지 않는다: 실패는 오류로 던지고, 티켓을 멈출지는 부르는 쪽(계획·티켓 단계)이 정한다.
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { TicketType } from '@ai-office/shared';
import { BrainError, type BrainTask } from '../brains/brain.ts';
import type { Lanes } from '../brains/lanes.ts';
import type { BrainFor } from '../brains/registry.ts';
import { estimatePct } from '../brains/usage-estimate.ts';
import type { Connectivity } from '../connectivity.ts';
import { setState, type Ctx } from '../context.ts';
import { blockBudget, budgetOf, isExhausted, recordUsage, type EmployeeRow } from '../core/budget.ts';
import { recordTurn } from '../core/guards.ts';
import { employees } from '../db/schema.ts';
import { FormatError, NotFoundError } from '../errors.ts';
import { activeRuleRows, recordRuleApplications } from '../retro/rules.ts';
import { queuePriorityOf } from '../staff/assistants.ts';
import { renderTask } from '../staff/prompts.ts';
import { roleCard } from '../staff/role-cards.ts';

export interface CallOptions {
  check?: (out: never) => string[];
  lowPrecision?: boolean;
  workdir?: string;
  ticketType?: TicketType;
}

/** 지금 AI를 부를 수 있는가: 그대로 · 저정밀(로컬로) · 기다림 · 끊김 */
export type SpendMode = 'ok' | 'low-precision' | 'wait' | 'offline';

export const isCloud = (e: EmployeeRow) => e.brain.provider === 'claude-code' || e.brain.provider === 'codex';
/** 클라우드 직원의 호출 차선. 로컬 모델은 GPU 대기열이 따로 줄을 세운다 */
const laneOf = (e: EmployeeRow) => (e.brain.provider === 'claude-code' ? 'claude' : e.brain.provider === 'codex' ? 'codex' : null);
/** 인터넷 끊김·한도 도달: 직원 탓이 아니라 기다리면 풀리는 실패 */
export const isQuiet = (err: unknown): err is BrainError => err instanceof BrainError && (err.failure === 'offline' || err.failure === 'limit');

export class BrainCalls {
  private readonly c: Ctx;
  private readonly brainFor: BrainFor;
  private readonly connectivity: Connectivity;
  private readonly lanes: Lanes;
  private readonly log: (line: string) => void;
  private controller = new AbortController();

  constructor(o: { c: Ctx; brainFor: BrainFor; connectivity: Connectivity; lanes: Lanes; log: (line: string) => void }) {
    this.c = o.c;
    this.brainFor = o.brainFor;
    this.connectivity = o.connectivity;
    this.lanes = o.lanes;
    this.log = o.log;
  }

  /** 진행 중인 호출(자식 프로세스 포함)을 끊는 신호. /정지 뒤에는 새 신호다 */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** /정지: 진행 중인 호출을 모두 끊는다 */
  abortAll(): void {
    this.controller.abort();
    this.controller = new AbortController();
  }

  employee(id: string): EmployeeRow {
    const e = this.c.db.select().from(employees).where(eq(employees.id, id)).get();
    if (!e) throw new NotFoundError(`직원 ${id}`);
    return e;
  }

  /** 이 직원이 지금 AI를 부를 수 있는가. 리서치 몫 소진이면 로컬(저정밀)로 바꾼다. */
  spendMode(e: EmployeeRow): SpendMode {
    const b = budgetOf(e);
    // 인터넷이 끊기면 클라우드 직원(개발자·리뷰어·경영전략)은 멈춘다 (3장)
    if (isCloud(e) && !this.connectivity.isOnline()) return 'offline';
    if (!b || b === 'local' || !isExhausted(this.c, b)) return 'ok';
    // 리서치 몫 소진 때 로컬로 바꾸는 것은 리서치 직원뿐. 기획실장(PM)은 기다린다(로컬 계획은 뒤에서 더 비싸다, 2-0)
    return b === 'research' && e.role !== 'pm' ? 'low-precision' : 'wait';
  }

  /** 인터넷 끊김은 연결 상태에, 한도 도달은 몫에 기록한다. 티켓 처리는 다음 바퀴의 규칙이 한다. */
  handleQuietFailure(err: BrainError, e: EmployeeRow): void {
    if (err.failure === 'offline') this.connectivity.markOffline(err.message);
    if (err.failure === 'limit') {
      const b = budgetOf(e);
      if (b && b !== 'local') blockBudget(this.c, b, err.resetsAt);
    }
    this.log(err.message);
  }

  /**
   * 티켓 밖 호출(관문 보고·회고·교정·보조 직원). 한도가 없거나 끊겼거나 형식 오류·호출 실패면 null.
   * 실패해도 티켓을 멈추지 않는다. 다음 바퀴에 다시 시도한다.
   */
  async callOrNull<S extends z.ZodType>(employeeId: string, task: BrainTask, schema: S, input: unknown, opts: CallOptions = {}): Promise<z.infer<S> | null> {
    const e = this.employee(employeeId);
    if (this.spendMode(e) !== 'ok') return null;
    try {
      return await this.call(e, task, schema, input, {}, opts);
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

  /**
   * AI를 부르고 출력을 Zod로 검사한다. 틀리면 오류를 붙여 한 번 다시 시키고, 또 틀리면 FormatError (6장).
   * 시간 초과·비정상 종료도 한 번 다시 시도한다. 호출마다 사용량과 티켓 턴·토큰을 기록한다.
   */
  async call<S extends z.ZodType>(
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
