// 화면 글자 모음: 시각, 경과 시간, 상태 이름. 말투는 포인트 디자인 시스템의 해요체.
import type { DerivedStatus, ScreenEmployee, ScreenTicket, StaffRank, TicketStatus, TicketType } from '@ai-office/shared';

/** 캐릭터 이름이 있으면 `한주아 · 개발자 A`, 없으면 직함만 */
export function fullName(e: Pick<ScreenEmployee, 'displayName' | 'personalName'>) {
  return e.personalName ? `${e.personalName} · ${e.displayName}` : e.displayName;
}

export function clock(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat('ko-KR', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

export function hourIn(iso: string, timeZone: string) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).format(new Date(iso))) % 24;
}

export function dayIn(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

export function elapsed(fromIso: string | null, nowMs: number) {
  if (!fromIso) return '';
  const m = Math.max(0, Math.floor((nowMs - new Date(fromIso).getTime()) / 60_000));
  if (m < 1) return '방금';
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 ${m % 60}분`;
  return `${Math.floor(h / 24)}일`;
}

export const STATUS_LABEL: Record<TicketStatus, string> = {
  planned: '대기',
  in_progress: '진행 중',
  in_review: '검토 중',
  rework: '재작업',
  meeting: '회의 중',
  blocked: '막힘',
  awaiting_approval: '결재 대기',
  done: '완료',
  cancelled: '취소',
  paused: '일시정지',
};

export const TYPE_LABEL: Record<TicketType, string> = {
  coding: '개발',
  research: '리서치',
  marketing: '마케팅',
  strategy: '경영',
  writing: '글쓰기',
};

export const PAUSE_LABEL: Record<NonNullable<ScreenTicket['pauseReason']>, string> = {
  'ceo-stop': 'CEO 정지',
  budget: '한도 소진',
  offline: '연결 끊김',
  'system-error': '시스템 오류',
  cap: '상한 도달',
};

// 8장 (2026-10-19): 리서치 몫은 기획실장이 쓰는 "기획 몫", GPT는 직원 전체가 함께 쓰는 "GPT 몫"
export const BUDGET_LABEL = { dev: '개발 몫', research: '기획 몫', review: 'GPT 몫' } as const;

export const RANK_LABEL: Record<StaffRank, string> = { lead: '팀장', member: '팀원', assistant: '보조', temp: '방문' };

export const WORK_LABEL: Record<DerivedStatus, string> = {
  idle: '대기 중',
  working: '작업 중',
  reviewing: '검토 중',
  meeting: '회의 중',
  blocked: '막힘',
  paused: '일시정지',
  away: '나감',
};

export const pct = (v: number) => `${Math.round(v)}%`;
