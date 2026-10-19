// 사무실 지도 (12장): 격자 가로 24칸 × 세로 16칸. 좌표는 칸 단위, 화면 크기에 맞춰 늘고 준다.
// 이동은 복도의 경유 지점을 잇는 최단 경로로만 걷는다(복잡한 길찾기를 쓰지 않음).

export const GRID = { w: 24, h: 16 } as const;

export interface Point {
  x: number;
  y: number;
}

export type RoomId = 'dev' | 'plan' | 'ceo' | 'mkt' | 'meeting' | 'git' | 'server';

export interface Room {
  id: RoomId;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  door: Point;
}

export const ROOMS: Room[] = [
  { id: 'dev', name: '개발팀', x: 0.5, y: 0.5, w: 7.75, h: 7, door: { x: 4.375, y: 7.5 } },
  // 방 이름은 2-0 개편 부서를 따른다 (16장 7-5)
  { id: 'plan', name: '기획실 · 품질보증', x: 8.75, y: 0.5, w: 6.5, h: 7, door: { x: 12, y: 7.5 } },
  { id: 'ceo', name: 'CEO실', x: 15.75, y: 0.5, w: 7.75, h: 5.75, door: { x: 19.5, y: 6.25 } },
  { id: 'mkt', name: '마케팅 · 리서치', x: 0.5, y: 9, w: 7.75, h: 6.5, door: { x: 4.375, y: 9 } },
  { id: 'meeting', name: '회의실', x: 8.75, y: 9, w: 6.5, h: 6.5, door: { x: 12, y: 9 } },
  { id: 'git', name: 'Git · 운영지원', x: 15.75, y: 9, w: 4, h: 6.5, door: { x: 17.75, y: 9 } },
  { id: 'server', name: '서버실', x: 20.25, y: 9, w: 3.25, h: 6.5, door: { x: 21.875, y: 9 } },
];

export const CORRIDOR_Y = 8.25;
/** 임시 직원이 드나드는 문 */
export const ENTRANCE: Point = { x: 0.4, y: CORRIDOR_Y };

/** 상시 직원 자리 */
export const DESKS: Record<string, Point> = {
  developer: { x: 2.6, y: 4.8 },
  reviewer: { x: 6.0, y: 4.8 },
  // 개발자 A·B (GPT, 7-3): 개발팀 방 위쪽
  'dev-a': { x: 2.6, y: 2.2 },
  'dev-b': { x: 6.0, y: 2.2 },
  pm: { x: 10.4, y: 4.4 },
  'qa-local': { x: 13.6, y: 4.4 },
  'chief-of-staff': { x: 17.4, y: 4.6 },
  marketing: { x: 2.6, y: 13.2 },
  strategy: { x: 6.0, y: 13.2 },
  'git-cat': { x: 17.0, y: 12.8 },
  // 로컬 보조 직원 (16장 7-5): 각 부서 방
  'diff-summarizer': { x: 7.3, y: 6.4 },
  'retro-scribe': { x: 10.4, y: 2.0 },
  explainer: { x: 20.0, y: 2.2 },
  briefer: { x: 22.2, y: 4.6 },
  drafter: { x: 1.5, y: 11.0 },
  'commit-scribe': { x: 18.6, y: 14.4 },
  interpreter: { x: 21.9, y: 14.4 },
};

/** 임시 직원 자리 (스프라이트 세트 temp-1 … temp-4 순서) */
export const TEMP_SLOTS: Point[] = [
  { x: 4.3, y: 11.6 },
  { x: 12.0, y: 6.0 },
  { x: 7.1, y: 11.6 },
  { x: 4.3, y: 2.8 },
];

export const MEETING_CHAIRS: Point[] = [
  { x: 10.8, y: 12.6 },
  { x: 13.2, y: 12.6 },
];

export const CEO_DESK: Point = { x: 20.6, y: 3.4 };
// 결재함: CEO실 문 앞 복도 (12장 "문 앞 결재함")
export const APPROVAL_TRAY: Point = { x: 20.9, y: 7.0 };
export const MAILBOX: Point = { x: 19.0, y: 14.6 };
export const RACKS: Point[] = [
  { x: 21.2, y: 11.0 },
  { x: 22.6, y: 11.0 },
];

export function roomAt(p: Point): Room | null {
  return ROOMS.find((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) ?? null;
}

/** p에서 q로 걷는 경유 지점들 (p 제외, q 포함) */
export function pathBetween(p: Point, q: Point): Point[] {
  const a = roomAt(p);
  const b = roomAt(q);
  if (a && b && a.id === b.id) return [q];
  const pts: Point[] = [];
  if (a) pts.push(a.door, { x: a.door.x, y: CORRIDOR_Y });
  else pts.push({ x: p.x, y: CORRIDOR_Y });
  if (b) pts.push({ x: b.door.x, y: CORRIDOR_Y }, b.door);
  else pts.push({ x: q.x, y: CORRIDOR_Y });
  pts.push(q);
  // 같은 점이 이어지면 뺀다
  return pts.filter((pt, i) => i === 0 || pt.x !== pts[i - 1]!.x || pt.y !== pts[i - 1]!.y);
}

export function distance(p: Point, q: Point): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

export function deskOf(employeeId: string, spriteSet: string): Point {
  if (DESKS[employeeId]) return DESKS[employeeId];
  const n = Number(/temp-(\d)/.exec(spriteSet)?.[1] ?? 1);
  return TEMP_SLOTS[(n - 1) % TEMP_SLOTS.length]!;
}
