// 티켓 전환표 (DESIGN.md 5장). 전환은 데이터로 정의하고, 판단은 순수 함수 decide()가 한다.
// 표에 없는 전환, 조건이 안 맞는 전환, 요청 주체가 아닌 요청은 모두 거부한다.
import type { PauseReason, ReasonCategory, ResumeCause, TicketStatus } from '@ai-office/shared';
import { TransitionRejected } from '../errors.ts';

export type TicketEvent =
  | { type: 'plan.approved' }
  | { type: 'ticket.submitted' }
  | { type: 'review.passed' }
  /** failedCriteria: 통과하지 못한 완료 조건 문구. 오케스트레이터가 검토 출력에서 뽑는다 */
  | { type: 'review.failed'; reasonCategory: ReasonCategory; failedCriteria: string[] }
  | { type: 'rework.started' }
  | { type: 'meeting.agreed' }
  | { type: 'meeting.failed' }
  | { type: 'meeting.escalated' }
  | { type: 'approval.approved' }
  | { type: 'approval.rejected' }
  | { type: 'ceo.retry' }
  | { type: 'ceo.direct'; note: string }
  | { type: 'ceo.cancel' }
  | { type: 'ceo.revise' }
  | { type: 'guard.pingpong' }
  | { type: 'guard.repeat' }
  | { type: 'system.pause'; reason: PauseReason }
  | { type: 'system.resume'; cause: ResumeCause };
export type TicketEventType = TicketEvent['type'];

/** 요청한 쪽. 결재 봇은 클릭한 Discord 계정 ID를 함께 넘긴다. */
export type Actor =
  | { kind: 'employee'; id: string }
  | { kind: 'approval-bot'; discordUserId: string }
  | { kind: 'orchestrator' };

type Role = 'assignee' | 'reviewer' | 'ceo' | 'orchestrator';

export interface TicketSnapshot {
  status: TicketStatus;
  reworkCount: number;
  needsCeoApproval: boolean;
  assigneeId: string;
  reviewerId: string;
  pausedFrom: TicketStatus | null;
  pauseReason: PauseReason | null;
  /** 직전 반려에서 통과하지 못한 완료 조건 (정렬됨) */
  lastFailedCriteria: string[] | null;
  /** 같은 완료 조건 묶음이 연속으로 반려된 횟수 */
  sameFailCount: number;
}

export interface TransitionContext {
  ceoDiscordId: string;
  /** /정지 중인가. 정지 중에는 /재개 말고는 아무것도 티켓을 깨우지 못한다. */
  systemStopped: boolean;
}

export interface TicketPatch {
  reworkCount?: number;
  pausedFrom?: TicketStatus | null;
  pauseReason?: PauseReason | null;
  lastFailedCriteria?: string[] | null;
  sameFailCount?: number;
}

export interface Decision {
  from: TicketStatus;
  to: TicketStatus;
  rule: string;
  patch: TicketPatch;
}

/** 멈춘 이유별로 티켓을 풀 수 있는 원인 (5장 "멈춘 이유와 풀리는 조건") */
export const RESUMABLE_BY: Record<PauseReason, readonly ResumeCause[]> = {
  'ceo-stop': ['ceo-resume'],
  budget: ['budget-refilled'],
  offline: ['online'],
  'system-error': ['recovered', 'ceo-resume'],
  cap: ['ceo-resume', 'cap-raised'],
};

const PAUSABLE: readonly TicketStatus[] = ['planned', 'in_progress', 'in_review', 'rework', 'meeting', 'blocked', 'awaiting_approval'];

interface Rule {
  name: string;
  from: readonly TicketStatus[];
  event: TicketEventType;
  /** null이면 pausedFrom으로 돌아간다 */
  to: TicketStatus | null;
  by: readonly Role[];
  when?: (t: TicketSnapshot, ev: TicketEvent, ctx: TransitionContext) => boolean;
  patch?: (t: TicketSnapshot, ev: TicketEvent) => TicketPatch;
}

const failedCount = (t: TicketSnapshot) => t.reworkCount + 1; // 반려 횟수는 먼저 올리고 판정한다

/**
 * 같은 완료 조건 묶음이 이 횟수만큼 연속으로 반려되면 회의를 더 열지 않고 막힘 (5장, 2026-10-23 CEO 결정).
 * 1회 재작업 → 2회 회의 → 3회 회의 → 4회 막힘. 회의를 두 번 하고도 같은 조건에서 같은 결과면 사장님께 넘긴다.
 */
