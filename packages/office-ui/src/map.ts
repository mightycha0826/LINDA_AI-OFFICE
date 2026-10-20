// 사무실 지도 (12장): 격자 가로 30칸 × 세로 20칸(3:2). 좌표는 칸 단위, 화면 크기에 맞춰 늘고 준다.
// 방은 개편 조직도(2-0)의 부서 하나씩이다. 위 줄: 개발팀 · 품질보증팀 · 기획실 · CEO실, 아래 줄: 마케팅 · 콘텐츠팀 · 리서치 · 전략팀 · 회의실 · 운영지원 · 서버실.
// 자리는 방마다 뒷줄(팀장·팀원)과 앞줄(보조 직원·방문 자리)로 둔다. 이름표가 겹치지 않게 같은 높이의 자리는 3.5칸 넘게 띄우고,
// 셋이 나란히 앉는 개발팀은 팀장을 한 칸 남짓 위로 올려 엇갈리게 앉힌다(지도 폭 700px에서도 이름표가 안 겹치게).
// 이동은 복도의 경유 지점을 잇는 최단 경로로만 걷는다(복잡한 길찾기를 쓰지 않음).

export const GRID = { w: 30, h: 20 } as const;

export interface Point {
  x: number;
  y: number;
}

export type RoomId = 'dev' | 'qa' | 'plan' | 'ceo' | 'mkt' | 'research' | 'meeting' | 'ops' | 'server';

export interface Room {
  id: RoomId;
  name: string;
  /** 이 방에 앉는 부서 (직원 표의 department). 회의실·서버실은 비어 있다 */
  departments: readonly string[];
  x: number;
  y: number;
  w: number;
  h: number;
  door: Point;
}

const TOP = { y: 0.5, h: 8.5 } as const;
const BOTTOM = { y: 10.5, h: 9 } as const;
export const CORRIDOR_Y = 9.75;

/** 위 줄 방은 아래 벽에, 아래 줄 방은 위 벽에 문이 있다 */
function room(id: RoomId, name: string, departments: readonly string[], x: number, w: number, row: typeof TOP | typeof BOTTOM): Room {
  const doorY = row === TOP ? row.y + row.h : row.y;
  return { id, name, departments, x, y: row.y, w, h: row.h, door: { x: x + w / 2, y: doorY } };
}

export const ROOMS: Room[] = [
  room('dev', '개발팀', ['개발팀'], 0.5, 11.5, TOP),
  room('qa', '품질보증팀', ['품질보증팀'], 12.5, 4.5, TOP),
  room('plan', '기획실', ['기획실'], 17.5, 4.5, TOP),
  room('ceo', 'CEO실', ['CEO실'], 22.5, 7, TOP),
  room('mkt', '마케팅 · 콘텐츠팀', ['마케팅 · 콘텐츠팀'], 0.5, 7, BOTTOM),
  room('research', '리서치 · 전략팀', ['리서치 · 전략팀'], 8, 4.5, BOTTOM),
  room('meeting', '회의실', [], 13, 6, BOTTOM),
  room('ops', '운영지원', ['운영지원'], 19.5, 6.5, BOTTOM),
  room('server', '서버실', [], 26.5, 3, BOTTOM),
];

/** 임시 직원이 드나드는 문 */
export const ENTRANCE: Point = { x: 0.4, y: CORRIDOR_Y };
/** 위치를 모를 때 서 있는 곳: 복도 가운데 */
export const CORRIDOR_MID: Point = { x: GRID.w / 2, y: CORRIDOR_Y };

// 줄 높이: 발 위치. 뒷줄 이름표(두 줄)가 앞줄 그림과 겹치지 않게 3칸 넘게 띄운다
const BACK_TOP = 4.4;
const FRONT_TOP = 7.8;
const BACK_BOTTOM = 14.2;
const FRONT_BOTTOM = 17.6;

/** 상시 직원 자리. 방은 부서를 따른다(map.test.ts가 확인) */
export const DESKS: Record<string, Point> = {
  // 개발팀: 개발팀장(가운데, 한 칸 위) · 개발자 A · 개발자 B, 앞줄 변경 요약가
  developer: { x: 6.25, y: 3.7 },
  'dev-a': { x: 2.4, y: 4.9 },
  'dev-b': { x: 10.1, y: 4.9 },
  'diff-summarizer': { x: 4.3, y: FRONT_TOP },
  // 품질보증팀: 리뷰어(팀장) · 교정 담당
  reviewer: { x: 14.75, y: BACK_TOP },
  'qa-local': { x: 14.75, y: FRONT_TOP },
  // 기획실: 기획실장 · 회고 서기
  pm: { x: 19.75, y: BACK_TOP },
  'retro-scribe': { x: 19.75, y: FRONT_TOP },
  // CEO실: 비서실장, 보고 초안가 · 막힘 해설가 (CEO 책상은 위쪽 가운데)
  'chief-of-staff': { x: 25, y: 5.4 },
  briefer: { x: 24, y: 8.1 },
  explainer: { x: 27.8, y: 8.1 },
  // 마케팅 · 콘텐츠팀: 카피라이터(팀장) · 초안 작가
  marketing: { x: 4, y: BACK_BOTTOM },
  drafter: { x: 2.1, y: FRONT_BOTTOM },
  // 리서치 · 전략팀: 전략가 (앞줄은 검색 사서 자리, 지금은 방문 자리)
  strategy: { x: 10.25, y: BACK_BOTTOM },
  // 운영지원: Git 고양이, 커밋 서기, 거울 통역사
  'git-cat': { x: 21.1, y: BACK_BOTTOM },
  'commit-scribe': { x: 24.6, y: BACK_BOTTOM },
  interpreter: { x: 21.1, y: FRONT_BOTTOM },
};

/** 임시 직원 자리 (스프라이트 세트 temp-1 … temp-4 순서) */
export const TEMP_SLOTS: Point[] = [
  { x: 5.7, y: FRONT_BOTTOM },
  { x: 10.25, y: FRONT_BOTTOM },
  { x: 8.4, y: FRONT_TOP },
  { x: 16, y: 18.3 },
];

export const MEETING_CHAIRS: Point[] = [
  { x: 14.2, y: 15.8 },
  { x: 17.8, y: 15.8 },
];

export const CEO_DESK: Point = { x: 26, y: 2.6 };
// 결재함: CEO실 문 앞 복도 (12장 "문 앞 결재함")
export const APPROVAL_TRAY: Point = { x: 27.4, y: 9.6 };
export const MAILBOX: Point = { x: 24.6, y: 18.2 };
export const RACKS: Point[] = [
  { x: 27.3, y: 13.2 },
  { x: 28.7, y: 13.2 },
];
/** 올라간 로컬 모델 이름 */
export const MODEL_NOTE: Point = { x: 28, y: 18.6 };
/** 예산 게이지: 지도 오른쪽 가장자리 */
export const BUDGET_GAUGE = { x: 29.62, y: 1, h: 7 } as const;

export function roomAt(p: Point): Room | null {
  return ROOMS.find((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) ?? null;
}

/** 이 부서가 앉는 방. 모르는 부서(임시 직원 등)는 null */
export function roomOfDepartment(department: string): Room | null {
  return ROOMS.find((r) => r.departments.includes(department)) ?? null;
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
