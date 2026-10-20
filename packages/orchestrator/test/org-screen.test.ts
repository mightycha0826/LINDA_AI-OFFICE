// 화면을 개편 조직도(2-0)에 맞춤 (2026-10-20, 주인 부재 중 76): 부서·직급·하는 일, 부서별 방, 이름표가 겹치지 않는 자리
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '@ai-office/shared';
import { messageSummary } from '../src/core/guards.ts';
import { employees } from '../src/db/schema.ts';
import { buildSnapshot, brainLabel } from '../src/screen/snapshot.ts';
import { seedStaff, STANDING_STAFF } from '../src/seed.ts';
import { ASSISTANTS } from '../src/staff/assistants.ts';
import { jobOf, rankOf, TEAM_LEADS } from '../src/staff/org.ts';
import { DESKS, GRID, MEETING_CHAIRS, ROOMS, TEMP_SLOTS, roomAt, roomOfDepartment, type Point } from '../../office-ui/src/map.ts';
import { setup } from './helpers.ts';

const snap = (s: ReturnType<typeof setup>): Snapshot => buildSnapshot(s.ctx, { startedAt: new Date().toISOString(), gpu: null });

describe('조직도(2-0)와 직원 데이터', () => {
  it('부서는 2-0 표를 따른다: 리뷰어는 품질보증팀, Git 고양이는 운영지원', () => {
    const dept = (id: string) => STANDING_STAFF.find((x) => x.id === id)!.department;
    expect(dept('reviewer')).toBe('품질보증팀');
    expect(dept('qa-local')).toBe('품질보증팀');
    expect(dept('git-cat')).toBe('운영지원');
    expect(dept('commit-scribe')).toBe('운영지원');
    expect(dept('dev-a')).toBe('개발팀');
  });

  it('이미 만든 DB도 부서와 그림을 고친다 (빌린 그림 → 자기 그림)', () => {
    const s = setup();
    s.db.update(employees).set({ department: '개발팀', spriteSet: 'developer' }).where(eq(employees.id, 'reviewer')).run();
    s.db.update(employees).set({ spriteSet: 'chief-of-staff' }).where(eq(employees.id, 'explainer')).run();
    seedStaff(s.ctx);
    const row = (id: string) => s.db.select().from(employees).where(eq(employees.id, id)).get()!;
    expect(row('reviewer').department).toBe('품질보증팀');
    expect(row('reviewer').spriteSet).toBe('reviewer');
    expect(row('explainer').spriteSet).toBe('explainer');
    expect(row('dev-a').spriteSet).toBe('dev-a');
  });

  it('팀장은 2-0에서 굵게 쓴 6명, 보조 직원은 7명, 나머지는 팀원', () => {
    expect([...TEAM_LEADS].sort()).toEqual(['chief-of-staff', 'developer', 'marketing', 'pm', 'reviewer', 'strategy']);
    for (const a of ASSISTANTS) expect(rankOf(a.id, false)).toBe('assistant');
    expect(rankOf('dev-a', false)).toBe('member');
    expect(rankOf('git-cat', false)).toBe('member');
    expect(rankOf('temp-x', true)).toBe('temp');
  });

  it('상시 직원 모두에게 한 줄 "하는 일"이 있다', () => {
    for (const s of STANDING_STAFF) expect(jobOf(s.id), s.id).not.toBe('');
  });

  it('스냅샷에 직급·하는 일·짧은 두뇌 이름이 실린다', () => {
    const s = setup();
    const e = (id: string) => snap(s).employees.find((x) => x.id === id)!;
    expect(e('reviewer')).toMatchObject({ department: '품질보증팀', rank: 'lead', brainLabel: 'GPT' });
    expect(e('dev-a')).toMatchObject({ rank: 'member', brainLabel: 'GPT', spriteSet: 'dev-a' });
    expect(e('explainer')).toMatchObject({ rank: 'assistant', brainLabel: 'Gemma', job: '#막힘 알림을 2~3줄로 풀어 설명' });
    expect(e('pm').brainLabel).toBe('Claude');
    expect(brainLabel('developer', { provider: 'claude-code', budget: 'dev' })).toBe('Claude');
  });
});

describe('사무실 지도: 부서별 방과 자리', () => {
  const inGrid = (p: Point) => p.x > 0 && p.x < GRID.w && p.y > 0 && p.y < GRID.h;

  it('상시 직원마다 자기 부서 방 안에 자리가 있다', () => {
    for (const s of STANDING_STAFF) {
      const desk = DESKS[s.id];
      expect(desk, `${s.id} 자리`).toBeDefined();
      expect(roomAt(desk!)?.id, `${s.id}(${s.department})`).toBe(roomOfDepartment(s.department)?.id);
    }
    expect(Object.keys(DESKS).sort()).toEqual(STANDING_STAFF.map((s) => s.id).sort());
  });

  it('방은 격자 안에 있고 서로 겹치지 않으며, 부서는 한 방에만 속한다', () => {
    for (const r of ROOMS) expect(inGrid({ x: r.x, y: r.y }) && r.x + r.w <= GRID.w && r.y + r.h <= GRID.h, r.id).toBe(true);
    for (const a of ROOMS)
      for (const b of ROOMS) {
        if (a === b) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${a.id}·${b.id}`).toBe(true);
      }
    const depts = ROOMS.flatMap((r) => r.departments);
    expect(new Set(depts).size).toBe(depts.length);
  });

  it('이름표가 겹치지 않게: 높이가 비슷한(1.5칸 안) 자리끼리는 3.5칸 넘게 떨어진다', () => {
    const seats = [...Object.entries(DESKS), ...TEMP_SLOTS.map((p, i) => [`temp-${i + 1}`, p] as const), ...MEETING_CHAIRS.map((p, i) => [`chair-${i}`, p] as const)];
    for (const [a, p] of seats)
      for (const [b, q] of seats) {
        if (a >= b) continue;
        if (Math.abs(p.y - q.y) < 1.5) expect(Math.abs(p.x - q.x), `${a}·${b}`).toBeGreaterThanOrEqual(3.5);
      }
    for (const [id, p] of seats) expect(roomAt(p), id).not.toBeNull();
  });
});

describe('말풍선 요약', () => {
  it('교정 1차 점검처럼 지적 목록만 있는 출력은 건수로 보인다', () => {
    expect(messageSummary('교정 1차 점검: {"issues":[{"kind":"tone","where":"1번","note":"x"}],"missingCriteria":[]}')).toBe('교정 1차 점검: 지적 1건');
    expect(messageSummary('교정 1차 점검: {"issues":[],"missingCriteria":[]}')).toBe('교정 1차 점검: 지적 없음');
  });
});
