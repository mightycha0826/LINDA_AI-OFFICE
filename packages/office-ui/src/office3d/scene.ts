// 3D 사무실 그림 (12장, 2026-10-21 CEO 결정). 건물·가구는 floor.ts가 한 번 짓고,
// 여기서는 직원·고양이·파견 도킹 표시등·회의실 표지·결재 서류를 화면 데이터(update)로 바꾸고 카메라와 이름표를 돌린다.
// 나눈 곳 (2026-10-22 리팩터링): builder.ts 도형·재질, furniture.ts 가구, floor.ts 층 배치, util.ts 공용 도우미
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { DerivedStatus } from '@ai-office/shared';
import { hash, lookOf } from './characters.ts';
import { buildFigure, disposeFigure, FigureKit } from './figure.ts';
import { buildFloor, CX, CZ, type FloorParts } from './floor.ts';
import { Furniture } from './furniture.ts';
import { GUEST_SEATS, MEETING_SEATS, type Act, type Placed, type Seat } from './layout.ts';
import type { Avatar } from './vrm.ts';
import { animateHand, gripHand, type Hand } from './hands.ts';
import { REST_LABEL, restMotion, type RestProfile } from './rest.ts';
import { buildRestProps, disposeRestProps, updateRestProps, type RestProps } from './rest-props.ts';
import { rnd } from './util.ts';

export const STATUS_COLOR: Record<DerivedStatus, number> = { working: 0x17845a, reviewing: 0x2d64c8, meeting: 0x2d64c8, blocked: 0xc77700, paused: 0xb9b3a7, idle: 0xb9b3a7, away: 0xb9b3a7 };

interface Rig {
  id: string;
  group: THREE.Group;
  /** 보조 직원은 0.9배 */
  body: THREE.Group;
  /** 코드 인형 (VRM을 쓰면 감춘다) */
  figure: THREE.Group;
  head: THREE.Group;
  forearms: THREE.Group[];
  hands: Hand[];
  torso: THREE.Object3D;
  ring: THREE.Mesh;
  target: THREE.Vector3;
  face: 1 | -1;
  act: Act;
  rest: RestProfile | undefined;
  props: RestProps;
  phase: number;
  label: HTMLButtonElement;
  anchorY: number;
  figureTop: number;
  /** VRM 주소 (13장 3D 캐릭터). 불러오면 avatar */
  model: string | null;
  avatar: Avatar | null;
}

export interface Office3DState {
  placed: Placed[];
  night: boolean;
  background: string;
  approvals: number;
  cat: { name: string; status: DerivedStatus } | null;
}

