// 티켓 단계 (6장): 작업 → 검토 → (반려가 쌓이면) 회의. 직원은 출력(JSON)만 내고, 상태 전환은 core 규칙 함수만 한다.
// 호출이 실패하면 종류에 맞게 티켓을 멈춘다: 형식 오류·호출 실패 2회 = 시스템 오류, 인터넷 끊김 = 연결되면 이어감, 한도 = 다음 바퀴.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DevOutputSchema, DocOutputSchema, MEETING_OUTCOME_LABEL, MeetingPositionSchema, ProofreadOutputSchema, ReviewOutputSchema, SearchQueriesSchema, type DevOutput, type DocOutput, type ProofreadOutput } from '@ai-office/shared';
import { BrainError, type BrainTask, type TestRunner } from '../brains/brain.ts';
import { emit, type Ctx } from '../context.ts';
import { requestApproval } from '../core/approvals.ts';
import type { EmployeeRow } from '../core/budget.ts';
import { isOverCap, recordMessage } from '../core/guards.ts';
import { agendaFromLastReview, concludeMeeting, saveMinutes, type RoundPositions } from '../core/meeting.ts';
import { applyTicketEvent, getTicket, type TicketRow } from '../core/tickets.ts';
import type { TicketEvent } from '../core/transitions.ts';
import { messages, tickets } from '../db/schema.ts';
import { FormatError, OfficeError } from '../errors.ts';
import { ASSIGNABLE_ASSISTANTS } from '../staff/assistants.ts';
import { claimLinks, type Web } from '../web/research.ts';
import type { Workspace } from '../workspace/worktrees.ts';
import { isCloud, isQuiet, type BrainCalls, type CallOptions } from './brain-calls.ts';

const orchestrator = { kind: 'orchestrator' } as const;
/** 교정 1차 점검을 하는 직원 (16장 7-4) */
const PROOFREADER_ID = 'qa-local';
/** 이미 멈췄거나 끝난 티켓은 다시 멈추지 않는다 */
const SETTLED: readonly string[] = ['paused', 'done', 'cancelled'];

export class TicketWork {
  private readonly c: Ctx;
  private readonly calls: BrainCalls;
  private readonly tests: TestRunner;
  private readonly workspace: Workspace;
  private readonly web: Web;
  private readonly log: (line: string) => void;

  constructor(o: { c: Ctx; calls: BrainCalls; tests: TestRunner; workspace: Workspace; web: Web; log: (line: string) => void }) {
    this.c = o.c;
    this.calls = o.calls;
    this.tests = o.tests;
    this.workspace = o.workspace;
    this.web = o.web;
    this.log = o.log;
  }

