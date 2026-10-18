// 애니메이션 지휘 (12장 애니메이션 규칙).
// - 위치 이동(이 파일)과 제자리 동작(캐릭터 그림)을 나눈다. 캐릭터는 pose, facing, spriteSet만 받는다.
// - 캐릭터마다 대기열이 있어 동작이 겹치지 않고 순서대로 재생된다.
// - 30초보다 오래된 이벤트는 재생하지 않고 결과 상태로 바로 넘어간다.
// - prefers-reduced-motion이면 걷지 않고 제자리로 바로 옮긴다.
import { currentTicketOf, deriveEmployeeStatus, type DerivedStatus, type Snapshot } from '@ai-office/shared';
import type { LiveEvent } from './data.ts';
import { CEO_DESK, ENTRANCE, MAILBOX, MEETING_CHAIRS, deskOf, distance, pathBetween, type Point } from './map.ts';

export type Pose = 'idle' | 'typing' | 'walking' | 'carrying' | 'meeting' | 'blocked' | 'paused';
/** front: 정면(멈춰 있을 때, 아래로 걸을 때). 정면 그림이 없는 세트는 오른쪽 그림으로 대신한다 */
export type Facing = 'left' | 'right' | 'front';

export interface CharacterState {
  id: string;
  pos: Point;
  /** 이번 걸음에 걸리는 시간 (초). 0이면 바로 */
  moveSec: number;
  pose: Pose;
  facing: Facing;
  visible: boolean;
  carrying: string | null;
  bubble: { text: string; ticketId: string | null; until: number } | null;
  status: DerivedStatus;
  busy: boolean;
}

export interface Props {
  mailbox: 'idle' | 'ok' | 'fail';
  rackBlinkUntil: number;
}

type Step = () => Promise<void>;

const SPEED = 3.2; // 칸/초
const STALE_MS = 30_000;
const BUBBLE_MS = 4_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 걷는 방향: 옆으로 가면 왼쪽/오른쪽, 아래로(화면 쪽으로) 가면 정면, 위로 가면 하던 옆 방향 */
export function walkFacing(from: Point, to: Point, prev: Facing): Facing {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) > 0.01) return dx < 0 ? 'left' : 'right';
  if (dy > 0.01) return 'front';
  return prev === 'front' ? 'right' : prev;
}

export function poseFor(status: DerivedStatus): Pose {
  switch (status) {
    case 'working':
    case 'reviewing':
      return 'typing';
    case 'meeting':
      return 'meeting';
    case 'blocked':
      return 'blocked';
    case 'paused':
      return 'paused';
    default:
      return 'idle';
  }
}

export class Director {
  private chars = new Map<string, CharacterState>();
  private queues = new Map<string, Step[]>();
  private running = new Set<string>();
  private listeners = new Set<() => void>();
  private snap: Snapshot | null = null;
  private lastCommit = new Map<string, string>();
  props: Props = { mailbox: 'idle', rackBlinkUntil: 0 };
  private version = 0;
  reducedMotion: boolean;