export const SAME_FAIL_LIMIT = 4;

/** 비교용 완료 조건 묶음: 중복을 빼고 정렬한다. 문구는 검토 출력 검사가 원문과 같게 강제한다 */
export function failedCriteriaKey(criteria: readonly string[]): string[] {
  return [...new Set(criteria)].sort();
}

function sameCriteria(a: readonly string[] | null, b: readonly string[]): boolean {
  return !!a && a.length === b.length && a.every((x, i) => x === b[i]);
}

/** 이번 반려를 넣은 연속 횟수. 직전 반려와 묶음이 같으면 +1, 다르면 1 */
function sameFailAfter(t: TicketSnapshot, ev: TicketEvent): number {
  const failed = failedCriteriaKey((ev as Extract<TicketEvent, { type: 'review.failed' }>).failedCriteria);
  return sameCriteria(t.lastFailedCriteria, failed) ? t.sameFailCount + 1 : 1;
}

const failPatch = (t: TicketSnapshot, ev: TicketEvent): TicketPatch => ({
  reworkCount: failedCount(t),
  lastFailedCriteria: failedCriteriaKey((ev as Extract<TicketEvent, { type: 'review.failed' }>).failedCriteria),
  sameFailCount: sameFailAfter(t, ev),
});

/** 통과하거나 사장님이 손대면 같은 반려 횟수는 처음부터 다시 센다 */
const clearRepeat = (): TicketPatch => ({ lastFailedCriteria: null, sameFailCount: 0 });

export const TRANSITIONS: readonly Rule[] = [
  { name: '계획 승인', from: ['planned'], event: 'plan.approved', to: 'in_progress', by: ['ceo'] },
  { name: '제출', from: ['in_progress'], event: 'ticket.submitted', to: 'in_review', by: ['assignee'] },
  { name: '통과·결재 불필요', from: ['in_review'], event: 'review.passed', to: 'done', by: ['reviewer'], when: (t) => !t.needsCeoApproval, patch: clearRepeat },
  { name: '통과·결재 필요', from: ['in_review'], event: 'review.passed', to: 'awaiting_approval', by: ['reviewer'], when: (t) => t.needsCeoApproval, patch: clearRepeat },
  {
    name: '같은 조건 반복 반려 → 막힘',
    from: ['in_review'],
    event: 'review.failed',
    to: 'blocked',
    by: ['reviewer'],
    when: (t, ev) => sameFailAfter(t, ev) >= SAME_FAIL_LIMIT,
    patch: failPatch,
  },
  {
    name: '반려(2회 미만)',
    from: ['in_review'],
    event: 'review.failed',
    to: 'rework',
    by: ['reviewer'],
    when: (t) => failedCount(t) < 2,
    patch: failPatch,
  },
  {
    name: '반려(2회째 이상)',
    from: ['in_review'],
    event: 'review.failed',
    to: 'meeting',
    by: ['reviewer'],
    when: (t) => failedCount(t) >= 2,
    patch: failPatch,
  },
  { name: '재작업 시작', from: ['rework'], event: 'rework.started', to: 'in_progress', by: ['orchestrator'] },
  { name: '회의 합의', from: ['meeting'], event: 'meeting.agreed', to: 'in_progress', by: ['orchestrator'] },
  { name: '회의 불합의', from: ['meeting'], event: 'meeting.failed', to: 'blocked', by: ['orchestrator'] },
  { name: '회의 사장님 판단 요청', from: ['meeting'], event: 'meeting.escalated', to: 'blocked', by: ['orchestrator'] },
  { name: 'CEO 승인', from: ['awaiting_approval'], event: 'approval.approved', to: 'done', by: ['ceo'] },
  // CEO 결재 반려는 반려 횟수에 넣지 않는다
  { name: 'CEO 반려', from: ['awaiting_approval'], event: 'approval.rejected', to: 'rework', by: ['ceo'], patch: clearRepeat },
  { name: 'CEO 다시 시도', from: ['blocked'], event: 'ceo.retry', to: 'in_progress', by: ['ceo'], patch: clearRepeat },
  { name: 'CEO 방향 지시', from: ['blocked'], event: 'ceo.direct', to: 'in_progress', by: ['ceo'], patch: clearRepeat },
  { name: 'CEO 취소', from: ['blocked'], event: 'ceo.cancel', to: 'cancelled', by: ['ceo'] },
  // 직원 직접 지시의 진행 중 수정 (9장, 2026-10-21): 검토 중이면 검토를 멈추고 새 완료 조건으로 다시 작업
  { name: 'CEO 수정 요청', from: ['in_review'], event: 'ceo.revise', to: 'rework', by: ['ceo'], patch: clearRepeat },
  { name: '핑퐁 → 회의', from: ['in_progress', 'in_review', 'rework'], event: 'guard.pingpong', to: 'meeting', by: ['orchestrator'] },
  { name: '회의 중 핑퐁 → 막힘', from: ['meeting'], event: 'guard.pingpong', to: 'blocked', by: ['orchestrator'] },
  // 같은 반려가 이미 기준만큼 쌓인 티켓(기존 기록으로 채운 티켓)은 더 진행하지 않는다 (2026-10-23)
  {
    name: '반복 반려 누적 → 막힘',
    from: ['in_progress', 'in_review', 'rework', 'meeting'],
    event: 'guard.repeat',
    to: 'blocked',
    by: ['orchestrator'],
    when: (t) => t.sameFailCount >= SAME_FAIL_LIMIT,
  },
  {
    name: '일시정지',
    from: PAUSABLE,
    event: 'system.pause',
    to: 'paused',
    // /정지는 CEO만 건다
    by: ['orchestrator', 'ceo'],
    patch: (t, ev) => ({ pausedFrom: t.status, pauseReason: (ev as Extract<TicketEvent, { type: 'system.pause' }>).reason }),
  },
  {
    name: '재개',
    from: ['paused'],
    event: 'system.resume',
    to: null,
    by: ['orchestrator', 'ceo'],
    when: (t, ev, ctx) => {
      const cause = (ev as Extract<TicketEvent, { type: 'system.resume' }>).cause;
      if (!t.pauseReason || !RESUMABLE_BY[t.pauseReason].includes(cause)) return false;
      return !ctx.systemStopped || cause === 'ceo-resume';
    },
    patch: () => ({ pausedFrom: null, pauseReason: null }),
  },
];

