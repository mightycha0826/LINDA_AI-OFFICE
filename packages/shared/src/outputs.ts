// 직원별 AI 출력 JSON 형식 (DESIGN.md 6장). 오케스트레이터는 이 스키마를 통과한 출력만 다음 단계로 넘긴다.
import { z } from 'zod';
import { CEO_NEED_KINDS, EMPLOYEE_ROLES, PREVENT_STAGES, REASON_CATEGORIES, TEMP_BRAINS, TEMP_KINDS, TICKET_TYPES } from './domain.ts';

const text = z.string().trim().min(1);

export const PlannedTicketSchema = z.object({
  title: text,
  type: z.enum(TICKET_TYPES),
  assignee: text,
  reviewer: text,
  acceptanceCriteria: z.array(text).min(1),
  needsCeoApproval: z.boolean(),
  estimatedTokens: z.number().int().positive(),
});
export type PlannedTicket = z.infer<typeof PlannedTicketSchema>;

/**
 * PM이 요청하는 임시 직원 (2장). 티켓 담당자에 "temp:<key>"로 적는다.
 * brain을 비우면 로컬 Qwen. Claude는 이유(reason)와 함께 요청하고 CEO가 계획서에서 승인해야 쓴다.
 */
export const TempStaffRequestSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,20}$/, '영문 소문자로 시작하는 짧은 이름 (예: writer-1)'),
  kind: z.enum(TEMP_KINDS),
  reason: text,
  brain: z.enum(TEMP_BRAINS).optional(),
});
export type TempStaffRequest = z.infer<typeof TempStaffRequestSchema>;

/** 계획 전에 요구사항부터 확인한다. 질문만 내고 티켓·견적은 만들지 않는다. */
export const PmClarificationOutputSchema = z.object({
  understanding: text,
  questions: z.array(text).max(5),
});

/** PM 계획서. 티켓은 최대 6개 (6장). */
export const PmPlanOutputSchema = z.object({
  goal: text,
  questions: z.array(text),
  tickets: z.array(PlannedTicketSchema).min(1).max(6),
  /** 임시 직원은 계획서당 최대 3명 (2.5단계 결정 E) */
  tempStaff: z.array(TempStaffRequestSchema).max(3),
  /** 코딩 티켓이 있으면 등록된 프로젝트 ID가 필요하다 (11장: 등록된 저장소만 건드린다) */
  projectId: z.string().optional(),
  estimate: z.object({
    claudeDevPct: z.number().min(0),
    claudeResearchPct: z.number().min(0),
    gptPct: z.number().min(0),
    hours: z.number().min(0),
  }),
});
export type PmPlanOutput = z.infer<typeof PmPlanOutputSchema>;

/** 개발자 출력. criteriaSelfCheck는 참고용이고 판정에 쓰지 않는다. */
export const DevOutputSchema = z.object({
  summary: text,
  changedFiles: z.array(text),
  criteriaSelfCheck: z.array(z.object({ criterion: text, claimed: z.boolean() })),
  notes: z.string().optional(),
});
export type DevOutput = z.infer<typeof DevOutputSchema>;

/** 마케팅·경영전략·임시 작가 출력. 근거 없는 주장은 noSource: true로 드러내야 한다. */
export const DocOutputSchema = z.object({
  document: text,
  claims: z.array(
    z
      .object({ text, sources: z.array(z.url()), noSource: z.boolean().optional() })
      .refine((c) => c.sources.length > 0 || c.noSource === true, {
        message: '근거 링크가 없는 주장은 noSource: true로 표시해야 한다',
      }),
  ),
});
export type DocOutput = z.infer<typeof DocOutputSchema>;

/** 리뷰어(코드)와 검토 담당(문서)의 공통 출력. 반려면 분류와 실패한 완료 조건이 있어야 한다. */
export const ReviewOutputSchema = z
  .object({
    verdict: z.enum(['pass', 'fail']),
    criteria: z.array(z.object({ criterion: text, pass: z.boolean(), reason: z.string().optional() })).min(1),
    reasonCategory: z.enum(REASON_CATEGORIES).optional(),
    fixRequests: z.array(text),
  })
  .superRefine((r, ctx) => {
    const anyFailed = r.criteria.some((c) => !c.pass);
    if (r.verdict === 'fail' && !r.reasonCategory) {
      ctx.addIssue({ code: 'custom', message: '반려에는 reasonCategory가 필요하다', path: ['reasonCategory'] });
    }
    if (r.verdict === 'fail' && !anyFailed) {
      ctx.addIssue({ code: 'custom', message: '반려에는 통과하지 못한 완료 조건이 하나 이상 있어야 한다', path: ['criteria'] });
    }
    if (r.verdict === 'pass' && anyFailed) {
      ctx.addIssue({ code: 'custom', message: '통과인데 실패한 완료 조건이 있다', path: ['criteria'] });
    }
  });
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

/** GPT 감사관 관문 검사. */
export const GateOutputSchema = z.object({
  passed: z.boolean(),
  issues: z.array(text),
  objection: z.string().nullable(),
});
export type GateOutput = z.infer<typeof GateOutputSchema>;

/** 회의 한 라운드에서 한 사람의 입장. 회의록은 이 JSON에서 코드가 만든다. */
export const MeetingPositionSchema = z.object({
  claim: text,
  agree: z.boolean(),
  nextActions: z.array(text),
  /** 다시 작업해도 완료 조건을 채울 수 없을 때만 적는다. 한 명이라도 적으면 막힘 (2026-10-23) */
  needsCeo: z.object({ kind: z.enum(CEO_NEED_KINDS), question: text }).optional(),
});
export type MeetingPosition = z.infer<typeof MeetingPositionSchema>;