  /** 티켓 하나를 한 걸음 진행한다. 한 일이 있으면 true */
  async advance(tk: TicketRow): Promise<boolean> {
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

  private async work(tk: TicketRow): Promise<boolean> {
    const c = this.c;
    const assignee = this.calls.employee(tk.assigneeId);
    if (this.pauseIfOffline(tk, [assignee])) return true;
    const mode = this.calls.spendMode(assignee);
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
    const input = { ticket: ticketInput(tk), feedback: this.feedbackFor(tk), ...(worktree ? { worktree } : {}), ...(searchResults ? { searchResults } : {}) };
    const out = await this.ticketCall(tk, assignee, 'work', schema, input, { lowPrecision, ...this.workdirFor(tk, assignee, lowPrecision) });
    if (!out || getTicket(c, tk.id).status !== 'in_progress') return true; // 그사이 멈췄으면 결과는 버린다
    // 결과물 앞에 붙는 표시: 저정밀 모드, 초안 작가의 초안 (16장 7-5)
    const note = (lowPrecision ? '저정밀 모드로 작성됨\n' : '') + (ASSIGNABLE_ASSISTANTS.includes(assignee.id) ? '초안 작가의 초안 (다듬기 전)\n' : '');
    recordMessage(c, { ticketId: tk.id, orderId: tk.orderId, fromId: assignee.id, toId: tk.reviewerId, kind: 'handoff', content: note + JSON.stringify(out) });
    applyTicketEvent(c, tk.id, { type: 'ticket.submitted' }, { kind: 'employee', id: assignee.id });
    return true;
  }

  private async review(tk: TicketRow): Promise<boolean> {
    const c = this.c;
    const reviewer = this.calls.employee(tk.reviewerId);
    if (this.pauseIfOffline(tk, [reviewer])) return true;
    const mode = this.calls.spendMode(reviewer);
    if (mode === 'wait') return false; // GPT 소진: in_review에서 기다린다
    if (this.pauseIfOverCap(tk)) return true;
    const lowPrecision = mode === 'low-precision';

    // 테스트는 개발자의 말이 아니라 오케스트레이터가 직접 돌린 결과만 쓴다 (6장)
    const coding = tk.type === 'coding';
    const tests = coding ? await this.tests.run(tk.id, this.calls.signal) : null;
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
      { ticket: ticketInput(tk), submission, tests, ...(diff ? { diff } : {}), ...(sources.length ? { sources } : {}), ...(proofread ? { proofread } : {}) },
      {
        lowPrecision,
        ...this.workdirFor(tk, reviewer, lowPrecision),
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
    // 같은 반려 반복 판단용 완료 조건 묶음은 코드가 검토 출력에서 뽑는다 (5장, 2026-10-23)
    const ev: TicketEvent =
      out.verdict === 'pass'
        ? { type: 'review.passed' }
        : { type: 'review.failed', reasonCategory: out.reasonCategory!, failedCriteria: out.criteria.filter((x) => !x.pass).map((x) => x.criterion) };
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
    const people = [this.calls.employee(tk.assigneeId), this.calls.employee(tk.reviewerId)];
    if (this.pauseIfOffline(tk, people)) return true;
    if (people.some((p) => this.calls.spendMode(p) === 'wait')) return false;
    if (this.pauseIfOverCap(tk)) return true;

    const agenda = agendaFromLastReview(c, tk.id);
    const rounds: RoundPositions[] = [];
    for (let round = 1; round <= c.config.meetingMaxRounds; round++) {
      const positions: RoundPositions['positions'] = [];
      for (const p of people) {
        const lowPrecision = this.calls.spendMode(p) === 'low-precision';
        const position = await this.ticketCall(tk, p, 'meeting', MeetingPositionSchema, { ticket: ticketInput(tk), agenda, previousRounds: rounds }, { lowPrecision, ...this.workdirFor(tk, p, lowPrecision) });
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
      content: `회의록 ${minutes.id}: ${MEETING_OUTCOME_LABEL[result.outcome]} · 다음 할 일 ${result.nextActions.join(', ') || '없음'}`,
      countsForPingpong: false,
    });
    if (getTicket(c, tk.id).status !== 'meeting') return true;
    const ev = ({ 'needs-ceo': 'meeting.escalated', agreed: 'meeting.agreed', disagreed: 'meeting.failed' } as const)[result.outcome];
    applyTicketEvent(c, tk.id, { type: ev }, orchestrator);
    return true;
  }

  /**
   * 로컬 직원의 검색 (15장, 2.5단계 결정 C). 로컬 모델에게 도구 호출을 맡기지 않는다.
   * 1) 직원이 검색어를 정하고 2) 오케스트레이터가 SearXNG로 검색하고 3) 결과를 자료로 본 작업에 넘긴다.
   */
  private async localSearch(tk: TicketRow, e: EmployeeRow, lowPrecision: boolean): Promise<unknown[] | null> {
    const q = await this.ticketCall(tk, e, 'search', SearchQueriesSchema, { ticket: ticketInput(tk) }, { lowPrecision, ...this.workdirFor(tk, e, lowPrecision) });
    if (!q) return null;
    const results: unknown[] = [];
    let count = 0;
    for (const query of q.queries) {
      try {
        const found = await this.web.search.search(query, this.calls.signal);
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
      out = await this.calls.callOrNull(PROOFREADER_ID, 'proofread', ProofreadOutputSchema, { ticket: ticketInput(tk), submission }, { workdir: this.workspace.sandbox(`proofread-${tk.id}`) });
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
      const p = await this.web.fetchPage(url, this.calls.signal);
      pages.push(p.ok ? { url, title: p.title, text: p.text, truncated: p.truncated ?? false } : { url, error: p.error ?? '가져오지 못함' });
    }
    return pages;
  }

  /** 클라우드 직원이 일할 폴더: 코딩이면 worktree, 아니면 빈 샌드박스. 로컬 모델은 폴더가 필요 없다. */
  private workdirFor(tk: TicketRow, e: EmployeeRow, lowPrecision: boolean): { workdir?: string } {
    if (!isCloud(e) || lowPrecision) return {};
    return { workdir: getTicket(this.c, tk.id).worktreePath ?? this.workspace.sandbox(tk.id) };
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

  /** 인터넷이 끊겨 클라우드 직원이 일할 수 없으면 티켓을 멈춘다(연결되면 이어감). */
  private pauseIfOffline(tk: TicketRow, people: EmployeeRow[]): boolean {
    if (!people.some((p) => this.calls.spendMode(p) === 'offline')) return false;
    applyTicketEvent(this.c, tk.id, { type: 'system.pause', reason: 'offline' }, orchestrator);
    return true;
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

  /** 티켓 작업 호출. 실패하면 종류에 맞게 티켓을 멈추고 null을 돌려준다. */
  private async ticketCall<S extends z.ZodType>(tk: TicketRow, e: EmployeeRow, task: BrainTask, schema: S, input: unknown, opts: CallOptions = {}): Promise<z.infer<S> | null> {
    try {
      return await this.calls.call(e, task, schema, input, { ticketId: tk.id, orderId: tk.orderId }, { ...opts, ticketType: tk.type });
    } catch (err) {
      if (err instanceof FormatError) {
        this.pauseSystemError(tk, `형식 오류 2회로 멈춤 (${e.id}): ${err.issues}`);
        return null;
      }
      if (isQuiet(err)) {
        this.calls.handleQuietFailure(err, e);
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
}

function ticketInput(tk: TicketRow) {
  return { id: tk.id, title: tk.title, type: tk.type, acceptanceCriteria: tk.acceptanceCriteria };
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
