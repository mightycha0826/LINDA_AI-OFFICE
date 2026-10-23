// 화면용 이벤트 종류 (DESIGN.md 12장 데이터 흐름). events 테이블의 type 값.
export const OFFICE_EVENT_TYPES = [
  'order.created',
  'plan.status',
  'ticket.status',
  'message.sent',
  'approval.requested',
  'approval.decided',
  'meeting.minutes',
  'employee.status',
  'employee.move',
  'model.loaded',
  'usage.updated',
  'git.commit',
  'git.push',
  'system.paused',
  'system.resumed',
  'ceo.presence',
] as const;
export type OfficeEventType = (typeof OFFICE_EVENT_TYPES)[number];