export class Office3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  private readonly controls: OrbitControls;
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0xd9cdb8, 0.72);
  private readonly sun = new THREE.DirectionalLight(0xfff4e2, 0.85);
  private readonly f: Furniture;
  private readonly parts: FloorParts;
  private readonly catLabel: HTMLButtonElement;
  private readonly rigs = new Map<string, Rig>();
  private readonly kit = new FigureKit();
  private disposed = false;
  private fly: { t: number; fromP: THREE.Vector3; fromT: THREE.Vector3; toP: THREE.Vector3; toT: THREE.Vector3 } | null = null;
  private raf = 0;
  private readonly clock = new THREE.Clock();
  private readonly resize: ResizeObserver;
  private readonly reduce: boolean;
  private readonly tmp = new THREE.Vector3();
  private night = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly labels: HTMLElement;
  private readonly onSelect: (id: string) => void;

  constructor(canvas: HTMLCanvasElement, labels: HTMLElement, onSelect: (id: string) => void, names: Readonly<Record<string, string>>) {
    this.canvas = canvas;
    this.labels = labels;
    this.onSelect = onSelect;
    this.reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 1.4;
    this.controls.maxDistance = 48;
    this.controls.screenSpacePanning = false;
    this.goHome(true);
    this.scene.add(this.hemi);
    this.sun.position.set(CX + 10, 24, CZ - 14);
    this.sun.target.position.set(CX, 0, CZ);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -20, right: 20, top: 16, bottom: -16, near: 1, far: 70 });
    this.sun.shadow.bias = -0.0006;
    this.scene.add(this.sun, this.sun.target);
    this.f = new Furniture(this.scene, getComputedStyle(document.body).fontFamily);
    this.parts = buildFloor(this.f, names);
    this.catLabel = this.label('git-cat');
    this.catLabel.hidden = true;
    document.fonts?.ready.then(() => this.f.redrawText()).catch(() => {});
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(canvas.parentElement ?? canvas);
    this.fit();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ---------- 바깥에서 부르는 것 ----------

  update(s: Office3DState): void {
    this.scene.background = new THREE.Color(s.night ? 0x0e1418 : s.background);
    this.night = s.night;
    this.hemi.intensity = s.night ? 0.18 : 0.72;
    this.sun.intensity = s.night ? 0.06 : 0.85;
    this.f.setNight(s.night);
    this.kit.setNight(s.night);
    const seen = new Set<string>();
    for (const p of s.placed) {
      seen.add(p.id);
      const rig = this.rigs.get(p.id) ?? this.makeRig(p);
      rig.target.set(p.seat.x, p.seat.seatY != null ? p.seat.seatY - 0.46 : 0, p.seat.z);
      rig.face = p.seat.face;
      rig.act = p.act;
      rig.rest = p.rest;
      if (p.rest) rig.props.tint(p.rest.color);
      (rig.ring.material as THREE.MeshBasicMaterial).color.setHex(STATUS_COLOR[p.status]);
      rig.label.querySelector('.ao3-dot')!.setAttribute('data-status', p.status);
      rig.label.querySelector('.ao3-tag__name')!.textContent = p.rest ? `${p.name} · ${REST_LABEL[p.rest.kind]}` : p.name;
      const proj = rig.label.querySelector<HTMLElement>('.ao3-tag__proj')!;
      proj.textContent = p.project ?? '';
      proj.hidden = !p.project;
      rig.label.setAttribute('aria-label', [p.name,p.rest ? REST_LABEL[p.rest.kind] : null,p.project ? `프로젝트 ${p.project}` : null].filter(Boolean).join(', '));
      rig.label.classList.toggle('ao3-tag--small', p.helper);
      this.setModel(rig, p.model);
    }
    for (const [id, rig] of this.rigs) {
      if (seen.has(id)) continue;
      this.scene.remove(rig.group, rig.ring);
      rig.label.remove();
      rig.avatar?.dispose();
      disposeFigure(rig.figure);
      disposeRestProps(rig.props);
      this.rigs.delete(id);
    }
    // 파견 라운지 도킹 표시등: 앉은 자리는 초록
    GUEST_SEATS.forEach((g, i) => {
      const on = s.placed.some((p) => p.seat === g);
      const m = this.parts.docks[i];
      if (m) {
        m.color.setHex(on ? 0x5bd08d : 0x8e9496);
        m.emissive.setHex(on ? 0x3ccb78 : 0x000000);
      }
    });
    const meeting = s.placed.some((p) => MEETING_SEATS.includes(p.seat));
    this.parts.meetingSign.busy.visible = meeting;
    this.parts.meetingSign.free.visible = !meeting;
    this.parts.papers.forEach((m, i) => (m.visible = i < s.approvals));
    this.catLabel.hidden = !s.cat;
    if (s.cat) {
      this.catLabel.querySelector('.ao3-tag__name')!.textContent = s.cat.name;
      this.catLabel.querySelector('.ao3-dot')!.setAttribute('data-status', s.cat.status);
    }
    this.parts.cat.visible = !!s.cat;
  }

  /**
   * 그 직원에게 카메라가 다가간다. near(캐릭터 목록, 2026-10-22)면 더 가까이, 그 캐릭터 앞쪽 위에서 얼굴이 보이게.
   * 이름표를 누를 때는 지금 보는 방향을 그대로 두고 다가간다. inset: 왼쪽을 가린 목록 너비(px), 그만큼 비켜 보인다.
   */
  focus(id: string, near = false, inset = 0): void {
    const rig = this.rigs.get(id);
    const at = rig ? rig.group.position.clone() : id === 'git-cat' ? this.parts.cat.position.clone() : null;
    if (!at) return;
    const toT = at.setY(near ? (rig ? 1.1 : 0.4) : 0.8);
    // 앞쪽 위: 캐릭터가 보는 쪽(face)으로 비스듬히, 맞은편 모니터 너머로·천장 조명(2.6m) 높이쯤. OrbitControls 최소 거리(3.5)보다 조금 멀리
    const dist = near ? 3.6 : 6.5;
    // 돌아다니는 Git 고양이는 벽에 가리지 않게 위에서 내려다본다
    const nearDir = rig
      ? rig.rest?.kind === 'coffee' ? new THREE.Vector3(0.86,0.5,0.1*rig.face) : new THREE.Vector3(0.25,0.42,0.87*rig.face)
      : new THREE.Vector3(0.3,0.9,0.35);
    const dir = near ? nearDir.normalize() : this.camera.position.clone().sub(this.controls.target).normalize();
    const toP = toT.clone().add(dir.clone().multiplyScalar(dist));
    if (!near && toP.y < 2.6) toP.y = 2.6;
    const w = this.canvas.clientWidth;
    if (inset > 0 && w > 0) {
      // 화면 가운데가 목록 오른쪽 빈자리 가운데로 오게 카메라와 시선을 같이 옆으로 민다
      const viewW = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect;
      const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
      const shift = side.multiplyScalar(((inset / 2) / w) * viewW);
      toT.add(shift);
      toP.add(shift);
    }
    this.fly = { t: this.reduce ? 1 : 0, fromP: this.camera.position.clone(), fromT: this.controls.target.clone(), toP, toT };
  }

  goHome(now = false): void {
    const toP = new THREE.Vector3(CX - 2.5, 21.5, CZ + 19.5);
    const toT = new THREE.Vector3(CX, 0, CZ + 0.8);
    if (now) {
      this.camera.position.copy(toP);
      this.controls.target.copy(toT);
      return;
    }
    this.fly = { t: this.reduce ? 1 : 0, fromP: this.camera.position.clone(), fromT: this.controls.target.clone(), toP, toT };
  }

  setAutoRotate(on: boolean): void {
    this.controls.autoRotate = on;
    this.controls.autoRotateSpeed = 0.6;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.controls.dispose();
    for (const r of this.rigs.values()) {
      r.avatar?.dispose();
      disposeFigure(r.figure);
      disposeRestProps(r.props);
    }
    this.kit.dispose();
    this.f.dispose();
    this.renderer.dispose();
    this.labels.replaceChildren();
  }

  // ---------- 돌리기 ----------

  private fit(): void {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // 화면이 좁아져도 층 양 끝이 잘리지 않게 가로 시야를 지킨다 (넓은 화면 기준 세로 38°)
    const half = Math.tan(THREE.MathUtils.degToRad(19)) * Math.max(1, 2.0 / this.camera.aspect);
    this.camera.fov = Math.min(70, THREE.MathUtils.radToDeg(2 * Math.atan(half)));
    this.camera.updateProjectionMatrix();
  }

  private readonly frame = (): void => {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    const m = this.reduce ? 0 : 1;
    for (const r of this.rigs.values()) {
      // 자리가 바뀌면 미끄러지듯 옮겨 간다
      r.group.position.lerp(r.target, this.reduce ? 1 : Math.min(1, dt * 2.5));
      r.group.rotation.y = r.face > 0 ? 0 : Math.PI;
      r.ring.position.set(r.group.position.x, r.target.y + 0.49, r.group.position.z);
      if (r.avatar) {
        r.avatar.animate(r.act, t, r.phase, m, dt, r.rest);
      } else if (r.act === 'rest' && r.rest) {
        const pose = restMotion(r.rest,t,r.phase,m);
        r.forearms.forEach((arm,i) => { arm.rotation.x = pose.arms[i]!; });
        r.hands.forEach((hand,i) => {
          hand.root.rotation.z = pose.wrists[i]!;
          animateHand(hand,'idle',t,r.phase,m);
          gripHand(hand,r.rest!.kind === 'coffee' && i === r.rest!.side ? 0.85 : r.rest!.kind === 'read' ? 0.25 : 0);
        });
        r.head.rotation.set(pose.headX,pose.headY,0);
        r.torso.rotation.y = pose.torso;
      } else if (r.act === 'type') {
        r.forearms.forEach((f, i) => (f.rotation.x = Math.sin(t * 7 + r.phase + i * 1.7) * 0.012 * m));
        r.head.rotation.set(0.06, Math.sin(t * 0.35 + r.phase) * 0.12 * m, 0);
        r.torso.rotation.y = 0;
      } else if (r.act === 'talk') {
        r.forearms[0]!.rotation.x = 0;
        r.forearms[1]!.rotation.x = (-0.5 + Math.sin(t * 2.2 + r.phase) * 0.35) * m;
        r.head.rotation.set(0, Math.sin(t * 0.8 + r.phase) * 0.4 * m, 0);
        r.torso.rotation.y = 0;
      } else {
        r.forearms.forEach((f) => (f.rotation.x = 0));
        r.head.rotation.set(0, Math.sin(t * 0.25 + r.phase) * 0.5 * m, 0);
        r.torso.rotation.y = Math.sin(t * 0.25 + r.phase) * 0.06 * m;
      }
      if (!r.avatar && r.act !== 'rest') r.hands.forEach((hand, i) => { hand.root.rotation.z = 0; animateHand(hand, r.act, t, r.phase + i * 2.3, m); });
      const pose = r.rest ? restMotion(r.rest,t,r.phase,m) : null;
      updateRestProps(r.props,r.body,r.avatar?.hands ?? r.hands.map(h => h.root),r.rest,r.group.position.distanceToSquared(r.target)<0.16,pose?.sip ?? 0,t*m);
    }
    const { cat, robot } = this.parts;
    const cp = along([[18.0, 16.1], [22.1, 16.1], [22.1, 12.0], [17.2, 12.0]], 0.55 * m, t);
    cat.position.set(cp.x, 0, cp.z);
    cat.rotation.y = cp.dir - Math.PI / 2;
    const rp = along([[23.3, 12.2], [28.9, 12.2], [28.9, 11.2], [23.3, 11.2]], 0.8 * m, t);
    robot.position.set(rp.x, 0, rp.z);
    robot.rotation.y = rp.dir;
    this.f.blink(t, m);
    if (this.fly) {
      this.fly.t = Math.min(1, this.fly.t + dt / 1.1);
      const k = this.fly.t;
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.camera.position.lerpVectors(this.fly.fromP, this.fly.toP, e);
      this.controls.target.lerpVectors(this.fly.fromT, this.fly.toT, e);
      if (this.fly.t >= 1) this.fly = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
    this.raf = requestAnimationFrame(this.frame);
  };

  private placeLabels(): void {
    const w = this.labels.clientWidth;
    const h = this.labels.clientHeight;
    // 멀리서 볼 때는 보조 직원 이름표를 감춘다 (겹치지 않게). 다가가면 다시 보인다
    this.labels.classList.toggle('ao3__labels--far', this.camera.position.distanceTo(this.controls.target) > 20);
    const put = (el: HTMLElement, x: number, y: number, z: number) => {
      this.tmp.set(x, y, z).project(this.camera);
      const v = this.tmp;
      const off = v.z > 1 || v.x < -1.15 || v.x > 1.15 || v.y < -1.15 || v.y > 1.15;
      el.style.visibility = off ? 'hidden' : 'visible';
      if (!off) el.style.transform = `translate(${(((v.x + 1) / 2) * w).toFixed(1)}px,${(((1 - v.y) / 2) * h).toFixed(1)}px) translate(-50%,-100%)`;
    };
    for (const r of this.rigs.values()) put(r.label, r.group.position.x, r.target.y + r.anchorY, r.group.position.z);
    if (!this.catLabel.hidden) put(this.catLabel, this.parts.cat.position.x, 0.85, this.parts.cat.position.z);
  }

  // ---------- 사람 ----------

  private label(id: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ao3-tag';
    const dot = document.createElement('i');
    dot.className = 'ao3-dot';
    const name = document.createElement('span');
    name.className = 'ao3-tag__name';
    // 오른쪽 프로젝트 칩 (2026-10-22 CEO 요청: 지금 맡은 프로젝트). 없으면 숨긴다
    const proj = document.createElement('span');
    proj.className = 'ao3-tag__proj';
    proj.hidden = true;
    b.append(dot, name, proj);
    b.addEventListener('click', () => {
      this.focus(id);
      this.onSelect(id);
    });
    this.labels.append(b);
    return b;
  }

  /** 직원 인형: 외모 표(characters.ts)대로 만든 코드 인형. VRM이 있으면 나중에 바꿔 끼운다 (13장 3D 캐릭터) */
  private makeRig(p: Placed): Rig {
    const fig = buildFigure(lookOf(p.id), this.kit);
    const g = new THREE.Group();
    const body = new THREE.Group();
    body.scale.setScalar(p.helper ? 0.9 : 1);
    // Resize around the seated pelvis, keeping small assistants above the cushion.
    body.position.y = 0.5 * (1 - body.scale.y);
    const wristLift = (1 / body.scale.y - 1) * (0.89 - 0.5);
    fig.forearms.forEach(arm => arm.position.y += wristLift);
    body.add(fig.root);
    const props = buildRestProps((color) => this.f.mat(color));
    body.add(props.root);
    g.add(body);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 40), new THREE.MeshBasicMaterial({ color: STATUS_COLOR[p.status], transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    this.scene.add(g, ring);
    const seat = p.seat;
    g.position.set(seat.x, seat.seatY != null ? seat.seatY - 0.46 : 0, seat.z);
    const rig: Rig = {
      id: p.id,
      group: g,
      body,
      figure: fig.root,
      head: fig.head,
      forearms: fig.forearms,
      hands: fig.hands,
      torso: fig.torso,
      ring,
      target: g.position.clone(),
      face: seat.face,
      act: p.act,
      rest: p.rest,
      props,
      phase: rnd(hash(p.id)) * 6.28,
      label: this.label(p.id),
      anchorY: body.position.y + (fig.top + 0.08) * body.scale.y,
      figureTop: fig.top,
      model: null,
      avatar: null,
    };
    this.rigs.set(p.id, rig);
    return rig;
  }

  /** VRM 주소가 바뀌면 불러와 코드 인형과 바꾼다. 못 읽으면 코드 인형 그대로 */
  private setModel(rig: Rig, url: string | null): void {
    if (rig.model === url) return;
    rig.model = url;
    if (rig.avatar) {
      rig.body.remove(rig.avatar.root);
      rig.avatar.dispose();
      rig.avatar = null;
      rig.figure.visible = true;
      rig.anchorY = rig.body.position.y + (rig.figureTop + 0.08) * rig.body.scale.y;
    }
    if (!url) return;
    import('./vrm.ts')
      .then((m) => m.loadAvatar(url, rig.body.scale.y))
      .then((av) => {
        if (this.disposed || this.rigs.get(rig.id) !== rig || rig.model !== url) return av.dispose();
        rig.body.add(av.root);
        rig.figure.visible = false;
        rig.avatar = av;
        rig.anchorY = rig.body.position.y + (av.top + 0.08) * rig.body.scale.y;
      })
      .catch((err: unknown) => console.warn(`3D 모델을 읽지 못해 코드 인형으로 그려요: ${url}`, err));
  }
}

function along(path: readonly (readonly [number, number])[], speed: number, t: number): { x: number; z: number; dir: number } {
  const segs = path.map((a, i) => {
    const b = path[(i + 1) % path.length]!;
    return { a, b, l: Math.hypot(b[0] - a[0], b[1] - a[1]) };
  });
  const total = segs.reduce((s, x) => s + x.l, 0);
  let d = (t * speed) % total;
  for (const s of segs) {
    if (d <= s.l) {
      const k = s.l ? d / s.l : 0;
      return { x: s.a[0] + (s.b[0] - s.a[0]) * k, z: s.a[1] + (s.b[1] - s.a[1]) * k, dir: Math.atan2(s.b[0] - s.a[0], s.b[1] - s.a[1]) };
    }
    d -= s.l;
  }
  const last = segs[segs.length - 1]!;
  return { x: last.b[0], z: last.b[1], dir: 0 };
}

export type { Seat };
