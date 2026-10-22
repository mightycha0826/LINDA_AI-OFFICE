// 12장 애니메이션 규칙: 30초보다 오래된 이벤트는 재생하지 않는다, 복도 경유 지점으로 걷는다
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '@ai-office/shared';
import { Director, poseFor, walkFacing } from './director.ts';
import { ManifestSchema, poseSheet } from './sprites.ts';
import { DESKS, GRID, MEETING_CHAIRS, pathBetween, roomAt } from './map.ts';

const emp = (id: string, spriteSet = id) => ({ id, displayName: id, role: 'developer', department: '개발팀', brainLabel: 'x', spriteSet, isTemporary: false, tempKind: null, leftAt: null }) as Snapshot['employees'][number];

function snap(): Snapshot {
  return {
    companyName: 't', combo: 1, timezone: 'Asia/Seoul', checkTimes: [], nextReport: '18:00', now: new Date().toISOString(), lastSeq: 0,
    employees: [emp('developer'), emp('reviewer')], tickets: [], approvals: [], usage: [], estimated: true, log: [], pushing: [], projects: [], orders: [],
    system: { startedAt: '', stopped: false, online: true, ceoPresent: false, loadedModel: null, lastModelSwitchAt: null, gpu: null, lastError: null, account: { claude: null }, personalReserve: { claudeFiveHour: 0, claudeWeekly: 0, gptFiveHour: 0, gptWeekly: 0 } },
  };
}

const msg = (agoMs: number) => ({ seq: 1, type: 'message.sent', payload: { from: 'developer', to: 'reviewer', summary: '로그인 구현', ticketId: 'T-1' }, createdAt: new Date(Date.now() - agoMs).toISOString() });

describe('Director', () => {
  it('30초보다 오래된 이벤트는 말풍선을 띄우지 않는다', () => {
    const d = new Director(true);
    d.sync(snap());
    d.handle(msg(60_000));
    expect(d.list().find((c) => c.id === 'developer')!.bubble).toBeNull();
    d.handle(msg(1_000));
    expect(d.list().find((c) => c.id === 'developer')!.bubble?.text).toBe('로그인 구현');
  });

  it('상태별 동작', () => {
    expect(poseFor('working')).toBe('typing');
    expect(poseFor('reviewing')).toBe('typing');
    expect(poseFor('blocked')).toBe('blocked');
    expect(poseFor('away')).toBe('idle');
  });
});

describe('지도 경로', () => {
  it('방 사이는 문과 복도를 거쳐 걷고, 지도 밖으로 나가지 않는다', () => {
    const path = pathBetween(DESKS.developer!, MEETING_CHAIRS[0]!);
    expect(path.at(-1)).toEqual(MEETING_CHAIRS[0]);
    for (const p of path) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(GRID.w);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(GRID.h);
    }
    // 개발팀에서 회의실로 가려면 복도(어느 방에도 속하지 않는 점)를 지난다
    expect(path.some((p) => roomAt(p) === null)).toBe(true);
  });
});

describe('캐릭터 방향 (정면 그림)', () => {
  const spec = (file: string) => ({ file, frames: 2, fps: 2, loop: true });
  const m = ManifestSchema.parse({
    id: 'x', frame: { width: 128, height: 128 }, anchor: { x: 64, y: 120 },
    poses: { idle: spec('idle.png'), 'idle-front': spec('idle-front.png'), walking: spec('walking.png'), 'walking-front': spec('walking-front.png'), typing: spec('typing.png') },
  });

  it('옆으로 가면 왼쪽/오른쪽, 아래로 가면 정면, 위로 가면 옆 방향 유지', () => {
    expect(walkFacing({ x: 5, y: 5 }, { x: 2, y: 5 }, 'front')).toBe('left');
    expect(walkFacing({ x: 5, y: 5 }, { x: 8, y: 6 }, 'left')).toBe('right');
    expect(walkFacing({ x: 5, y: 5 }, { x: 5, y: 9 }, 'left')).toBe('front');
    expect(walkFacing({ x: 5, y: 9 }, { x: 5, y: 5 }, 'left')).toBe('left');
    expect(walkFacing({ x: 5, y: 9 }, { x: 5, y: 5 }, 'front')).toBe('right');
  });

  it('정면 시트가 있으면 쓰고, 없으면 오른쪽 그림(반전 없음)으로 대신한다', () => {
    expect(poseSheet(m, 'idle', 'front')).toEqual({ sheet: m.poses['idle-front'], flip: false });
    expect(poseSheet(m, 'typing', 'front')).toEqual({ sheet: m.poses.typing, flip: false });
    expect(poseSheet(m, 'meeting', 'front')).toEqual({ sheet: m.poses['idle-front'], flip: false });
    expect(poseSheet(m, 'walking', 'left')).toEqual({ sheet: m.poses.walking, flip: true });
    expect(poseSheet(m, 'paused', 'right')).toEqual({ sheet: m.poses.idle, flip: false });
  });
});