  constructor(reducedMotion: boolean) {
    this.reducedMotion = reducedMotion;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = () => this.version;

  list(): CharacterState[] {
    return [...this.chars.values()];
  }

  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  private patch(id: string, p: Partial<CharacterState>) {
    const c = this.chars.get(id);
    if (!c) return;
    this.chars.set(id, { ...c, ...p });
    this.emit();
  }

  /** 상태가 원하는 자리: 회의 중이면 회의실 의자, 아니면 자기 자리 */
  private home(id: string): Point {
    const s = this.snap;
    const e = s?.employees.find((x) => x.id === id);
    if (!s || !e) return { x: 12, y: 8.25 };
    const meeting = s.tickets.find((t) => t.status === 'meeting' && (t.assigneeId === id || t.reviewerId === id));
    if (meeting) return MEETING_CHAIRS[meeting.assigneeId === id ? 0 : 1]!;
    return deskOf(e.id, e.spriteSet);
  }

  /** 스냅샷이 오면 바쁘지 않은 캐릭터를 결과 상태로 맞춘다 */
  sync(s: Snapshot) {
    this.snap = s;
    for (const e of s.employees) {
      const status = deriveEmployeeStatus(e.id, s.tickets, e.leftAt);
      const existing = this.chars.get(e.id);
      if (!existing) {
        this.chars.set(e.id, {
          id: e.id,
          pos: e.leftAt ? ENTRANCE : this.home(e.id),
          moveSec: 0,
          pose: poseFor(status),
          facing: 'front',
          visible: !e.leftAt,
          carrying: null,
          bubble: null,
          status,
          busy: false,
        });
        continue;
      }
      if (existing.busy || this.running.has(e.id)) {
        this.chars.set(e.id, { ...existing, status });
        continue;
      }
      const target = this.home(e.id);
      const moved = distance(existing.pos, target) > 0.05;
      if (moved && existing.visible && !e.leftAt) this.enqueue(e.id, this.walkSteps(e.id, target, poseFor(status)));
      else this.chars.set(e.id, { ...existing, status, pose: poseFor(status), visible: existing.visible && !e.leftAt, pos: moved && !existing.visible ? target : existing.pos, moveSec: 0 });
    }
    this.emit();
  }

  private enqueue(id: string, steps: Step[]) {
    const q = this.queues.get(id) ?? [];
    q.push(...steps);
    this.queues.set(id, q);
    void this.run(id);
  }

  private async run(id: string) {
    if (this.running.has(id)) return;
    this.running.add(id);
    this.patch(id, { busy: true });
    try {
      const q = this.queues.get(id)!;
      while (q.length) await q.shift()!();
    } finally {
      this.running.delete(id);
      const c = this.chars.get(id);
      if (c) this.chars.set(id, { ...c, busy: false, pose: c.carrying ? 'carrying' : poseFor(c.status) });
      this.emit();
    }
  }

  private walkSteps(id: string, to: Point, endPose: Pose | null, carrying: string | null = null): Step[] {
    return [
      async () => {
        const c = this.chars.get(id);
        if (!c) return;
        if (this.reducedMotion) {
          this.patch(id, { pos: to, moveSec: 0, carrying, facing: 'front', ...(endPose ? { pose: endPose } : {}) });
          return;
        }
        for (const pt of pathBetween(c.pos, to)) {
          const cur = this.chars.get(id)!;
          const sec = distance(cur.pos, pt) / SPEED;
          if (sec < 0.01) continue;
          this.patch(id, { pos: pt, moveSec: sec, pose: carrying ? 'carrying' : 'walking', carrying, facing: walkFacing(cur.pos, pt, cur.facing) });
          await sleep(sec * 1000);
        }
        this.patch(id, { moveSec: 0, carrying, facing: 'front', ...(endPose ? { pose: endPose } : {}) });
      },
    ];
  }

  private pauseStep(ms: number): Step {
    return () => sleep(this.reducedMotion ? 0 : ms);
  }

  private setStep(id: string, p: Partial<CharacterState>): Step {
    return async () => this.patch(id, p);
  }

  private say(id: string, text: string, ticketId: string | null) {
    const until = Date.now() + BUBBLE_MS;
    this.patch(id, { bubble: { text: text.length > 40 ? `${text.slice(0, 39)}…` : text, ticketId, until } });
    setTimeout(() => {
      const c = this.chars.get(id);
      if (c?.bubble?.until === until) this.patch(id, { bubble: null });
    }, BUBBLE_MS);
  }

  /** 이벤트 하나를 연출한다. 오래된 이벤트는 연출하지 않는다(스냅샷이 결과 상태로 맞춘다). */
  handle(e: LiveEvent) {
    const s = this.snap;
    if (!s) return;
    const live = Date.now() - new Date(e.createdAt).getTime() <= STALE_MS;
    const p = e.payload;

    if (e.type === 'model.loaded') {
      this.props = { ...this.props, rackBlinkUntil: Date.now() + 3000 };
      this.emit();
      return;
    }
    if (e.type === 'git.commit') {
      this.lastCommit.set(String(p.ticketId), String(p.subject ?? '커밋'));
      return;
    }
    if (!live) return;

    if (e.type === 'message.sent' && typeof p.from === 'string' && this.chars.has(p.from)) {
      const ticketId = typeof p.ticketId === 'string' ? p.ticketId : null;
      this.say(p.from, String(p.summary ?? ''), ticketId);
      // 인계: 담당자가 상자를 들고 검토자 자리로 갔다가 돌아온다
      if (p.kind === 'handoff' && typeof p.to === 'string' && this.chars.has(p.to)) {
        const back = this.home(p.from);
        const dest = this.chars.get(p.to)!.pos;
        this.enqueue(p.from, [...this.walkSteps(p.from, { x: dest.x - 0.9, y: dest.y }, 'idle', ticketId), this.pauseStep(600), ...this.walkSteps(p.from, back, null, null)]);
      }
      return;
    }

    if (e.type === 'employee.move' && typeof p.employeeId === 'string') {
      const id = p.employeeId;
      if (p.visitor && p.direction === 'in') {
        // 임시 직원: 방문증을 걸고 문으로 들어온다
        const c = this.chars.get(id);
        if (c) this.chars.set(id, { ...c, pos: ENTRANCE, visible: true });
        this.emit();
        this.enqueue(id, this.walkSteps(id, this.home(id), 'idle'));
      } else if (p.visitor && p.direction === 'out') {
        this.enqueue(id, [...this.walkSteps(id, ENTRANCE, 'idle'), this.setStep(id, { visible: false })]);
      } else if (p.to === 'ceo') {
        // 정기 보고: 비서실장이 서류를 들고 CEO실로 간다
        this.enqueue(id, [...this.walkSteps(id, { x: CEO_DESK.x - 1.6, y: CEO_DESK.y + 0.9 }, 'idle', '보고'), this.pauseStep(1500), ...this.walkSteps(id, this.home(id), null, null)]);
      }
      return;
    }

    if (e.type === 'git.push' && typeof p.ticketId === 'string') {
      // 11장 고양이 연출: 담당자가 상자를 들고 고양이 책상으로 → 고양이가 라벨을 붙이고(말풍선) → 우체통으로 발송
      const t = s.tickets.find((x) => x.id === p.ticketId);
      const cat = 'git-cat';
      if (!this.chars.has(cat)) return;
      const catHome = this.home(cat);
      if (t && this.chars.has(t.assigneeId)) {
        const dev = t.assigneeId;
        this.enqueue(dev, [...this.walkSteps(dev, { x: catHome.x - 1, y: catHome.y }, 'idle', t.id), this.pauseStep(800), ...this.walkSteps(dev, this.home(dev), null, null)]);
      }
      const subject = this.lastCommit.get(p.ticketId) ?? `${p.ticketId} 커밋`;
      this.enqueue(cat, [
        this.pauseStep(1200),
        async () => this.say(cat, subject, p.ticketId as string),
        this.pauseStep(1500),
        ...this.walkSteps(cat, { x: MAILBOX.x - 0.8, y: MAILBOX.y }, 'idle', p.ticketId),
        async () => {
          this.props = { ...this.props, mailbox: p.ok ? 'ok' : 'fail' };
          this.emit();
        },
        this.setStep(cat, { pose: p.ok ? 'idle' : 'blocked', carrying: p.ok ? null : (p.ticketId as string) }),
        this.pauseStep(2500),
        async () => {
          this.props = { ...this.props, mailbox: 'idle' };
          this.emit();
        },
        ...this.walkSteps(cat, catHome, null, null),
      ]);
      return;
    }

    if (e.type === 'ticket.status' && typeof p.ticketId === 'string') {
      const t = s.tickets.find((x) => x.id === p.ticketId);
      if (!t) return;
      // 회의: 담당자와 검토자가 회의실로 가서 앉는다 / 끝나면 자리로
      if (p.to === 'meeting') {
        this.enqueue(t.assigneeId, this.walkSteps(t.assigneeId, MEETING_CHAIRS[0]!, 'meeting'));
        this.enqueue(t.reviewerId, this.walkSteps(t.reviewerId, MEETING_CHAIRS[1]!, 'meeting'));
      } else if (p.from === 'meeting') {
        for (const id of [t.assigneeId, t.reviewerId]) {
          const e2 = s.employees.find((x) => x.id === id);
          if (e2) this.enqueue(id, this.walkSteps(id, deskOf(e2.id, e2.spriteSet), null));
        }
      }
    }
  }

  ticketOf(id: string) {
    return this.snap ? currentTicketOf(id, this.snap.tickets) : null;
  }
}
