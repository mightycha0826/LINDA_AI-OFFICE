// 가짜 AI (16장 1단계). API 비용 없이 전체 흐름을 돌린다. 작업별로 응답을 바꿔 끼워 시나리오를 만든다.
import type { DevOutput, DocOutput, GateOutput, MeetingPosition, PmPlanOutput, ReasonCategory, ReviewOutput } from '@ai-office/shared';
import { budgetOf } from '../core/budget.ts';
import type { Brain, BrainRequest, BrainResult, BrainTask } from './brain.ts';

/** n은 같은 작업·같은 대상에 대한 몇 번째 호출인지 (1부터) */
export type MockHandler = (req: BrainRequest, n: number) => unknown;

export interface MockOptions {
  /** 호출 1회가 깎는 5시간 한도 % (몫별). 기본: Claude 1%, GPT 1%, 로컬 0 */
  pctPerCall?: Partial<Record<'dev' | 'research' | 'review' | 'local', number>>;
  /** 주간 한도 %는 5시간 %의 몇 배인가. 기본 0.2 */
  weeklyRatio?: number;
  tokensPerCall?: number;
}

export interface TicketInput {
  ticket: { id: string; title: string; type: string; acceptanceCriteria: string[] };
}

export function planOutput(over: Partial<PmPlanOutput> = {}): PmPlanOutput {
  return {
    goal: '요청한 기능을 만든다',
    questions: [],
    tickets: [
      {
        title: '기능 구현',
        type: 'coding',
        assignee: 'developer',
        reviewer: 'reviewer',
        acceptanceCriteria: ['단위 테스트 통과'],
        needsCeoApproval: false,
        estimatedTokens: 30_000,
      },
    ],
    tempStaff: [],
    estimate: { claudeDevPct: 5, claudeResearchPct: 0, gptPct: 3, hours: 1 },
    ...over,
  };
}

export function passReview(criteria: string[]): ReviewOutput {
  return { verdict: 'pass', criteria: criteria.map((criterion) => ({ criterion, pass: true })), fixRequests: [] };
}

export function failReview(criteria: string[], reasonCategory: ReasonCategory = 'criteria-unmet', reason = '조건을 만족하지 못함'): ReviewOutput {
  return {
    verdict: 'fail',
    criteria: criteria.map((criterion, i) => (i === 0 ? { criterion, pass: false, reason } : { criterion, pass: true })),
    reasonCategory,
    fixRequests: [`${criteria[0]}: ${reason}`],
  };
}

export const DEFAULT_HANDLERS: Record<BrainTask, MockHandler> = {
  plan: () => planOutput(),
  gate: (): GateOutput => ({ passed: true, issues: [], objection: null }),
  work: (req) => {
    const { ticket } = req.input as TicketInput;
    if (ticket.type === 'coding') {
      const out: DevOutput = {
        summary: `${ticket.title} 구현`,
        changedFiles: ['src/feature.ts', 'src/feature.test.ts'],
        criteriaSelfCheck: ticket.acceptanceCriteria.map((criterion) => ({ criterion, claimed: true })),
      };
      return out;
    }
    const doc: DocOutput = { document: `# ${ticket.title}\n초안`, claims: [{ text: '근거 없는 주장', sources: [], noSource: true }] };
    return doc;
  },
  review: (req) => passReview((req.input as TicketInput).ticket.acceptanceCriteria),
  meeting: (): MeetingPosition => ({ claim: '완료 조건대로 고치면 된다', agree: true, nextActions: ['수정 후 다시 제출'] }),
};

export class MockLlm implements Brain {
  readonly calls: BrainRequest[] = [];
  private readonly handlers: Partial<Record<BrainTask, MockHandler>>;
  private readonly options: MockOptions;
  private readonly counts = new Map<string, number>();

  constructor(handlers: Partial<Record<BrainTask, MockHandler>> = {}, options: MockOptions = {}) {
    this.handlers = handlers;
    this.options = options;
  }

  async call(req: BrainRequest): Promise<BrainResult> {
    if (req.signal.aborted) throw new DOMException('정지됨', 'AbortError');
    this.calls.push(req);
    const key = `${req.task}:${req.ticketId ?? req.orderId ?? ''}:${req.employee.id}`;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    const handler = this.handlers[req.task] ?? DEFAULT_HANDLERS[req.task];
    const output = handler(req, n);

    const budget = req.lowPrecision ? 'local' : (budgetOf(req.employee) ?? 'local');
    const defaults = { dev: 1, research: 1, review: 1, local: 0 };
    const pct = { ...defaults, ...this.options.pctPerCall }[budget];
    const tokens = this.options.tokensPerCall ?? 1_500;
    return { output, usage: { inputTokens: Math.round(tokens * 0.7), outputTokens: Math.round(tokens * 0.3), estimatedPct: pct, estimatedWeeklyPct: pct * (this.options.weeklyRatio ?? 0.2), source: 'estimated' } };
  }

  callsFor(task: BrainTask): BrainRequest[] {
    return this.calls.filter((c) => c.task === task);
  }
}
