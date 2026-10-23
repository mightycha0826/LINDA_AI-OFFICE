// 비서실장 MCP 도구 정의 (6장 표 + submit_report). 입력 형식만 있고 DB에 의존하지 않는다.
// MCP 서버(별도 프로세스)와 내부 API가 같은 정의를 쓴다.
import { z } from 'zod';

const ticketId = z.string().regex(/^T-\d+$/, "티켓 번호 형식: 'T-12'");

export const TOOL_DEFS = {
  get_status: {
    description: '회사 현황 요약: 진행 중, 막힘, 결재 대기 건수와 주요 티켓, CEO 접속 상태. 읽기 전용.',
    input: z.object({}),
  },
  get_ticket: {
    description: '티켓 하나의 상세(상태, 담당자, 완료 조건, 최근 대화 요약). 읽기 전용.',
    input: z.object({ ticketId }),
  },
  get_pending_approvals: {
    description: 'CEO 결재를 기다리는 목록과 각 Discord 메시지 링크. 읽기 전용.',
    input: z.object({}),
  },
  get_report_data: {
    description: '지정 시각 이후의 완료, 결재 대기, 막힘, 사용량, 시스템 상태. 정기 보고 작성용. 읽기 전용.',
    input: z.object({ since: z.string().describe('ISO 8601 시각. 예: 2026-10-15T22:00:00+09:00') }),
  },
  get_usage: {
    description: 'Claude·GPT 몫별 사용량과 남은 양(추정치 여부 포함). 읽기 전용.',
    input: z.object({}),
  },
  create_order: {
    description:
      'CEO의 업무 지시를 원문 그대로 등록한다. Discord 메시지 ID를 모르면 discordMessageId는 비운다(지어내지 않는다). 그러면 회사 시스템이 #비서실 CEO 마지막 메시지 ID를 쓴다. 위험한 실행(push, 삭제, 전송)은 이 도구가 아니라 request_confirmation으로 요청한다.',
    input: z.object({
      rawText: z.string().min(1).max(4000).describe('CEO 원문 그대로'),
      discordMessageId: z.string().regex(/^\d{17,20}$/, 'Discord 메시지 ID(숫자)').optional().describe('모르면 비운다'),
    }),
  },
  request_confirmation: {
    description:
      '위험한 작업(push, main 병합, 되돌리기)을 직접 하지 않고 결재함에 확인 버튼을 띄워 달라고 요청한다. 실행은 CEO가 버튼을 눌러야만 일어난다.',
    input: z.object({
      kind: z.enum(['push', 'main-merge', 'revert']),
      targetId: ticketId,
      reason: z.string().max(500).describe('CEO가 한 말 요약'),
    }),
  },
  submit_report: {
    description:
      '정기 보고문을 제출한다. GPT 관문 검사를 거쳐 통과하면 시스템 봇이 #보고에 결재 대기 목록과 함께 올린다. 반려되면 지적 사항을 돌려주니 고쳐서 다시 낸다(최대 2번).',
    input: z.object({ text: z.string().min(1).max(6000) }),
  },
} as const;

export type ToolName = keyof typeof TOOL_DEFS;
export const TOOL_NAMES = Object.keys(TOOL_DEFS) as ToolName[];
