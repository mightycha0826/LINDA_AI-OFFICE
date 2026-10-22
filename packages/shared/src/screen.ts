// 사무실 화면 데이터 (12장 데이터 흐름). 화면 서버와 화면(UI)이 같이 쓰는 형식.
import type { EmployeeRole, PauseReason, TempKind, TicketStatus, TicketType } from './domain.ts';

/** 개편 조직도(2-0)의 직급: 팀장, 팀원, 로컬 보조 직원, 임시 직원 */
export type StaffRank = 'lead' | 'member' | 'assistant' | 'temp';

export interface ScreenEmployee {
  id: string;
  displayName: string;
  role: EmployeeRole;
  department: string;
  rank: StaffRank;
  /** 한 줄 "하는 일" (2-0 표). 모르면 빈 문자열 */
  job: string;
  /** 개인 이름 (예: 비서실장 = 백서진, 개발자 A = 한주아). 아직 없으면 null. 지도 이름표·직원 탭·직원 상세에 쓴다 */
  personalName: string | null;
  /** 증명사진 주소 (/assets/portraits/<id>.webp). 화면 서버가 파일이 있을 때만 채운다 (13장) */
  portrait: string | null;
  /** 3D 캐릭터 VRM 주소 (/assets/models/<id>.vrm). 화면 서버가 파일이 있을 때만 채운다. 없으면 3D는 코드 인형 (13장 3D 캐릭터) */
  model: string | null;
  /** 두뇌 이름 (화면 이름표용): 'Claude', 'GPT', 'Gemma', '헤르메스 · Gemma', '코드' */
  brainLabel: string;
  spriteSet: string;
  isTemporary: boolean;
  tempKind: TempKind | null;
  leftAt: string | null;
}

export interface ScreenTicket {
  id: string;
  /** 이 티켓을 만든 지시 (2026-10-22: 업무 탭 프로젝트별 묶음) */
  orderId: string;
  /** 지시의 프로젝트. 프로젝트 없는 지시(조사·글쓰기 등)면 null */
  projectId: string | null;
  title: string;
  type: TicketType;
  status: TicketStatus;
  pausedFrom: TicketStatus | null;
  pauseReason: PauseReason | null;
  assigneeId: string;
  reviewerId: string;
  reworkCount: number;
  needsCeoApproval: boolean;
  branch: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  tokensUsed: number;
  turnsUsed: number;
  lowPrecision: boolean;
}

export interface ScreenProject {
  id: string;
  repoUrl: string;
}

export interface ScreenOrder {
  id: string;
  projectId: string | null;
  /** 지시 원문 앞부분 (한 줄) */
  text: string;
  createdAt: string;
}

export interface ScreenApproval {
  id: string;
  kind: string;
  targetId: string;
  summary: string;
  reversible: string;
  link: string | null;
  createdAt: string;
}

export interface ScreenUsage {
  budget: 'dev' | 'research' | 'review';
  fiveHour: number;
  fiveHourLimit: number | null;
  weekly: number;
  weeklyLimit: number | null;
  blockedUntil: string | null;
}

export interface ScreenLogEntry {
  id: string;
  at: string;
  ticketId: string | null;
  fromId: string;
  toId: string | null;
  kind: string;
  text: string;
  /** 회의록이면 true (로그 탭 "회의" 필터) */
  minutes: boolean;
}

/** 제공자가 알려 준 계정 전체 사용률(주인 개인 사용 포함, 실측). 마지막 호출 때 값 */
export interface ScreenAccountUsage {
  fiveHourPct: number | null;
  weeklyPct: number | null;
  fiveHourResetsAt: string | null;
  weeklyResetsAt: string | null;
  status: string | null;
  at: string;
}

export interface ScreenSystem {
  startedAt: string;
  stopped: boolean;
  online: boolean;
  ceoPresent: boolean;
  loadedModel: string | null;
  lastModelSwitchAt: string | null;
  gpu: { usedMB: number; totalMB: number } | null;
  lastError: string | null;
  /** 계정 전체 사용률(실측). Claude는 stream-json의 rate_limit_event (0단계 #5) */
  account: { claude: ScreenAccountUsage | null };
  /** 개인용 여유 = 100 - 회사 몫 (8장) */
  personalReserve: { claudeFiveHour: number; claudeWeekly: number; gptFiveHour: number; gptWeekly: number };
}

export interface Snapshot {
  companyName: string;
  combo: number;
  timezone: string;
  checkTimes: string[];
  nextReport: string;
  now: string;
  lastSeq: number;
  employees: ScreenEmployee[];
  tickets: ScreenTicket[];
  /** 등록된 프로젝트 (/새프로젝트) */
  projects: ScreenProject[];
  /** 화면에 보이는 티켓의 지시 (프로젝트별 묶음의 둘째 단) */
  orders: ScreenOrder[];
  approvals: ScreenApproval[];
  usage: ScreenUsage[];
  estimated: boolean;
  log: ScreenLogEntry[];
  /** 푸시 중인 티켓 (승인된 푸시 결재 뒤 결과가 아직 없음) */
  pushing: string[];
  system: ScreenSystem;
}

export type DerivedStatus = 'idle' | 'working' | 'reviewing' | 'meeting' | 'blocked' | 'paused' | 'away';

/**
 * 직원의 지금 상태를 티켓에서 계산한다. 화면 서버와 UI가 같은 규칙을 쓴다.
 * 막힘 > 회의 > 작업 > 검토 > 일시정지 > 대기 순으로 우선한다.
 */
export function deriveEmployeeStatus(employeeId: string, tickets: Pick<ScreenTicket, 'status' | 'assigneeId' | 'reviewerId' | 'pausedFrom'>[], leftAt: string | null = null): DerivedStatus {
  if (leftAt) return 'away';
  const mine = tickets.filter((t) => t.assigneeId === employeeId || t.reviewerId === employeeId);
  const has = (pred: (t: (typeof mine)[number]) => boolean) => mine.some(pred);
  if (has((t) => t.status === 'blocked' && t.assigneeId === employeeId)) return 'blocked';
  if (has((t) => t.status === 'meeting')) return 'meeting';
  if (has((t) => (t.status === 'in_progress' || t.status === 'rework') && t.assigneeId === employeeId)) return 'working';
  if (has((t) => t.status === 'in_review' && t.reviewerId === employeeId)) return 'reviewing';
  if (has((t) => t.status === 'paused')) return 'paused';
  return 'idle';
}

/** 직원이 지금 붙잡고 있는 티켓 (이름표 옆 표시용) */
export function currentTicketOf(employeeId: string, tickets: ScreenTicket[]): ScreenTicket | null {
  const order: TicketStatus[] = ['blocked', 'meeting', 'in_progress', 'rework', 'in_review', 'awaiting_approval', 'paused'];
  for (const s of order) {
    const t = tickets.find((x) => x.status === s && (x.assigneeId === employeeId || (s === 'in_review' && x.reviewerId === employeeId) || (s === 'meeting' && x.reviewerId === employeeId)));
    if (t) return t;
  }
  return null;
}
