// 가짜 AI (16장 1단계). API 비용 없이 전체 흐름을 돌린다. 작업별로 응답을 바꿔 끼워 시나리오를 만든다.
import type { DesignComboOutput, DevOutput, DocOutput, GateOutput, MeetingPosition, PmPlanOutput, ReasonCategory, ReviewOutput, SearchQueries } from '@ai-office/shared';
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
    projectId: 'demo',
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
  search: (req): SearchQueries => ({ queries: [(req.input as TicketInput).ticket.title] }),
  proofread: () => ({ issues: [{ kind: 'tone', where: '첫 문단', note: '말투가 섞임' }], missingCriteria: [] }),
  explain: () => ({ lines: ['계획서가 규칙에 맞지 않아 멈췄어요', '[다시 시도]를 누르면 다시 써요'] }),
  summarize: () => ({ lines: ['기능 파일을 추가했어요'] }),
  interpret: () => ({ text: '작업을 마치고 검토를 부탁했어요' }),
  report: () => ({ text: '진행 중인 일과 결재 대기를 정리했어요' }),
  chat: () => ({ text: '지금은 대기 중이에요', intent: 'chat' }),
  design: (): DesignComboOutput => ({ combo: 2, mode: 'light', reason: '관리 화면이라 오래 들여다봄' }),
  commit: (req) => ({ type: 'feat', scope: 'app', subject: `${(req.input as TicketInput).ticket.title} 추가` }),
  retro: (req) => {
    const input = req.input as { mode: string; reasonCategory?: ReasonCategory; evidence?: { ticketId: string }[]; ticket?: { id: string } };
    if (input.mode === 'ticket') return { whatWrong: '완료 조건의 오류 문구를 빠뜨림', why: '완료 조건에 실패 메시지가 없었음', preventAt: 'plan' };
    if (input.mode === 'check') return { confirmed: true, note: '' };
    if (input.mode === 'rule') {
      return {
        scope: { role: 'pm', ticketType: 'coding' },
        rule: '폼·로그인 관련 티켓의 완료 조건에는 실패 시 표시할 메시지를 포함한다',
        evidence: (input.evidence ?? []).map((e) => e.ticketId).slice(0, 5),
        reasonCategory: input.reasonCategory ?? 'criteria-unmet',
      };
    }
    return { summary: '이번 주는 완료 조건 미충족 반려가 많았어요', candidates: [] };
  },
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