/** CEO 계정으로만 낼 수 있는 이벤트 세부값 */
function requiresCeo(ev: TicketEvent): boolean {
  return (ev.type === 'system.pause' && ev.reason === 'ceo-stop') || (ev.type === 'system.resume' && ev.cause === 'ceo-resume');
}

function rolesOf(actor: Actor, t: TicketSnapshot, ctx: TransitionContext): Set<Role> {
  const roles = new Set<Role>();
  if (actor.kind === 'employee') {
    if (actor.id === t.assigneeId) roles.add('assignee');
    if (actor.id === t.reviewerId) roles.add('reviewer');
  } else if (actor.kind === 'approval-bot') {
    if (actor.discordUserId === ctx.ceoDiscordId) roles.add('ceo');
  } else {
    roles.add('orchestrator');
  }
  return roles;
}

export function decide(t: TicketSnapshot, ev: TicketEvent, actor: Actor, ctx: TransitionContext): Decision {
  const candidates = TRANSITIONS.filter((r) => r.event === ev.type && r.from.includes(t.status));
  if (candidates.length === 0) {
    throw new TransitionRejected('no-transition', `전환표에 없는 전환이에요: ${t.status} --${ev.type}-->`);
  }
  const rule = candidates.find((r) => !r.when || r.when(t, ev, ctx));
  if (!rule) {
    throw new TransitionRejected('condition', `조건이 맞지 않아요: ${t.status} --${ev.type}-->`);
  }
  const roles = rolesOf(actor, t, ctx);
  if (!rule.by.some((r) => roles.has(r)) || (requiresCeo(ev) && !roles.has('ceo'))) {
    throw new TransitionRejected('actor', `요청 주체가 아니에요: ${ev.type} (${actor.kind})`);
  }
  const to = rule.to ?? t.pausedFrom;
  if (!to) throw new TransitionRejected('condition', '돌아갈 상태(pausedFrom)가 없어요');
  return { from: t.status, to, rule: rule.name, patch: rule.patch ? rule.patch(t, ev) : {} };
}
