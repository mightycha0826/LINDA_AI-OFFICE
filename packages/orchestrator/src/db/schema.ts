// SQLite 스키마 (DESIGN.md 4장). 불변 조건은 가능한 한 DB 제약으로도 강제한다.
// 쓰기 주체는 오케스트레이터 하나다. 이 파일을 바꾸면 `npm run db:generate -w @ai-office/orchestrator`.
import { sql, type SQL } from 'drizzle-orm';
import { check, index, integer, real, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import {
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  EMPLOYEE_ROLES,
  EMPLOYEE_STATUSES,
  MEETING_KINDS,
  MEETING_OUTCOMES,
  MESSAGE_KINDS,
  OFFICE_EVENT_TYPES,
  ORDER_CATEGORIES,
  ORDER_STATUSES,
  PAUSE_REASONS,
  PLAN_STATUSES,
  REASON_CATEGORIES,
  REVERSIBILITY,
  RULE_STATUSES,
  TICKET_STATUSES,
  TICKET_TYPES,
  USAGE_BUDGETS,
  USAGE_PROVIDERS,
  USAGE_SOURCES,
  type Brain,
  type GateOutput,
  type PlannedTicket,
  type ReasonCategory,
} from '@ai-office/shared';

/** 값 목록은 코드 상수라 안전하다. 사용자 입력을 넣지 않는다. */
function inList(col: AnySQLiteColumn, values: readonly string[]): SQL {
  return sql`${col} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;
}

export const employees = sqliteTable(
  'employees',
  {
    id: text('id').primaryKey(),
    displayName: text('display_name').notNull(),
    role: text('role', { enum: EMPLOYEE_ROLES }).notNull(),
    department: text('department').notNull(),
    brain: text('brain', { mode: 'json' }).$type<Brain>().notNull(),
    spriteSet: text('sprite_set').notNull(),
    status: text('status', { enum: EMPLOYEE_STATUSES }).notNull().default('idle'),
    canSearchWeb: integer('can_search_web', { mode: 'boolean' }).notNull().default(false),
    isTemporary: integer('is_temporary', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [check('employees_role_check', inList(t.role, EMPLOYEE_ROLES)), check('employees_status_check', inList(t.status, EMPLOYEE_STATUSES))],
);

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  repoUrl: text('repo_url').notNull(),
  localPath: text('local_path').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
  testCommand: text('test_command').notNull(),
});

export const orders = sqliteTable(
  'orders',
  {
    id: text('id').primaryKey(),
    // 같은 Discord 메시지로 지시가 두 번 생기지 않게 한다.
    discordMessageId: text('discord_message_id').notNull().unique(),
    rawText: text('raw_text').notNull(),
    category: text('category', { enum: ORDER_CATEGORIES }), // PM이 분류하기 전에는 비어 있다
    projectId: text('project_id').references(() => projects.id),
    status: text('status', { enum: ORDER_STATUSES }).notNull().default('planning'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('orders_status_check', inList(t.status, ORDER_STATUSES)),
    check('orders_category_check', sql`${t.category} IS NULL OR ${inList(t.category, ORDER_CATEGORIES)}`),
  ],
);

export interface PlanEstimate {
  claudeDevPct: number;
  claudeResearchPct: number;
  gptPct: number;
  hours: number;
}

export const plans = sqliteTable(
  'plans',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    version: integer('version').notNull(),
    goal: text('goal').notNull(),
    questions: text('questions', { mode: 'json' }).$type<string[]>().notNull(),
    tickets: text('tickets', { mode: 'json' }).$type<PlannedTicket[]>().notNull(),
    tempStaff: text('temp_staff', { mode: 'json' }).$type<{ role: string; reason: string }[]>().notNull(),
    estimate: text('estimate', { mode: 'json' }).$type<PlanEstimate>().notNull(),
    gateResult: text('gate_result', { mode: 'json' }).$type<GateOutput>(),
    gateAttempts: integer('gate_attempts').notNull().default(0),
    status: text('status', { enum: PLAN_STATUSES }).notNull().default('draft'),
    ceoNote: text('ceo_note'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('plans_order_version_unique').on(t.orderId, t.version),
    // 지시 하나에 살아 있는 계획서는 하나뿐이다. 새 버전이 생기면 이전 버전은 superseded가 돼야 들어갈 수 있다.
    uniqueIndex('plans_one_live_per_order')
      .on(t.orderId)
      .where(inList(t.status, ['draft', 'gate-review', 'awaiting-ceo', 'revision-requested'])),
    check('plans_status_check', inList(t.status, PLAN_STATUSES)),
    check('plans_gate_attempts_check', sql`${t.gateAttempts} >= 0`),
  ],
);

export const tickets = sqliteTable(
  'tickets',
  {
    id: text('id').primaryKey(), // 'T-12'
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id),
    title: text('title').notNull(),
    type: text('type', { enum: TICKET_TYPES }).notNull(),
    assigneeId: text('assignee_id')
      .notNull()
      .references(() => employees.id),
    reviewerId: text('reviewer_id')
      .notNull()
      .references(() => employees.id),
    acceptanceCriteria: text('acceptance_criteria', { mode: 'json' }).$type<string[]>().notNull(),
    status: text('status', { enum: TICKET_STATUSES }).notNull().default('planned'),
    pausedFrom: text('paused_from', { enum: TICKET_STATUSES }),
    pauseReason: text('pause_reason', { enum: PAUSE_REASONS }),
    reworkCount: integer('rework_count').notNull().default(0),
    branch: text('branch'),
    worktreePath: text('worktree_path'),
    needsCeoApproval: integer('needs_ceo_approval', { mode: 'boolean' }).notNull(),
    estimatedTokens: integer('estimated_tokens').notNull(),
    tokensUsed: integer('tokens_used').notNull().default(0),
    turnsUsed: integer('turns_used').notNull().default(0),
    tokenCap: integer('token_cap').notNull(),
    turnCap: integer('turn_cap').notNull(),
    // 핑퐁 차단: 상태가 바뀐 뒤 같은 담당자·검토자 쌍이 연속으로 주고받은 메시지 수
    pingpongCount: integer('pingpong_count').notNull().default(0),
    lowPrecision: integer('low_precision', { mode: 'boolean' }).notNull().default(false),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    // 조건부 업데이트용 행 버전
    version: integer('version').notNull().default(0),
  },
  (t) => [
    check('tickets_status_check', inList(t.status, TICKET_STATUSES)),
    check('tickets_type_check', inList(t.type, TICKET_TYPES)),
    check('tickets_reviewer_not_assignee', sql`${t.reviewerId} <> ${t.assigneeId}`),
    // paused일 때만, 그리고 반드시 pausedFrom과 pauseReason이 있다.
    check(
      'tickets_pause_fields',
      sql`(${t.status} = 'paused') = (${t.pausedFrom} IS NOT NULL) AND (${t.status} = 'paused') = (${t.pauseReason} IS NOT NULL)`,
    ),
    check('tickets_paused_from_check', sql`${t.pausedFrom} IS NULL OR (${t.pausedFrom} <> 'paused' AND ${inList(t.pausedFrom, TICKET_STATUSES)})`),
    check('tickets_pause_reason_check', sql`${t.pauseReason} IS NULL OR ${inList(t.pauseReason, PAUSE_REASONS)}`),
    check('tickets_counts_check', sql`${t.reworkCount} >= 0 AND ${t.tokensUsed} >= 0 AND ${t.turnsUsed} >= 0 AND ${t.pingpongCount} >= 0`),
    index('tickets_status_idx').on(t.status),
    index('tickets_order_idx').on(t.orderId),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id').references(() => tickets.id),
    orderId: text('order_id').references(() => orders.id),
    fromId: text('from_id').notNull(),
    toId: text('to_id'),
    kind: text('kind', { enum: MESSAGE_KINDS }).notNull(),
    content: text('content').notNull(),
    reviewVerdict: text('review_verdict', { enum: ['pass', 'fail'] }),
    reasonCategory: text('reason_category', { enum: REASON_CATEGORIES }),
    tokens: integer('tokens').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('messages_kind_check', inList(t.kind, MESSAGE_KINDS)),
    check('messages_verdict_check', sql`${t.reviewVerdict} IS NULL OR ${t.reviewVerdict} IN ('pass', 'fail')`),
    check('messages_reason_check', sql`${t.reasonCategory} IS NULL OR ${inList(t.reasonCategory, REASON_CATEGORIES)}`),
    // 반려에는 분류가 반드시 있다 (14장)
    check('messages_fail_needs_reason', sql`${t.reviewVerdict} IS NOT 'fail' OR ${t.reasonCategory} IS NOT NULL`),
    index('messages_ticket_idx').on(t.ticketId),
  ],
);

export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: APPROVAL_KINDS }).notNull(),
    targetId: text('target_id').notNull(),
    targetVersion: integer('target_version'),
    status: text('status', { enum: APPROVAL_STATUSES }).notNull().default('pending'),
    // 결재 요청에는 항상 "되돌릴 수 있는지"를 적는다 (7장)
    reversible: text('reversible', { enum: REVERSIBILITY }).notNull(),
    summary: text('summary').notNull(),
    decidedByDiscordId: text('decided_by_discord_id'),
    choice: text('choice'),
    note: text('note'),
    discordMessageId: text('discord_message_id'), // 3단계에서 결재 메시지를 올린 뒤 채운다
    createdAt: text('created_at').notNull(),
    decidedAt: text('decided_at'),
  },
  (t) => [
    check('approvals_kind_check', inList(t.kind, APPROVAL_KINDS)),
    check('approvals_status_check', inList(t.status, APPROVAL_STATUSES)),
    check('approvals_reversible_check', inList(t.reversible, REVERSIBILITY)),
    // 사람이 결정한 것에만 결정자가 있다. expired는 코드가 만든 것이라 결정자가 없다.
    check(
      'approvals_decider_check',
      sql`(${t.status} IN ('approved', 'rejected', 'revision')) = (${t.decidedByDiscordId} IS NOT NULL AND ${t.decidedAt} IS NOT NULL)`,
    ),
    // 같은 대상에 대기 중인 같은 종류의 결재는 하나뿐이다.
    uniqueIndex('approvals_one_pending').on(t.kind, t.targetId).where(sql`${t.status} = 'pending'`),
  ],
);

export const usage = sqliteTable(
  'usage',
  {
    id: text('id').primaryKey(),
    provider: text('provider', { enum: USAGE_PROVIDERS }).notNull(),
    budget: text('budget', { enum: USAGE_BUDGETS }).notNull(),
    ticketId: text('ticket_id').references(() => tickets.id),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    // 같은 호출이라도 5시간 한도 대비 %와 주간 한도 대비 %는 다르다. 둘 다 기록한다.
    estimatedPct: real('estimated_pct').notNull(), // 5시간 한도 대비
    estimatedWeeklyPct: real('estimated_weekly_pct').notNull(), // 주간 한도 대비
    source: text('source', { enum: USAGE_SOURCES }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('usage_provider_check', inList(t.provider, USAGE_PROVIDERS)),
    check('usage_budget_check', inList(t.budget, USAGE_BUDGETS)),
    check('usage_source_check', inList(t.source, USAGE_SOURCES)),
    check('usage_numbers_check', sql`${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0 AND ${t.estimatedPct} >= 0 AND ${t.estimatedWeeklyPct} >= 0`),
    index('usage_budget_time_idx').on(t.budget, t.createdAt),
  ],
);

export const rules = sqliteTable(
  'rules',
  {
    id: text('id').primaryKey(),
    scope: text('scope', { mode: 'json' }).$type<{ role?: string; ticketType?: string }>().notNull(),
    text: text('text').notNull(),
    evidence: text('evidence', { mode: 'json' }).$type<string[]>().notNull(),
    reasonCategory: text('reason_category', { enum: REASON_CATEGORIES }).notNull(),
    status: text('status', { enum: RULE_STATUSES }).notNull().default('proposed'),
    appliedCount: integer('applied_count').notNull().default(0),
    recurrenceCount: integer('recurrence_count').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('rules_status_check', inList(t.status, RULE_STATUSES)),
    check('rules_reason_check', inList(t.reasonCategory, REASON_CATEGORIES)),
  ],
);

export interface MinutesAgendaItem {
  criterion: string;
  reason: string;
  reasonCategory: ReasonCategory;
}
export interface MinutesRound {
  round: number;
  positions: { employeeId: string; claim: string }[];
}

export const meetingMinutes = sqliteTable(
  'meeting_minutes',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id').references(() => tickets.id),
    planId: text('plan_id').references(() => plans.id),
    kind: text('kind', { enum: MEETING_KINDS }).notNull(),
    participants: text('participants', { mode: 'json' }).$type<string[]>().notNull(),
    agenda: text('agenda', { mode: 'json' }).$type<MinutesAgendaItem[]>().notNull(),
    rounds: text('rounds', { mode: 'json' }).$type<MinutesRound[]>().notNull(),
    outcome: text('outcome', { enum: MEETING_OUTCOMES }).notNull(),
    nextActions: text('next_actions', { mode: 'json' }).$type<string[]>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('minutes_kind_check', inList(t.kind, MEETING_KINDS)),
    check('minutes_outcome_check', inList(t.outcome, MEETING_OUTCOMES)),
    check('minutes_target_check', sql`${t.ticketId} IS NOT NULL OR ${t.planId} IS NOT NULL`),
  ],
);

export const events = sqliteTable(
  'events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }), // SSE id로 쓴다
    type: text('type', { enum: OFFICE_EVENT_TYPES }).notNull(),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [check('events_type_check', inList(t.type, OFFICE_EVENT_TYPES))],
);

/** 회사 전체 상태 (예: /정지 여부). 키 하나에 JSON 값 하나. */
export const systemState = sqliteTable('system_state', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
});
