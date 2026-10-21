// 3D 사무실 자리 배치 (12장, 2026-10-21 CEO 결정: 3D 사무실 적용). 화면 데이터(스냅샷)만 보고 누가 어디에 앉는지 정한다.
// WebGL 없이 시험할 수 있게 그림 코드(scene.ts)와 나눴다. 좌표는 미터, 층은 30 × 19.5.
// face: 1 = 남쪽(+z)을 보고 앉음, -1 = 북쪽. seatY: 의자가 아닌 곳(스툴 등)의 앉는 높이
import { deriveEmployeeStatus, type DerivedStatus, type ScreenEmployee, type ScreenTicket } from '@ai-office/shared';

export interface Seat {
  x: number;
  z: number;
  face: 1 | -1;
  seatY?: number;
}

/** 부서 책상 자리 (scene.ts의 공용 책상 좌석과 같은 좌표) */
export const DESK_SEATS: Readonly<Record<string, Seat>> = {
  developer: { x: 2.6, z: 2.0, face: 1 },
  'dev-a': { x: 4.6, z: 2.0, face: 1 },
  'dev-b': { x: 2.6, z: 4.25, face: -1 },
  'diff-summarizer': { x: 4.6, z: 4.25, face: -1 },
  reviewer: { x: 11.4, z: 2.0, face: 1 },
  'qa-local': { x: 13.4, z: 2.0, face: 1 },
  pm: { x: 16.6, z: 2.0, face: 1 },
  'retro-scribe': { x: 18.6, z: 2.0, face: 1 },
  'chief-of-staff': { x: 22.3, z: 5.95, face: -1 },
  briefer: { x: 24.3, z: 5.95, face: -1 },
  explainer: { x: 22.3, z: 3.7, face: 1 },
  marketing: { x: 2.3, z: 13.0, face: 1 },
  drafter: { x: 4.3, z: 13.0, face: 1 },
  strategy: { x: 7.4, z: 13.0, face: 1 },
  'commit-scribe': { x: 20.8, z: 13.0, face: 1 },
  interpreter: { x: 18.8, z: 15.55, face: -1 },
};

/** 회의실 A 의자 (회의 중인 직원이 차례로 앉는다) */
export const MEETING_SEATS: readonly Seat[] = [
  { x: 12.9, z: 14.4, face: 1 },
  { x: 14.7, z: 14.4, face: 1 },
  { x: 13.8, z: 16.85, face: -1 },
  { x: 12.3, z: 16.85, face: -1 },
  { x: 15.3, z: 16.85, face: -1 },
  { x: 16.0, z: 14.4, face: 1 },
  { x: 11.6, z: 14.4, face: 1 },
];

/** 파견 라운지 자리 (빌려 온 친구 계정, 8장) */
export const GUEST_SEATS: readonly Seat[] = [
  { x: 24.95, z: 13.3, face: 1 },
  { x: 24.95, z: 15.55, face: -1 },
];

/** 임시 직원(방문)과 자리가 정해지지 않은 직원: 커피 바 스툴 */
export const VISITOR_SEATS: readonly Seat[] = [
  { x: 12.0, z: 9.35, face: -1, seatY: 0.62 },
  { x: 13.2, z: 9.35, face: -1, seatY: 0.62 },
  { x: 14.4, z: 9.35, face: -1, seatY: 0.62 },
  { x: 12.0, z: 10.9, face: -1, seatY: 0.45 },
];

export const GUEST_DEPARTMENT = '파견 라운지';
export const CAT_ID = 'git-cat';

export type Act = 'type' | 'talk' | 'idle';

export interface Placed {
  id: string;
  name: string;
  status: DerivedStatus;
  seat: Seat;
  act: Act;
  helper: boolean;
}

const ACT: Record<DerivedStatus, Act> = { working: 'type', reviewing: 'type', meeting: 'talk', blocked: 'idle', paused: 'idle', idle: 'idle', away: 'idle' };

/**
 * 직원마다 앉을 자리와 몸짓을 정한다. 나간 직원(leftAt)은 없다. Git 고양이는 따로 돌아다니므로 빠진다.
 * 회의 중이면 회의실, 파견 직원은 파견 라운지, 임시 직원은 커피 바. 자리가 모자라면 그 직원은 그리지 않는다.
 */
export function place3d(employees: readonly ScreenEmployee[], tickets: readonly ScreenTicket[]): Placed[] {
  const out: Placed[] = [];
  const pools = { meeting: [...MEETING_SEATS], guest: [...GUEST_SEATS], visitor: [...VISITOR_SEATS] };
  const sorted = [...employees].filter((e) => !e.leftAt && e.id !== CAT_ID).sort((a, b) => a.id.localeCompare(b.id));
  for (const e of sorted) {
    const status = deriveEmployeeStatus(e.id, [...tickets], e.leftAt);
    const guest = e.department === GUEST_DEPARTMENT;
    const seat =
      status === 'meeting'
        ? (pools.meeting.shift() ?? DESK_SEATS[e.id])
        : guest
          ? pools.guest.shift()
          : e.isTemporary
            ? pools.visitor.shift()
            : (DESK_SEATS[e.id] ?? pools.visitor.shift());
    if (!seat) continue;
    out.push({ id: e.id, name: e.personalName ?? e.displayName, status, seat, act: ACT[status], helper: e.rank === 'assistant' || e.isTemporary });
  }
  return out;
}

/** WebGL을 쓸 수 있는가 (없으면 2D 지도) */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}