/**
 * 교정 담당 1차 점검 (16장 7-4). 지적 목록만 낸다. 합격·불합격 판정은 하지 않는다(그것은 검토자 몫).
 * missingCriteria: 완료 조건 중 결과물에서 찾지 못한 항목 (원문 그대로)
 */
export const ProofreadOutputSchema = z.object({
  issues: z
    .array(z.object({ kind: z.enum(['spelling', 'tone', 'missing', 'unclear']), where: text, note: text }))
    .max(20),
  missingCriteria: z.array(text),
});
export type ProofreadOutput = z.infer<typeof ProofreadOutputSchema>;

// --- 로컬 보조 직원 (16장 7-5). 모두 참고용 글이다. 상태 전환·결재·판정에 쓰지 않는다 ---------------

/** 막힘 해설가: 무엇이·왜·다음에 누를 것, 2~3줄 */
export const ExplainOutputSchema = z.object({ lines: z.array(text.max(200)).min(1).max(3) });
export type ExplainOutput = z.infer<typeof ExplainOutputSchema>;

/** 변경 요약가: 푸시 결재 전 diff 요약, 5줄 이내 */
export const DiffSummarySchema = z.object({ lines: z.array(text.max(160)).min(1).max(5) });
export type DiffSummary = z.infer<typeof DiffSummarySchema>;

/** 거울 통역사: 직원끼리 주고받은 JSON을 사람이 읽는 문장으로 */
export const InterpretOutputSchema = z.object({ text: text.max(600) });
export type InterpretOutput = z.infer<typeof InterpretOutputSchema>;

/**
 * 직원 봇 대화 (9장, 2026-10-20): 주인이 멘션한 직원 봇의 답. 로컬 Gemma, 참고용.
 * intent로 지시·수정을 알아본다. 제안은 다음 명확한 동의 또는 확인 버튼 뒤에만 실행한다(core/direct.ts).
 */
export const StaffChatOutputSchema = z.object({
  text: text.max(800),
  intent: z.enum(['chat', 'order', 'revise']),
  /** order: 대화에서 합의한 전체 요청. 마지막 답변 한 줄로 앞선 요구사항을 잃지 않는다. */
  request: z.string().trim().max(2000).optional(),
  /** order: 티켓 제목 */
  title: z.string().trim().max(60).optional(),
  /** order: 확인할 수 있는 완료 조건 1~4개 */
  criteria: z.array(text.max(150)).max(4).optional(),
  /** revise: 지금 하는 일에 붙일 고칠 점 */
  note: z.string().trim().max(300).optional(),
});
export type StaffChatOutput = z.infer<typeof StaffChatOutputSchema>;

/** 보고 초안가: 비서실장 보고가 없을 때의 정기 보고 본문 (숫자는 회사 데이터에서만) */
export const ReportDraftSchema = z.object({ text: text.max(1500) });
export type ReportDraft = z.infer<typeof ReportDraftSchema>;

/** 로컬 직원의 검색 1단계: 검색어 (15장, 2.5단계 결정 C). 오케스트레이터가 SearXNG로 검색한다. */
export const SearchQueriesSchema = z.object({
  queries: z.array(text).min(1).max(3),
});
export type SearchQueries = z.infer<typeof SearchQueriesSchema>;

/** 디자인 시스템 담당: 포인트 조합 선택 (6장, 17장). */
export const DesignComboOutputSchema = z.object({
  combo: z.number().int().min(1).max(10),
  mode: z.enum(['light', 'dark']),
  reason: text,
});
export type DesignComboOutput = z.infer<typeof DesignComboOutputSchema>;

// --- 회고와 학습 (14장) -------------------------------------------------------

/** 티켓 회고: 세 가지만 쓴다. 무엇이 틀렸나, 왜 틀렸나, 어느 단계에서 막을 수 있었나 */
export const TicketRetroSchema = z.object({
  whatWrong: text,
  why: text,
  preventAt: z.enum(PREVENT_STAGES),
});
export type TicketRetro = z.infer<typeof TicketRetroSchema>;

/** 검토 담당의 회고 확인 */
export const RetroCheckSchema = z.object({
  confirmed: z.boolean(),
  note: z.string(),
});
export type RetroCheck = z.infer<typeof RetroCheckSchema>;

/** 규칙 후보 (14장 3). 문제가 생긴 곳보다 앞단에서 막는 규칙을 우선한다 */
export const RuleCandidateSchema = z.object({
  scope: z.object({ role: z.enum(EMPLOYEE_ROLES).optional(), ticketType: z.enum(TICKET_TYPES).optional() }),
  rule: text.max(200),
  evidence: z.array(z.string().regex(/^T-\d+$/)).min(1).max(10),
  reasonCategory: z.enum(REASON_CATEGORIES),
});
export type RuleCandidate = z.infer<typeof RuleCandidateSchema>;

/** 주간 회고: 요약과 규칙 후보(최대 3개) */
export const WeeklyRetroSchema = z.object({
  summary: text,
  candidates: z.array(RuleCandidateSchema).max(3),
});
export type WeeklyRetro = z.infer<typeof WeeklyRetroSchema>;
