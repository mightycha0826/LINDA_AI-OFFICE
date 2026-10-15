// 직원별 AI 출력 JSON 형식 (DESIGN.md 6장). 오케스트레이터는 이 스키마를 통과한 출력만 다음 단계로 넘긴다.
import { z } from 'zod';
import { REASON_CATEGORIES, TICKET_TYPES } from './domain.ts';

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

/** PM 계획서. 티켓은 최대 6개 (6장). */
export const PmPlanOutputSchema = z.object({
  goal: text,
  questions: z.array(text),
  tickets: z.array(PlannedTicketSchema).min(1).max(6),
  tempStaff: z.array(z.object({ role: text, reason: text })),
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
});
export type MeetingPosition = z.infer<typeof MeetingPositionSchema>;

/** 디자인 시스템 담당: 포인트 조합 선택 (6장, 17장). */
export const DesignComboOutputSchema = z.object({
  combo: z.number().int().min(1).max(10),
  mode: z.enum(['light', 'dark']),
  reason: text,
});
export type DesignComboOutput = z.infer<typeof DesignComboOutputSchema>;
