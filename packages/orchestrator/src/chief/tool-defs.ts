// 비서실장 MCP 도구 정의 (6장 표 + submit_report). 입력 형식만 있고 DB에 의존하지 않는다.
// MCP 서버(별도 프로세스)와 내부 API가 같은 정의를 쓴다.
// 2026-10-22 CEO 결정으로 넓힘: 읽기 도구 4개, 확인 버튼 요청(request_action), 비상 정지(emergency_stop).
// 결재(계획서·푸시 등), PM 질문 답변, /재개는 사장님이 직접 한다. 그런 도구는 두지 않는다.
import { z } from 'zod';

const ticketId = z.string().regex(/^T-\d+$/, "티켓 번호 형식: 'T-12'");

/** request_action으로 띄울 수 있는 확인 버튼. 실행은 사장님이 버튼을 눌러야 한다 (chief/requests.ts) */
export const CHIEF_REQUEST_KINDS = ['new-project', 'setting', 'guest-on', 'guest-off', 'retry-ticket', 'cancel-ticket', 'retry-plan', 'cancel-plan'] as const;
export type ChiefRequestKind = (typeof CHIEF_REQUEST_KINDS)[number];

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
  get_ticket_log: {
    description: '티켓 하나의 대화 기록(작업·검토·인계·시스템 기록)과 회의록. 왜 막혔는지, 누가 무슨 말을 했는지 볼 때. 읽기 전용.',
    input: z.object({ ticketId, limit: z.number().int().min(1).max(50).optional().describe('최근 몇 개까지 볼지. 비우면 20') }),
    writes: false,
  },
  get_order: {
    description: '지시와 계획서. orderId를 비우면 최근 지시 목록, 넣으면 그 지시의 원문·최신 계획서(목표·질문·티켓·예상 사용량·관문 결과)·티켓 상태. 읽기 전용.',
    input: z.object({ orderId: z.string().regex(/^O-\d+$/, "지시 번호 형식: 'O-3'").optional() }),
    writes: false,
  },
  get_staff: {
    description: '직원 목록: 이름·직함·역할·두뇌·상태·맡은 티켓, 파견 직원(친구 계정)의 출근 여부와 사용률. 읽기 전용.',
    input: z.object({}),
    writes: false,
  },
  get_projects: {
    description: '등록된 프로젝트: 저장소 주소, 기본 브랜치, 테스트 명령, Discord 작업 채널이 있는지. 읽기 전용.',
    input: z.object({}),
    writes: false,
  },
  get_memory: {
    description: '회사 기억: 사장님이 PM 질문에 답하거나 /기억으로 적어 둔 원문. projectId를 주면 회사 전체와 그 프로젝트 것만. 사장님께 같은 것을 다시 묻기 전에 본다. 읽기 전용.',
    input: z.object({ projectId: z.string().optional() }),
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
  request_action: {
    description:
      '사장님 확인 버튼을 #결재함에 띄워 달라고 요청한다: 새 프로젝트 만들기(new-project), /설정 바꾸기(setting), 파견 직원 출근·퇴근(guest-on·guest-off), 막힌 티켓 다시 시도·취소(retry-ticket·cancel-ticket), 멈춘 계획 작성 다시 시도·취소(retry-plan·cancel-plan). 실행은 사장님이 [실행]을 눌러야만 일어난다. 결재(계획서·푸시)와 PM 질문 답변은 이 도구로 요청할 수 없다.',
    input: z.object({
      kind: z.enum(CHIEF_REQUEST_KINDS),
      target: z.string().trim().min(1).max(100).describe('new-project: 프로젝트 아이디(영문 소문자·숫자·-), setting: 설정 항목 키, guest-*: 파견 직원 아이디, *-ticket: 티켓 번호(T-12), *-plan: 지시 번호(O-3)'),
      value: z.string().trim().max(200).optional().describe('setting일 때 새 값'),
      testCommand: z.string().trim().max(200).optional().describe('new-project일 때 테스트 명령. 비우면 npm test'),
      description: z.string().trim().max(300).optional().describe('new-project일 때 GitHub 저장소 설명'),
      reason: z.string().max(500).describe('사장님이 한 말 요약'),
    }),
    writes: true,
  },
  emergency_stop: {
    description:
      '/정지와 같이 모든 직원을 즉시 멈추고 진행 중인 AI 호출을 끊는다. 사장님이 멈추라고 했거나, 직원들이 이상하게 움직이거나 사용량이 비정상적으로 빨리 닳을 때만 쓴다. 다시 시작(/재개)은 사장님만 할 수 있다.',
    input: z.object({ reason: z.string().trim().min(1).max(500).describe('멈추는 이유. 사장님께 그대로 알린다') }),
    writes: true,
  },
  submit_report: {
    description:
      '정기 보고문을 제출한다. GPT 관문 검사를 거쳐 통과하면 시스템 봇이 #보고에 결재 대기 목록과 함께 올린다. 반려되면 지적 사항을 돌려주니 고쳐서 다시 낸다(최대 2번).',
    input: z.object({ text: z.string().min(1).max(6000) }),
  },
} as const;

export type ToolName = keyof typeof TOOL_DEFS;
export const TOOL_NAMES = Object.keys(TOOL_DEFS) as ToolName[];
