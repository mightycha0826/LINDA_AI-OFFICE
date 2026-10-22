// 비서실장 MCP 도구 정의 (6장 표 + submit_report). 입력 형식만 있고 DB에 의존하지 않는다.
// MCP 서버(별도 프로세스)와 내부 API가 같은 정의를 쓴다.
import { z } from 'zod';

const ticketId = z.string().regex(/^T-\d+$/, "티켓 번호 형식: 'T-12'");

export const TOOL_DEFS = {
  get_status: {
    description: '회사 현황 요약: 진행 중, 막힘, 결재 대기 건수와 주요 티켓, CEO 접속 상태. 읽기 전용.',
    input: z.object({}),
    writes: false,
  },
  get_ticket: {
    description: '티켓 하나의 상세(상태, 담당자, 완료 조건, 최근 대화 요약). 읽기 전용.',
    input: z.object({ ticketId }),
    writes: false,
  },
  get_pending_approvals: {
    description: 'CEO 결재를 기다리는 목록과 각 Discord 메시지 링크. 읽기 전용.',
    input: z.object({}),
    writes: false,
  },
  get_report_data: {
    description: '지정 시각 이후의 완료, 결재 대기, 막힘, 사용량, 시스템 상태. 정기 보고 작성용. 읽기 전용.',
    input: z.object({ since: z.string().describe('ISO 8601 시각. 예: 2026-10-15T22:00:00+09:00') }),
    writes: false,
  },
  get_usage: {
    description: 'Claude·GPT 몫별 사용량과 남은 양(추정치 여부 포함). 읽기 전용.',
    input: z.object({}),
    writes: false,
  },
  create_order: {
    description:
      '대화에서 업무 의도가 분명해졌을 때만 지시 등록 제안을 준비한다. 이 도구는 지시를 등록하지 않는다. 반환한 내용을 보여 주고 "이 내용으로 지시를 추가할까요?"라고 물은 뒤 사용자의 다음 답변을 기다린다. 잡담, 질문, 감정 표현, 아이디어 탐색에는 호출하지 않는다. Discord 메시지 ID를 모르면 비운다. 위험한 실행은 request_confirmation으로 요청한다.',
    input: z.object({
      rawText: z.string().trim().min(1).max(4000).describe('지금까지 대화에서 사용자가 원한 일과 합의한 범위. 새 요구사항을 지어내지 않는다. 이 내용을 보여 주고 확인받는다'),
      discordMessageId: z.string().regex(/^\d{17,20}$/, 'Discord 메시지 ID(숫자)').optional().describe('모르면 비운다'),
      projectId: z.string().optional().describe('대화에서 확인된 등록 프로젝트 ID. 모르면 비운다'),
    }),
    writes: true,
  },
  respond_order_proposal: {
    description: '지시 등록 여부를 질문한 다음 사용자가 답한 차례에만 호출한다. 명확히 등록을 원하면 register, 계속 대화하거나 등록을 원치 않으면 chat. 모호한 답, 다른 질문, 수정 요청이면 등록하지 말고 대화를 이어간다. 내용을 수정했으면 create_order로 새 제안을 만들고 다시 묻는다. 같은 차례의 자동 등록은 거부된다.',
    input: z.object({
      proposalId: z.string().uuid().describe('create_order가 반환한 등록 제안 ID'),
      decision: z.enum(['register', 'chat']),
    }),
    writes: true,
  },
  request_confirmation: {
    description:
      '위험한 작업(push, main 병합, 되돌리기)을 직접 하지 않고 결재함에 확인 버튼을 띄워 달라고 요청한다. 실행은 CEO가 버튼을 눌러야만 일어난다.',
    input: z.object({
      kind: z.enum(['push', 'main-merge', 'revert']),
      targetId: ticketId,
      reason: z.string().max(500).describe('CEO가 한 말 요약'),
    }),
    writes: true,
  },
  submit_report: {
    description:
      '정기 보고문을 제출한다. GPT 관문 검사를 거쳐 통과하면 시스템 봇이 #보고에 결재 대기 목록과 함께 올린다. 반려되면 지적 사항을 돌려주니 고쳐서 다시 낸다(최대 2번).',
    input: z.object({ text: z.string().min(1).max(6000) }),
    writes: true,
  },
} as const;

export type ToolName = keyof typeof TOOL_DEFS;
export const TOOL_NAMES = Object.keys(TOOL_DEFS) as ToolName[];
