// 회사 도메인 타입 (DESIGN.md 4장, 5장, 14장).
// 문자열 값 목록은 DB CHECK 제약과 Zod 스키마가 같이 쓰도록 배열로 둔다.

export const TICKET_STATUSES = [
  'planned',
  'in_progress',
  'in_review',
  'rework',
  'meeting',
  'blocked',
  'awaiting_approval',
  'done',
  'cancelled',
  'paused',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_TYPES = ['coding', 'research', 'marketing', 'strategy', 'writing'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export const REASON_CATEGORIES = [
  'criteria-unmet',
  'test-failed',
  'no-evidence',
  'format-error',
  'out-of-scope',
  'security',
] as const;
export type ReasonCategory = (typeof REASON_CATEGORIES)[number];

// 티켓이 멈춘 이유. 티켓마다 하나만 기록한다 (5장 "멈춘 이유와 풀리는 조건").
export const PAUSE_REASONS = ['ceo-stop', 'budget', 'offline', 'system-error', 'cap'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

// 멈춘 티켓을 풀어 주는 원인.
export const RESUME_CAUSES = ['ceo-resume', 'budget-refilled', 'online', 'recovered', 'cap-raised'] as const;
export type ResumeCause = (typeof RESUME_CAUSES)[number];

export const EMPLOYEE_ROLES = [
  'chief-of-staff',
  'pm',
  'developer',
  'reviewer',
  'marketing',
  'strategy',
  'qa-local',
  'git-cat',
  'temp',
  // 로컬 보조 직원 (16장 7-5): 막힘 해설가, 변경 요약가, 거울 통역사, 커밋 서기, 회고 서기, 보고 초안가, 초안 작가
  'assistant',
] as const;
export type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

/** 임시 직원 종류 (2장, 6장). 출력 형식은 가장 가까운 상시 직원을 따른다. */
export const TEMP_KINDS = ['writer', 'designer', 'researcher', 'design-system'] as const;
export type TempKind = (typeof TEMP_KINDS)[number];

/**
 * 로컬 두뇌는 이것 하나다 (16장 7-2). num_ctx 65536을 박은 Gemma 4 12B 태그로, 헤르메스(비서실장)와 같은 모델·같은 문맥이라
 * 번갈아 불러도 Ollama가 다시 올리지 않는다. 태그 만들기는 docs/HERMES-SETUP.md.
 */
export const LOCAL_MODEL = 'gemma4:12b-64k' as const;
export const LOCAL_NUM_CTX = 65_536;

/** 임시 직원이 쓸 수 있는 두뇌. Claude는 개발자 몫에서 깎인다 (8장). 7-2부터 로컬은 LOCAL_MODEL 하나 */
export const TEMP_BRAINS = [LOCAL_MODEL, 'claude'] as const;
export type TempBrain = (typeof TEMP_BRAINS)[number];

export const EMPLOYEE_STATUSES = ['idle', 'working', 'meeting', 'blocked', 'paused'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

/** 앞의 것이 지금 쓰는 모델. qwen3:14b·gemma4:12b는 7-2 전에 저장된 기록을 읽기 위해서만 남긴다 */
export const OLLAMA_MODELS = [LOCAL_MODEL, 'qwen3:14b', 'gemma4:12b'] as const;
export type OllamaModel = (typeof OLLAMA_MODELS)[number];

export type Brain =
  | { provider: 'ollama'; model: OllamaModel }
  | { provider: 'claude-code'; budget: 'dev' | 'research' }
  | { provider: 'codex' }
  | { provider: 'none' }; // Git 고양이

/**
 * 교차 검증에서 "다른 모델"인지 가르는 값 (4장 불변 조건).
 * Ollama는 모델 이름으로 구분하므로 Qwen 작성 → Gemma 검토는 허용된다.
 */
export function brainModel(brain: Brain): string {
  switch (brain.provider) {
    case 'ollama':
      return brain.model;
    case 'claude-code':
      return 'claude';
    case 'codex':
      return 'gpt';
    case 'none':
      return 'none';
  }
}

export const ORDER_CATEGORIES = ['coding', 'research', 'marketing', 'strategy', 'mixed'] as const;
export type OrderCategory = (typeof ORDER_CATEGORIES)[number];

export const ORDER_STATUSES = [
  'planning',
  'awaiting-plan-approval',
  'in-progress',
  'done',
  'rejected',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PLAN_STATUSES = [
  'draft',
  'gate-review',
  'awaiting-ceo',
  'approved',
  'revision-requested',
  'rejected',
  'superseded',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const MESSAGE_KINDS = ['chat', 'review', 'handoff', 'system', 'gate'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const APPROVAL_KINDS = [
  'plan',
  'push',
  'main-merge',
  'deploy',
  'delete',
  'external-send',
  'budget',
  'rule',
  'revert',
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'revision', 'expired'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const REVERSIBILITY = ['reversible', 'partial', 'irreversible'] as const;
export type Reversibility = (typeof REVERSIBILITY)[number];

export const USAGE_PROVIDERS = ['claude', 'gpt', 'ollama'] as const;
export type UsageProvider = (typeof USAGE_PROVIDERS)[number];

export const USAGE_BUDGETS = ['dev', 'research', 'review', 'local'] as const;
export type UsageBudget = (typeof USAGE_BUDGETS)[number];

export const USAGE_SOURCES = ['reported', 'estimated'] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export const RULE_STATUSES = ['proposed', 'active', 'retired'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

export const MEETING_KINDS = ['ticket-meeting', 'gate-review'] as const;
export type MeetingKind = (typeof MEETING_KINDS)[number];

export const MEETING_OUTCOMES = ['agreed', 'disagreed'] as const;
export type MeetingOutcome = (typeof MEETING_OUTCOMES)[number];

// 회고 (14장)
export const RETRO_KINDS = ['ticket', 'weekly'] as const;
export type RetroKind = (typeof RETRO_KINDS)[number];

/** 티켓 회고 "어느 단계에서 막을 수 있었나" */
export const PREVENT_STAGES = ['plan', 'work', 'review', 'test'] as const;
export type PreventStage = (typeof PREVENT_STAGES)[number];
