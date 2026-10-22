// 3D 사무실 그림 (12장, 2026-10-21 CEO 결정). 3D 시안을 옮긴 것. 건물·가구는 한 번 만들고,
// 직원·고양이·파견 도킹 표시등·회의실 표지·결재 서류는 화면 데이터(update)로 바꾼다.
// 3D 재질(나무·식물·바닥) 색은 포인트 디자인 시스템의 예외다(17장 메모). 화면 글자·패널은 토큰을 쓴다.
// 색은 숫자(0xRRGGBB)로 적고, 캔버스에 그릴 때만 css()로 바꾼다.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { DerivedStatus } from '@ai-office/shared';
import { hash, lookOf } from './characters.ts';
import { buildFigure, disposeFigure, FigureKit } from './figure.ts';
import { DESK_SEATS, GUEST_SEATS, MEETING_SEATS, type Act, type Placed, type Seat } from './layout.ts';
import type { Avatar } from './vrm.ts';

const css = (n: number) => '#' + n.toString(16).padStart(6, '0');
const W = 30;
const D = 19.5;
const CX = 15;
const CZ = 9.75;

export const STATUS_COLOR: Record<DerivedStatus, number> = { working: 0x17845a, reviewing: 0x2d64c8, meeting: 0x2d64c8, blocked: 0xc77700, paused: 0xb9b3a7, idle: 0xb9b3a7, away: 0xb9b3a7 };

function rnd(seed: number): number {
  const s = Math.sin(seed * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

interface Rig {
  id: string;
  group: THREE.Group;
  /** 보조 직원은 0.9배 */
  body: THREE.Group;
  /** 코드 인형 (VRM을 쓰면 감춘다) */
  figure: THREE.Group;
  head: THREE.Group;
  forearms: THREE.Group[];
  torso: THREE.Object3D;
  ring: THREE.Mesh;
  target: THREE.Vector3;
  face: 1 | -1;
  act: Act;
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
  private readonly mats = new Map<string, THREE.MeshStandardMaterial>();
  private readonly woods = new Map<string, THREE.MeshStandardMaterial>();
  private readonly screens: THREE.MeshStandardMaterial[] = [];
  private readonly leds: THREE.MeshStandardMaterial[] = [];
  private readonly lamps: THREE.PointLight[] = [];
  private readonly bulbs: THREE.MeshStandardMaterial[] = [];
  private readonly redraws: (() => void)[] = [];
  private readonly docks: THREE.MeshStandardMaterial[] = [];
  private readonly papers: THREE.Mesh[] = [];
  private meetingSign: { busy: THREE.Mesh; free: THREE.Mesh } | null = null;
  private readonly rigs = new Map<string, Rig>();
  private readonly kit = new FigureKit();
  private disposed = false;
  private readonly glass: THREE.MeshStandardMaterial;
  private cat: THREE.Group | null = null;
  private catLabel: HTMLButtonElement | null = null;
  private robot: THREE.Group | null = null;
  private fly: { t: number; fromP: THREE.Vector3; fromT: THREE.Vector3; toP: THREE.Vector3; toT: THREE.Vector3 } | null = null;
  private raf = 0;
  private readonly clock = new THREE.Clock();
  private readonly resize: ResizeObserver;
  private readonly reduce: boolean;
  private readonly font: string;
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
    this.font = getComputedStyle(document.body).fontFamily;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 3.5;
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
    this.glass = new THREE.MeshStandardMaterial({ color: 0xbfe0e6, transparent: true, opacity: 0.22, roughness: 0.1, metalness: 0.1, depthWrite: false });
    this.build(names);
    document.fonts?.ready.then(() => this.redraws.forEach((d) => d())).catch(() => {});
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
    this.lamps.forEach((l) => (l.intensity = s.night ? 0.9 : 0));
    this.bulbs.forEach((m) => (m.emissiveIntensity = s.night ? 1.4 : 0.2));
    this.screens.forEach((m) => (m.emissiveIntensity = s.night ? 1.1 : 0.45));
    this.kit.setNight(s.night);
    const seen = new Set<string>();
    for (const p of s.placed) {
      seen.add(p.id);
      const rig = this.rigs.get(p.id) ?? this.makeRig(p);
      rig.target.set(p.seat.x, p.seat.seatY != null ? p.seat.seatY - 0.46 : 0, p.seat.z);
      rig.face = p.seat.face;
      rig.act = p.act;
      (rig.ring.material as THREE.MeshBasicMaterial).color.setHex(STATUS_COLOR[p.status]);
      rig.label.querySelector('.ao3-dot')!.setAttribute('data-status', p.status);
      rig.label.querySelector('.ao3-tag__name')!.textContent = p.name;
      const proj = rig.label.querySelector<HTMLElement>('.ao3-tag__proj')!;
      proj.textContent = p.project ?? '';
      proj.hidden = !p.project;
      rig.label.setAttribute('aria-label', p.project ? `${p.name}, 프로젝트 ${p.project}` : p.name);
      rig.label.classList.toggle('ao3-tag--small', p.helper);
      this.setModel(rig, p.model);
    }
    for (const [id, rig] of this.rigs) {
      if (seen.has(id)) continue;
      this.scene.remove(rig.group, rig.ring);
      rig.label.remove();
      rig.avatar?.dispose();
      disposeFigure(rig.figure);
      this.rigs.delete(id);
    }
    // 파견 라운지 도킹 표시등: 앉은 자리는 초록
    GUEST_SEATS.forEach((g, i) => {
      const on = s.placed.some((p) => p.seat === g);
      const m = this.docks[i];
      if (m) {
        m.color.setHex(on ? 0x5bd08d : 0x8e9496);
        m.emissive.setHex(on ? 0x3ccb78 : 0x000000);
      }
    });
    const meeting = s.placed.some((p) => MEETING_SEATS.includes(p.seat));
    if (this.meetingSign) {
      this.meetingSign.busy.visible = meeting;
      this.meetingSign.free.visible = !meeting;
    }
    this.papers.forEach((m, i) => (m.visible = i < s.approvals));
    if (this.catLabel) {
      this.catLabel.hidden = !s.cat;
      if (s.cat) {
        this.catLabel.querySelector('.ao3-tag__name')!.textContent = s.cat.name;
        this.catLabel.querySelector('.ao3-dot')!.setAttribute('data-status', s.cat.status);
      }
    }
    if (this.cat) this.cat.visible = !!s.cat;
  }

  /**
   * 그 직원에게 카메라가 다가간다. near(캐릭터 목록, 2026-10-22)면 더 가까이, 그 캐릭터 앞쪽 위에서 얼굴이 보이게.
   * 이름표를 누를 때는 지금 보는 방향을 그대로 두고 다가간다. inset: 왼쪽을 가린 목록 너비(px), 그만큼 비켜 보인다.
   */
  focus(id: string, near = false, inset = 0): void {
    const rig = this.rigs.get(id);
    const at = rig ? rig.group.position.clone() : id === 'git-cat' && this.cat ? this.cat.position.clone() : null;
    if (!at) return;
    const toT = at.setY(near ? (rig ? 1.1 : 0.4) : 0.8);
    // 앞쪽 위: 캐릭터가 보는 쪽(face)으로 비스듬히, 맞은편 모니터 너머로·천장 조명(2.6m) 높이쯤. OrbitControls 최소 거리(3.5)보다 조금 멀리
    const dist = near ? 3.6 : 6.5;
    // 돌아다니는 Git 고양이는 벽에 가리지 않게 위에서 내려다본다
    const nearDir = rig ? new THREE.Vector3(0.25, 0.42, 0.87 * rig.face) : new THREE.Vector3(0.3, 0.9, 0.35);
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
    }
    this.kit.dispose();
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
        r.avatar.animate(r.act, t, r.phase, m, dt);
      } else if (r.act === 'type') {
        r.forearms.forEach((f, i) => (f.rotation.x = Math.sin(t * 14 + r.phase + i * 1.7) * 0.07 * m));
        r.head.rotation.set(0.06, Math.sin(t * 0.35 + r.phase) * 0.12 * m, 0);
      } else if (r.act === 'talk') {
        r.forearms[0]!.rotation.x = 0;
        r.forearms[1]!.rotation.x = (-0.5 + Math.sin(t * 2.2 + r.phase) * 0.35) * m;
        r.head.rotation.set(0, Math.sin(t * 0.8 + r.phase) * 0.4 * m, 0);
      } else {
        r.forearms.forEach((f) => (f.rotation.x = 0));
        r.head.rotation.set(0, Math.sin(t * 0.25 + r.phase) * 0.5 * m, 0);
        r.torso.rotation.y = Math.sin(t * 0.25 + r.phase) * 0.06 * m;
      }
    }
    if (this.cat) {
      const cp = along([[18.0, 16.1], [22.1, 16.1], [22.1, 12.0], [17.2, 12.0]], 0.55 * m, t);
      this.cat.position.set(cp.x, 0, cp.z);
      this.cat.rotation.y = cp.dir - Math.PI / 2;
    }
    if (this.robot) {
      const rp = along([[23.3, 12.2], [28.9, 12.2], [28.9, 11.2], [23.3, 11.2]], 0.8 * m, t);
      this.robot.position.set(rp.x, 0, rp.z);
      this.robot.rotation.y = rp.dir;
    }
    this.leds.forEach((l, i) => (l.emissiveIntensity = 0.4 + (Math.sin(t * (2 + (i % 3)) + i) > 0.3 ? 0.9 : 0) * (m || 0.5)));
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
    if (this.cat && this.catLabel && !this.catLabel.hidden) put(this.catLabel, this.cat.position.x, 0.85, this.cat.position.z);
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
    body.add(fig.root);
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
      torso: fig.torso,
      ring,
      target: g.position.clone(),
      face: seat.face,
      act: p.act,
      phase: rnd(hash(p.id)) * 6.28,
      label: this.label(p.id),
      anchorY: (fig.top + 0.08) * body.scale.y,
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
      rig.anchorY = (rig.figureTop + 0.08) * rig.body.scale.y;
    }
    if (!url) return;
    import('./vrm.ts')
      .then((m) => m.loadAvatar(url))
      .then((av) => {
        if (this.disposed || this.rigs.get(rig.id) !== rig || rig.model !== url) return av.dispose();
        rig.body.add(av.root);
        rig.figure.visible = false;
        rig.avatar = av;
        rig.anchorY = (av.top + 0.08) * rig.body.scale.y;
      })
      .catch((err: unknown) => console.warn(`3D 모델을 읽지 못해 코드 인형으로 그려요: ${url}`, err));
  }

  // ---------- 만드는 도구 ----------

  private mat(color: number, o: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
    const key = `${color}:${JSON.stringify(o)}`;
    let m = this.mats.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.02, ...o });
      this.mats.set(key, m);
    }
    return m;
  }
  private add(m: THREE.Mesh, x: number, y: number, z: number, parent?: THREE.Object3D, shadow = true): THREE.Mesh {
    m.position.set(x, y, z);
    m.castShadow = shadow;
    m.receiveShadow = true;
    (parent ?? this.scene).add(m);
    return m;
  }
  private box(w: number, h: number, d: number, color: number, x: number, y: number, z: number, parent?: THREE.Object3D, o?: THREE.MeshStandardMaterialParameters): THREE.Mesh {
    return this.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.mat(color, o)), x, y, z, parent);
  }
  private flat(w: number, h: number, d: number, color: number, x: number, y: number, z: number, parent?: THREE.Object3D): THREE.Mesh {
    return this.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.mat(color)), x, y, z, parent, false);
  }
  private cyl(rt: number, rb: number, h: number, color: number, x: number, y: number, z: number, parent?: THREE.Object3D, seg = 20): THREE.Mesh {
    return this.add(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), this.mat(color)), x, y, z, parent);
  }
  private sphere(r: number, color: number, x: number, y: number, z: number, parent?: THREE.Object3D): THREE.Mesh {
    return this.add(new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), this.mat(color)), x, y, z, parent);
  }
  private wood(tone: 'oak' | 'walnut' | 'ash'): THREE.MeshStandardMaterial {
    let m = this.woods.get(tone);
    if (m) return m;
    const pal = { oak: [0xd2b48a, 0xa9824f, 0xe4cba4], walnut: [0x7a5537, 0x5e3f28, 0x93694a], ash: [0xe2d5be, 0xbda582, 0xefe6d6] }[tone];
    const cv = document.createElement('canvas');
    cv.width = 512;
    cv.height = 128;
    const c = cv.getContext('2d')!;
    c.fillStyle = css(pal[0]!);
    c.fillRect(0, 0, 512, 128);
    for (let i = 0; i < 70; i++) {
      const y = Math.random() * 128;
      const amp = 1 + Math.random() * 3;
      const ph = Math.random() * 6;
      c.strokeStyle = css(Math.random() < 0.5 ? pal[1]! : pal[2]!);
      c.globalAlpha = 0.18 + Math.random() * 0.3;
      c.lineWidth = 0.6 + Math.random() * 1.6;
      c.beginPath();
      for (let x = 0; x <= 512; x += 16) c.lineTo(x, y + Math.sin(x / 60 + ph) * amp);
      c.stroke();
    }
    for (let k = 0; k < 3; k++) {
      const kx = Math.random() * 512;
      const ky = Math.random() * 128;
      c.globalAlpha = 0.35;
      c.strokeStyle = css(pal[1]!);
      for (let r = 2; r < 10; r += 2.5) {
        c.beginPath();
        c.ellipse(kx, ky, r * 2.4, r, 0, 0, 6.28);
        c.stroke();
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = 4;
    m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62, metalness: 0 });
    this.woods.set(tone, m);
    return m;
  }
  private woodBox(w: number, h: number, d: number, tone: 'oak' | 'walnut' | 'ash', x: number, y: number, z: number): THREE.Mesh {
    return this.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.wood(tone)), x, y, z);
  }
  private roundTop(w: number, d: number, r: number, tone: 'oak' | 'walnut' | 'ash', x: number, y: number, z: number, thick = 0.04): THREE.Mesh {
    const s = new THREE.Shape();
    const hw = w / 2;
    const hd = d / 2;
    s.moveTo(-hw + r, -hd);
    s.lineTo(hw - r, -hd);
    s.quadraticCurveTo(hw, -hd, hw, -hd + r);
    s.lineTo(hw, hd - r);
    s.quadraticCurveTo(hw, hd, hw - r, hd);
    s.lineTo(-hw + r, hd);
    s.quadraticCurveTo(-hw, hd, -hw, hd - r);
    s.lineTo(-hw, -hd + r);
    s.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
    const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.008, bevelSegments: 2 });
    g.rotateX(-Math.PI / 2);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) + hw) / 2.2, (uv.getY(i) + hd) / 1.1);
    return this.add(new THREE.Mesh(g, this.wood(tone)), x, y - thick / 2, z);
  }
  /** 글자 판 (표지판·이름표·로고). 글꼴이 늦게 와도 다시 그린다 */
  private textPlane(text: string, sub: string | null, w: number, h: number, bg: number, fg: number, x: number, y: number, z: number, rotY = 0): THREE.Mesh {
    const cv = document.createElement('canvas');
    cv.width = 1024;
    cv.height = Math.round((1024 * h) / w);
    const tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = 4;
    const draw = () => {
      const c = cv.getContext('2d')!;
      c.fillStyle = css(bg);
      c.fillRect(0, 0, cv.width, cv.height);
      c.fillStyle = css(fg);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.font = `700 ${Math.round(cv.height * (sub ? 0.42 : 0.55))}px ${this.font}`;
      c.fillText(text, cv.width / 2, cv.height * (sub ? 0.4 : 0.52));
      if (sub) {
        c.globalAlpha = 0.7;
        c.font = `500 ${Math.round(cv.height * 0.2)}px ${this.font}`;
        c.fillText(sub, cv.width / 2, cv.height * 0.78);
        c.globalAlpha = 1;
      }
      tex.needsUpdate = true;
    };
    draw();
    this.redraws.push(draw);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }));
    m.position.set(x, y, z);
    m.rotation.y = rotY;
    this.scene.add(m);
    return m;
  }
  private tiles(x1: number, z1: number, x2: number, z2: number, base: number, line: number, size = 1): void {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const c = cv.getContext('2d')!;
    c.fillStyle = css(base);
    c.fillRect(0, 0, 128, 128);
    c.strokeStyle = css(line);
    c.lineWidth = 2;
    c.strokeRect(1, 1, 126, 126);
    c.globalAlpha = 0.08;
    c.fillStyle = css(line);
    for (let i = 0; i < 260; i++) c.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
    const tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const w = x2 - x1;
    const d = z2 - z1;
    tex.repeat.set(w / size, d / size);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x1 + w / 2, 0.012, z1 + d / 2);
    m.receiveShadow = true;
    this.scene.add(m);
  }
  private screenMat(kind: 'code' | 'doc' | 'chart' | 'chat' | null, color = 0x9bb8d6): THREE.MeshStandardMaterial {
    let m: THREE.MeshStandardMaterial;
    if (kind) {
      const cv = document.createElement('canvas');
      cv.width = 256;
      cv.height = 150;
      const c = cv.getContext('2d')!;
      const dark = kind === 'code';
      c.fillStyle = css(dark ? 0x1e2430 : 0xf7f8fa);
      c.fillRect(0, 0, 256, 150);
      c.fillStyle = css(dark ? 0x2a3242 : 0xe3e8ef);
      c.fillRect(0, 0, 256, 12);
      c.fillRect(0, 12, 40, 138);
      if (kind === 'chart') {
        for (let b = 0; b < 7; b++) {
          c.fillStyle = css(b % 2 ? 0x5ba88a : 0x3e7bd6);
          const bh = 20 + ((b * 37) % 70);
          c.fillRect(56 + b * 26, 135 - bh, 16, bh);
        }
      } else if (kind === 'chat') {
        for (let i = 0; i < 6; i++) {
          c.fillStyle = css(i % 2 ? 0xdcebe3 : 0xe6eaf3);
          const mw = 70 + ((i * 29) % 90);
          c.fillRect(i % 2 ? 236 - mw : 52, 20 + i * 21, mw, 14);
        }
      } else {
        const cols = dark ? [0x7fb2f0, 0xc59bf0, 0x9bd49b, 0xe8c27a, 0xb8c2d0] : [0x9aa6b5, 0xc2cad4];
        for (let l = 0; l < 12; l++) {
          const x = 48 + (dark ? (l % 4) * 10 : 0);
          c.fillStyle = css(cols[l % cols.length]!);
          c.fillRect(x, 20 + l * 10, Math.min(60 + ((l * 53) % 140), 248 - x), 4);
        }
      }
      const tex = new THREE.CanvasTexture(cv);
      tex.encoding = THREE.sRGBEncoding;
      m = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.45, roughness: 0.4 });
    } else m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.45, roughness: 0.4 });
    this.screens.push(m);
    return m;
  }

  // ---------- 가구 ----------

  private chair(x: number, z: number, face: 1 | -1, color = 0x3a403c): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = face > 0 ? 0 : Math.PI;
    this.box(0.5, 0.07, 0.48, color, 0, 0.45, 0.01, g);
    this.box(0.46, 0.03, 0.44, 0x2a2e2b, 0, 0.405, 0.01, g);
    this.box(0.48, 0.5, 0.06, color, 0, 0.78, -0.26, g).rotation.x = 0.1;
    this.box(0.4, 0.08, 0.04, 0x2a2e2b, 0, 0.56, -0.25, g);
    for (const sd of [-1, 1]) {
      this.box(0.05, 0.03, 0.28, 0x2a2e2b, sd * 0.27, 0.64, -0.02, g);
      this.box(0.03, 0.18, 0.03, 0x6c726e, sd * 0.27, 0.54, -0.1, g);
    }
    this.cyl(0.03, 0.035, 0.34, 0x8a908c, 0, 0.23, 0, g, 10);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      this.box(0.3, 0.035, 0.05, 0x5e6662, Math.cos(a) * 0.15, 0.07, Math.sin(a) * 0.15, g).rotation.y = -a;
      const wh = this.cyl(0.03, 0.03, 0.035, 0x1f2321, Math.cos(a) * 0.28, 0.03, Math.sin(a) * 0.28, g, 10);
      wh.rotation.z = Math.PI / 2;
    }
    this.scene.add(g);
    return g;
  }
  private monitor(x: number, z: number, face: 1 | -1, yaw = 0, kind: 'code' | 'doc' | 'chart' | 'chat' | null = 'doc', arm = false): void {
    const g = new THREE.Group();
    g.position.set(x, 0.77, z);
    g.rotation.y = (face > 0 ? 0 : Math.PI) + yaw;
    if (arm) {
      this.box(0.04, 0.32, 0.04, 0x9aa0a3, 0, 0.16, -0.06, g);
      this.box(0.04, 0.04, 0.12, 0x9aa0a3, 0, 0.3, -0.01, g);
    } else {
      this.box(0.05, 0.3, 0.05, 0x2a302c, 0, 0.15, -0.03, g);
      this.box(0.24, 0.015, 0.17, 0x2a302c, 0, 0.008, 0, g);
    }
    this.box(0.62, 0.38, 0.025, 0x16191a, 0, 0.42, 0.03, g);
    const s = new THREE.Mesh(new THREE.PlaneGeometry(0.59, 0.335), this.screenMat(kind));
    s.position.set(0, 0.43, 0.044);
    g.add(s);
    this.scene.add(g);
  }
  private laptop(x: number, z: number, face: 1 | -1, kind: 'code' | 'doc' | 'chart' | 'chat' = 'doc'): void {
    const g = new THREE.Group();
    g.position.set(x, 0.775, z);
    g.rotation.y = face > 0 ? 0 : Math.PI;
    this.box(0.34, 0.015, 0.24, 0xb9bec0, 0, 0.008, 0, g);
    const lid = new THREE.Group();
    lid.position.set(0, 0.015, -0.12);
    lid.rotation.x = -0.25;
    g.add(lid);
    this.box(0.34, 0.22, 0.012, 0xb9bec0, 0, 0.11, 0, lid);
    const s = new THREE.Mesh(new THREE.PlaneGeometry(0.31, 0.19), this.screenMat(kind));
    s.position.set(0, 0.11, 0.008);
    lid.add(s);
    this.scene.add(g);
  }
  private leafGeo = new Map<string, THREE.ShapeGeometry>();
  private leafMat = new Map<number, THREE.MeshStandardMaterial>();
  private leaf(parent: THREE.Object3D, len: number, wid: number, color: number, yaw: number, tilt: number, x: number, y: number, z: number, curl = 0): void {
    const key = `${len}:${wid}`;
    let geo = this.leafGeo.get(key);
    if (!geo) {
      const s = new THREE.Shape();
      s.moveTo(0, 0);
      s.bezierCurveTo(wid * 0.9, len * 0.15, wid, len * 0.65, 0, len);
      s.bezierCurveTo(-wid, len * 0.65, -wid * 0.9, len * 0.15, 0, 0);
      geo = new THREE.ShapeGeometry(s, 10);
      this.leafGeo.set(key, geo);
    }
    let mat = this.leafMat.get(color);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.6 });
      this.leafMat.set(color, mat);
    }
    const piv = new THREE.Group();
    piv.position.set(x, y, z);
    piv.rotation.set(0, yaw, 0);
    parent.add(piv);
    const inner = new THREE.Group();
    inner.rotation.x = tilt;
    piv.add(inner);
    const m = new THREE.Mesh(geo, mat);
    m.rotation.y = curl;
    m.castShadow = true;
    inner.add(m);
  }
  private pot(x: number, y: number, z: number, r: number, h: number, color = 0xede8de): { g: THREE.Group; top: number } {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    this.scene.add(g);
    this.cyl(r * 1.05, r * 0.95, 0.02, 0xbdb5a6, 0, 0.01, 0, g, 24);
    this.cyl(r, r * 0.78, h, color, 0, h / 2 + 0.02, 0, g, 24);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r * 0.98, r * 0.06, 8, 24), this.mat(color));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = h + 0.02;
    g.add(rim);
    this.cyl(r * 0.92, r * 0.92, 0.01, 0x4a3828, 0, h + 0.01, 0, g, 24);
    return { g, top: h + 0.03 };
  }
  private plant(x: number, y: number, z: number, s = 0.5): void {
    const GREENS = [0x2f7f52, 0x3a9460, 0x267048, 0x4aa36c];
    if (s < 0.25) {
      const p = this.pot(x, y, z, 0.05, 0.06, 0xe07a5f);
      for (let ring = 0; ring < 3; ring++) for (let i = 0; i < 7; i++) this.leaf(p.g, 0.05 - ring * 0.012, 0.022, ring ? 0x8fbf8a : 0x6fa57a, (i / 7) * 6.28 + ring * 0.4, 1.25 - ring * 0.4, 0, p.top, 0);
      return;
    }
    if (rnd(x * 1.3 + z * 0.7) < 0.45) {
      const p = this.pot(x, y, z, (0.15 * s) / 0.4, (0.28 * s) / 0.4, 0x3b4048);
      for (let i = 0; i < 11; i++) {
        const yaw = rnd(i + x) * 6.28;
        const r = rnd(i * 7 + z) * 0.08 * s;
        this.leaf(p.g, ((0.45 + rnd(i * 3 + x) * 0.35) * s) / 0.4, (0.045 * s) / 0.4, i % 3 ? 0x2e6b45 : 0x557a3a, yaw, 0.08 + rnd(i + 9) * 0.18, Math.sin(yaw) * r, p.top, Math.cos(yaw) * r, 0.3);
      }
      return;
    }
    const p = this.pot(x, y, z, (0.22 * s) / 0.5, (0.36 * s) / 0.5, 0xe7e1d5);
    for (let i = 0; i < 9; i++) {
      const yaw = (i / 9) * Math.PI * 2 + rnd(x + i) * 0.5;
      const stemH = ((0.35 + rnd(i + x * 3) * 0.35) * s) / 0.5;
      const sx = Math.sin(yaw) * 0.12 * s;
      const sz = Math.cos(yaw) * 0.12 * s;
      const st = this.cyl(0.008, 0.012, stemH, 0x5c8a4a, sx / 2, p.top + stemH / 2, sz / 2, p.g, 6);
      st.rotation.x = Math.cos(yaw) * 0.35;
      st.rotation.z = -Math.sin(yaw) * 0.35;
      this.leaf(p.g, (0.34 * s) / 0.5, (0.24 * s) / 0.5, GREENS[i % 4]!, yaw, 0.7 + rnd(z + i) * 0.6, sx, p.top + stemH, sz, 0.2);
    }
  }
  private tallPlant(x: number, z: number): void {
    const GREENS = [0x2f7f52, 0x3a9460, 0x267048, 0x4aa36c];
    const p = this.pot(x, 0, z, 0.27, 0.48, 0xd6cdbe);
    this.cyl(0.025, 0.04, 1.35, 0x6b5134, 0, p.top + 0.65, 0, p.g, 8);
    const branches = [[0.4, 1.15, 0.35], [2.3, 1.3, 0.3], [4.2, 1.0, 0.32], [5.4, 1.45, 0.25]] as const;
    branches.forEach((b, bi) => {
      const bx = Math.sin(b[0]) * b[2];
      const bz = Math.cos(b[0]) * b[2];
      const br = this.cyl(0.012, 0.018, Math.hypot(b[2], 0.25), 0x6b5134, bx / 2, p.top + b[1], bz / 2, p.g, 6);
      br.rotation.x = Math.cos(b[0]) * 0.9;
      br.rotation.z = -Math.sin(b[0]) * 0.9;
      for (let i = 0; i < 6; i++) this.leaf(p.g, 0.26, 0.16, GREENS[(i + bi) % 4]!, b[0] + (i - 2.5) * 0.5, 0.6 + rnd(i + bi * 7 + x) * 0.7, bx * (0.6 + i * 0.08), p.top + b[1] + 0.12 + i * 0.03, bz * (0.6 + i * 0.08), 0.1);
    });
    for (let t = 0; t < 7; t++) this.leaf(p.g, 0.28, 0.17, GREENS[t % 4]!, (t / 7) * 6.28, 0.35 + rnd(t + z) * 0.4, 0, p.top + 1.32, 0, 0.1);
  }
  private lamp(x: number, z: number): void {
    this.cyl(0.07, 0.08, 0.02, 0x2a302c, x, 0.785, z, undefined, 16);
    this.box(0.02, 0.3, 0.02, 0x2a302c, x, 0.93, z).rotation.z = 0.25;
    this.box(0.02, 0.26, 0.02, 0x2a302c, x - 0.08, 1.15, z).rotation.z = -0.9;
    this.cyl(0.035, 0.07, 0.07, 0x2a302c, x - 0.2, 1.2, z, undefined, 14);
  }
  private mug(x: number, z: number, color: number, rot = 0): void {
    const g = new THREE.Group();
    g.position.set(x, 0.775, z);
    g.rotation.y = rot;
    this.scene.add(g);
    this.cyl(0.04, 0.036, 0.09, color, 0, 0.045, 0, g, 16);
    this.cyl(0.034, 0.034, 0.005, 0x4a3226, 0, 0.088, 0, g, 16);
    const h = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.006, 6, 12, Math.PI), this.mat(color));
    h.position.set(0.04, 0.045, 0);
    h.rotation.z = -Math.PI / 2;
    g.add(h);
  }
  private deskStuff(sx: number, deskZ: number, face: 1 | -1, seed: number, name: string | null): void {
    const k = rnd(seed);
    this.flat(0.26, 0.004, 0.22, 0x2e3436, sx + 0.33, 0.777, deskZ + 0.13 * face);
    this.box(0.06, 0.02, 0.1, 0xdad5cb, sx + 0.33, 0.788, deskZ + 0.13 * face);
    this.box(0.44, 0.02, 0.14, 0xe4dfd5, sx, 0.785, deskZ + 0.13 * face);
    for (let r = 0; r < 4; r++) this.flat(0.4, 0.003, 0.018, 0xc9c3b8, sx, 0.797, deskZ + 0.13 * face + (r - 1.5) * 0.028);
    if (k < 0.75) this.mug(sx - 0.4, deskZ + 0.15 * face, [0xffffff, 0xe07a5f, 0x3e7bd6, 0x2f2f2f][Math.floor(k * 4)]!, k * 6);
    if (k > 0.3) this.box(0.15, 0.012, 0.21, [0x2f5d8a, 0x7a4e8c, 0xc9b796][Math.floor(k * 3)]!, sx - 0.55, 0.782, deskZ + 0.3 * face).rotation.y = 0.2;
    if (k > 0.55) {
      this.cyl(0.03, 0.03, 0.2, 0x8fb4c8, sx + 0.62, 0.875, deskZ + 0.25 * face, undefined, 12);
      this.cyl(0.022, 0.022, 0.03, 0x2a302c, sx + 0.62, 0.99, deskZ + 0.25 * face, undefined, 10);
    }
    if (k < 0.4) {
      const hp = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.012, 6, 16, Math.PI), this.mat(0x22262a));
      hp.position.set(sx + 0.6, 0.79, deskZ + 0.3 * face);
      hp.rotation.x = -Math.PI / 2;
      this.scene.add(hp);
    }
    if (k > 0.8) this.plant(sx - 0.62, 0.775, deskZ + 0.45 * face, 0.16);
    this.box(0.08, 0.008, 0.15, 0x1b211e, sx - 0.2, 0.78, deskZ + 0.38 * face).rotation.y = 0.4;
    if (name) this.textPlane(name, null, 0.36, 0.09, 0xffffff, 0x1b211e, sx, 1.06, deskZ + (face > 0 ? 0.6 : -0.6) - 0.025 * face, face > 0 ? Math.PI : 0);
  }
  /** 긴 공용 책상: 좌석 x = x0 + 1 + 2i, 북쪽 좌석 z = zN - 0.3, 남쪽 좌석 z = zN + 1.95. 의자는 늘 놓고 사람만 오간다 */
  private bench(x0: number, zN: number, n: number, names: Readonly<Record<string, string>>, o: { dual?: boolean; laptop?: boolean; screen?: number; tone?: 'oak' | 'walnut' | 'ash'; kind?: 'code' | 'doc' | 'chart' | 'chat' } = {}): void {
    const w = n * 2;
    const d = 1.65;
    const zc = zN + d / 2;
    this.roundTop(w, d, 0.08, o.tone ?? 'oak', x0 + w / 2, 0.77, zc, 0.04);
    this.box(w - 0.1, 0.38, 0.04, o.screen ?? 0xc9c0af, x0 + w / 2, 0.98, zc);
    this.flat(w - 0.06, 0.03, 0.06, 0x9aa0a3, x0 + w / 2, 1.18, zc);
    for (let lx = 0; lx <= n; lx++) {
      const px = x0 + 0.15 + (lx * (w - 0.3)) / n;
      this.box(0.05, 0.7, 0.06, 0x3a3f3d, px, 0.4, zc);
      this.box(0.05, 0.04, d - 0.2, 0x3a3f3d, px, 0.03, zc);
      this.box(0.05, 0.04, d - 0.3, 0x3a3f3d, px, 0.73, zc);
    }
    this.box(w - 0.3, 0.06, 0.14, 0x5e6662, x0 + w / 2, 0.66, zc);
    const seatName = (x: number, z: number) => {
      const id = Object.entries(DESK_SEATS).find(([, s]) => Math.abs(s.x - x) < 0.3 && Math.abs(s.z - z) < 0.3)?.[0];
      return id ? (names[id] ?? null) : null;
    };
    for (let i = 0; i < n; i++) {
      const sx = x0 + 1 + 2 * i;
      for (const [sz, face] of [[zN - 0.3, 1], [zN + d + 0.3, -1]] as const) {
        const deskZ = face > 0 ? zN + 0.15 : zN + d - 0.15;
        const monZ = face > 0 ? zc - 0.22 : zc + 0.22;
        const kind = o.kind ?? 'doc';
        if (o.dual) {
          this.monitor(sx - 0.32, monZ, face > 0 ? -1 : 1, -0.16 * face, 'code', true);
          this.monitor(sx + 0.32, monZ, face > 0 ? -1 : 1, 0.16 * face, kind === 'code' ? 'chat' : kind, true);
        } else if (o.laptop) this.laptop(sx, deskZ + 0.4 * face, face > 0 ? -1 : 1, kind);
        else this.monitor(sx, monZ, face > 0 ? -1 : 1, 0, kind);
        this.deskStuff(sx, deskZ, face, sx * 7 + sz * 3, seatName(sx, sz));
        const pz = face > 0 ? zN + 0.32 : zN + d - 0.32;
        this.box(0.42, 0.56, 0.5, 0xbfc3c0, sx + 0.62, 0.3, pz);
        for (const hy of [0.42, 0.28, 0.14]) this.flat(0.16, 0.015, 0.02, 0x7e8581, sx + 0.62, hy + 0.06, pz + 0.26 * face);
        this.chair(sx, sz, face);
      }
    }
    this.lamp(x0 + w - 0.25, zN + 0.3);
    this.plant(x0 + w / 2, 1.19, zc, 0.16);
  }
  private planterWall(x: number, z1: number, z2: number): void {
    const len = z2 - z1;
    const zc = z1 + len / 2;
    this.woodBox(0.38, 0.95, len, 'ash', x, 0.475, zc);
    this.flat(0.3, 0.04, len - 0.1, 0x4a3828, x, 0.97, zc);
    for (let z = z1 + 0.25; z < z2 - 0.15; z += 0.18) {
      for (let j = 0; j < 3; j++) this.leaf(this.scene, 0.3 + rnd(z * 9 + j) * 0.25, 0.035, (j + Math.round(z * 10)) % 3 ? 0x2e6b45 : 0x557a3a, rnd(z + j) * 6.28, 0.1 + rnd(z * 3 + j) * 0.2, x + (j - 1) * 0.08, 0.98, z);
    }
  }
  private hangingSign(text: string, sub: string, x: number, z: number): void {
    this.textPlane(text, sub, 2.4, 0.6, 0xffffff, 0x1b211e, x, 2.75, z + 0.01);
    this.box(2.46, 0.66, 0.03, 0x2a302c, x, 2.75, z - 0.02).castShadow = false;
    for (const sd of [-1, 1]) this.box(0.012, 0.6, 0.012, 0x2a302c, x + sd * 1.0, 3.38, z);
  }
  private pendant(x: number, z: number): void {
    this.box(0.008, 0.6, 0.008, 0x2a302c, x, 3.1, z).castShadow = false;
    this.cyl(0.07, 0.2, 0.16, 0x2a302c, x, 2.72, z).castShadow = false;
    const bm = new THREE.MeshStandardMaterial({ color: 0xfff4da, emissive: 0xffd9a0, emissiveIntensity: 0.2 });
    const b = new THREE.Mesh(new THREE.CircleGeometry(0.19, 20), bm);
    b.rotation.x = Math.PI / 2;
    b.position.set(x, 2.635, z);
    this.scene.add(b);
    this.bulbs.push(bm);
    const l = new THREE.PointLight(0xffd9a0, 0, 6.5, 2);
    l.position.set(x, 2.2, z);
    this.scene.add(l);
    this.lamps.push(l);
  }
  private whiteboard(x: number, z: number, w: number, rotY: number, scribble: readonly (readonly [number, number, number, number])[] = []): void {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    this.box(w, 1.0, 0.04, 0xfafaf7, 0, 1.45, 0, g);
    this.box(w + 0.06, 0.04, 0.08, 0x9aa3a0, 0, 0.94, 0.02, g);
    for (const s of scribble) this.flat(s[2], 0.03, 0.005, s[3], s[0], 1.45 + s[1], 0.025, g);
    for (const dx of [-w / 2 + 0.1, w / 2 - 0.1]) this.box(0.04, 0.95, 0.04, 0x9aa3a0, dx, 0.47, 0, g);
    this.scene.add(g);
  }
  private glassRoom(x1: number, z1: number, x2: number, z2: number, door: { side: 'n' | 'e' | 's' | 'w'; at: number }, h = 2.4): void {
    const wall = (ax: number, az: number, bx: number, bz: number) => {
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.05) return;
      const rot = -Math.atan2(bz - az, bx - ax);
      const g = new THREE.Mesh(new THREE.BoxGeometry(len, h, 0.04), this.glass);
      g.position.set((ax + bx) / 2, h / 2, (az + bz) / 2);
      g.rotation.y = rot;
      this.scene.add(g);
      for (const [yy, hh, dd, col] of [[h, 0.06, 0.08, 0x8e9895], [0.03, 0.06, 0.08, 0x8e9895], [1.1, 0.12, 0.05, 0xe8eef0]] as const) {
        this.box(len, hh, dd, col, (ax + bx) / 2, yy, (az + bz) / 2).rotation.y = rot;
      }
    };
    const sides = [[x1, z1, x2, z1, 'n'], [x2, z1, x2, z2, 'e'], [x2, z2, x1, z2, 's'], [x1, z2, x1, z1, 'w']] as const;
    for (const sd of sides) {
      if (door.side === sd[4]) {
        const half = 0.55;
        if (sd[4] === 'n' || sd[4] === 's') {
          const lo = Math.min(sd[0], sd[2]);
          const hi = Math.max(sd[0], sd[2]);
          wall(lo, sd[1], door.at - half, sd[1]);
          wall(door.at + half, sd[1], hi, sd[1]);
        } else {
          const lo = Math.min(sd[1], sd[3]);
          const hi = Math.max(sd[1], sd[3]);
          wall(sd[0], lo, sd[0], door.at - half);
          wall(sd[0], door.at + half, sd[0], hi);
        }
      } else wall(sd[0], sd[1], sd[2], sd[3]);
      this.box(0.1, h, 0.1, 0x8e9895, sd[0], h / 2, sd[1]);
    }
  }

  // ---------- 층 전체 ----------

  private build(names: Readonly<Record<string, string>>): void {
    this.flat(W, 0.1, D, 0xe6e2da, CX, -0.05, CZ);
    this.tiles(0, 0, W, D, 0xe9e5dd, 0xdcd6cb, 1.2);
    this.flat(28.4, 0.005, 0.06, 0x7fb59a, CX, 0.02, 6.9);
    this.flat(28.4, 0.005, 0.06, 0x7fb59a, CX, 0.02, 12.05);
    // 북쪽 통유리·블라인드·창턱, 낮은 벽, 기둥
    this.box(W, 0.35, 0.2, 0xd4cfc5, CX, 0.17, 0);
    for (let mx = 0; mx <= W; mx += 1.5) this.box(0.06, 3.2, 0.1, 0x8e9895, mx, 1.6, 0);
    const ng = new THREE.Mesh(new THREE.BoxGeometry(W, 2.9, 0.04), this.glass);
    ng.position.set(CX, 1.75, 0);
    this.scene.add(ng);
    this.box(W, 0.1, 0.16, 0x8e9895, CX, 3.2, 0);
    for (let s = 0; s < 6; s++) this.flat(W, 0.035, 0.06, 0xedeae4, CX, 3.05 - s * 0.075, 0.1);
    this.box(W, 0.06, 0.32, 0xc9c1b4, CX, 0.42, 0.22);
    this.box(0.2, 0.5, D, 0xd4cfc5, 0, 0.25, CZ);
    this.box(0.2, 0.5, D, 0xd4cfc5, W, 0.25, CZ);
    this.box(W, 0.5, 0.2, 0xd4cfc5, CX, 0.25, D);
    for (const [x, z] of [[10, 7.0], [20.2, 7.0], [10.8, 12.4], [16.75, 12.4]] as const) this.box(0.45, 3.1, 0.45, 0xf2efe9, x, 1.55, z);
    for (let px = 1.2; px < W; px += 3.6) this.plant(px, 0.45, 0.22, 0.2);

    // 개발팀
    this.tiles(0.8, 0.9, 9.4, 6.2, 0xd9dee4, 0xc7ced6);
    this.hangingSign('개발팀', 'Dev', 4.6, 0.75);
    this.bench(1.6, 2.3, 3, names, { dual: true, screen: 0x8fa3b8, tone: 'ash', kind: 'code' });
    this.whiteboard(8.6, 3.2, 1.5, -Math.PI / 2, [[-0.4, 0.25, 0.4, 0x2d64c8], [-0.1, 0.1, 0.9, 0x1b211e], [0.2, -0.1, 0.5, 0xc0392b], [-0.3, -0.25, 0.6, 0x17845a]]);
    this.box(0.6, 1.1, 0.4, 0x3b4048, 8.6, 0.55, 5.3);
    this.pendant(3.6, 3.1);
    this.pendant(5.6, 3.1);
    this.planterWall(9.8, 1.0, 5.8);
    // 품질보증팀
    this.tiles(10.2, 0.9, 14.8, 6.2, 0xdce3dc, 0xc9d3c9);
    this.hangingSign('품질보증팀', 'QA', 12.4, 0.75);
    this.bench(10.4, 2.3, 2, names, { screen: 0x9db5a0, tone: 'oak', kind: 'doc' });
    this.box(1.2, 0.9, 0.4, 0xd9d3c7, 12.4, 0.45, 5.6);
    this.pendant(12.4, 3.1);
    this.planterWall(15.0, 1.0, 5.8);
    // 기획실 + 칸반 벽
    this.tiles(15.4, 0.9, 20.2, 6.2, 0xe2dee6, 0xd1ccd8);
    this.hangingSign('기획실', 'Planning', 17.6, 0.75);
    this.bench(15.6, 2.3, 2, names, { laptop: true, screen: 0xb3a7c4, tone: 'oak', kind: 'doc' });
    this.whiteboard(17.6, 5.75, 2.4, 0);
    const notes = [0xf7d96b, 0xf4a6a0, 0xa8d5ba, 0xa7c7f2];
    for (let col = 0; col < 3; col++) for (let r = 0; r < 4; r++) if ((col + r) % 4 !== 3) this.flat(0.16, 0.16, 0.01, notes[(col + r) % 4]!, 16.85 + col * 0.75, 1.75 - r * 0.2, 5.78);
    this.pendant(17.6, 3.1);
    // CEO실
    this.tiles(20.6, 0.9, 26.4, 6.4, 0xe5d6bc, 0xd5c3a3, 0.6);
    this.glassRoom(20.6, 0.9, 26.4, 6.4, { side: 'w', at: 4.9 });
    this.textPlane('CEO실', null, 1.0, 0.28, 0x1b211e, 0xffffff, 20.56, 1.8, 3.95, -Math.PI / 2);
    this.flat(2.4, 0.015, 1.9, 0xcdbfa8, 22.0, 0.02, 2.2);
    this.box(0.7, 0.42, 1.9, 0x9db2a6, 21.05, 0.21, 2.2);
    this.box(0.18, 0.75, 1.9, 0x8ba294, 20.8, 0.38, 2.2);
    this.woodBox(0.9, 0.36, 0.6, 'oak', 22.2, 0.18, 2.2);
    this.roundTop(2.0, 0.95, 0.12, 'walnut', 24.9, 0.79, 1.7, 0.05);
    this.woodBox(1.9, 0.7, 0.05, 'walnut', 24.9, 0.4, 2.15);
    this.monitor(24.6, 1.45, 1, 0, 'chart');
    this.lamp(25.75, 1.4);
    this.chair(24.9, 1.15, 1, 0x22262a);
    this.woodBox(1.8, 1.6, 0.35, 'ash', 24.9, 0.8, 1.0);
    this.bench(21.3, 4.0, 2, names, { screen: 0xa7b9b0, tone: 'walnut', kind: 'chart' });
    this.tallPlant(26.0, 5.9);
    // 서버실
    this.tiles(26.9, 0.9, 29.1, 6.4, 0xd8d6d2, 0xc5c2bc, 0.6);
    this.glassRoom(26.9, 0.9, 29.1, 6.4, { side: 's', at: 28.0 });
    for (const rx of [27.5, 28.5]) {
      this.box(0.6, 2.2, 4.2, 0x23282a, rx, 1.1, 3.5);
      for (let k = 0; k < 10; k++) {
        const lm = new THREE.MeshStandardMaterial({ color: 0x5bd08d, emissive: 0x3ccb78, emissiveIntensity: 1 });
        const l = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.04, 0.08), lm);
        l.position.set(rx + 0.31 * (rx < 28 ? 1 : -1), 0.35 + (k % 5) * 0.4, 1.8 + Math.floor(k / 5) * 2.4 + (k % 3) * 0.3);
        this.scene.add(l);
        this.leds.push(lm);
      }
    }
    // 계단 라이브러리
    ([[1.0, 8.0], [0.75, 8.8], [0.5, 9.6], [0.25, 10.4]] as const).forEach(([h, z], i) => this.woodBox(8.6, h, 0.8, i < 2 ? 'ash' : 'oak', 5.3, h / 2, z));
    this.woodBox(8.6, 2.3, 0.35, 'walnut', 5.3, 1.15, 7.45);
    const books = [0x2f8f5b, 0xc9b796, 0x5b665f, 0x3e7bd6, 0xe7dcc8, 0xb4541a, 0x7a4e8c];
    for (let row = 0; row < 3; row++) {
      for (let bx = 1.2; bx < 9.4; bx += 0.17) {
        if (rnd(bx * 13 + row) < 0.12) continue;
        const bh = 0.42 + rnd(bx * 7 + row) * 0.18;
        this.flat(0.13, bh, 0.24, books[Math.floor(rnd(bx * 3 + row * 5) * books.length)]!, bx, 0.35 + row * 0.7 + bh / 2, 7.65);
      }
    }
    this.tallPlant(9.6, 10.6);
    // 커피 바
    this.tiles(10.9, 7.4, 15.8, 11.4, 0xe6e1d8, 0xd6cfc2, 0.5);
    this.box(4.6, 1.0, 0.8, 0x2f3532, 13.3, 0.5, 8.0);
    this.woodBox(4.7, 0.05, 0.86, 'oak', 13.3, 1.02, 8.0);
    this.box(0.55, 0.55, 0.45, 0xb9c2bd, 11.7, 1.32, 7.9);
    this.woodBox(4.6, 0.04, 0.25, 'walnut', 13.3, 2.0, 7.65);
    this.woodBox(4.6, 0.04, 0.25, 'walnut', 13.3, 2.45, 7.65);
    for (const sx of [12.0, 13.2, 14.4]) {
      this.cyl(0.22, 0.22, 0.06, 0xcdbfa8, sx, 0.62, 9.35);
      this.cyl(0.04, 0.04, 0.6, 0x6c726e, sx, 0.3, 9.35, undefined, 8);
    }
    for (const tx of [12.0, 14.4]) {
      this.cyl(0.4, 0.4, 0.04, 0xf4f0e8, tx, 0.74, 10.6).material = this.wood('ash');
      this.cyl(0.04, 0.04, 0.72, 0x6c726e, tx, 0.36, 10.6, undefined, 8);
    }
    this.pendant(12.6, 9.0);
    this.pendant(14.0, 9.0);
    // 라운지
    this.tiles(16.2, 7.6, 22.6, 11.2, 0xdce3de, 0xcbd4ce, 0.8);
    this.box(3.2, 0.42, 0.85, 0x9db2a6, 18.4, 0.21, 8.15);
    this.box(3.2, 0.6, 0.2, 0x8ba294, 18.4, 0.45, 7.8);
    this.box(3.2, 0.42, 0.85, 0x9db2a6, 18.4, 0.21, 10.35);
    this.box(3.2, 0.6, 0.2, 0x8ba294, 18.4, 0.45, 10.7);
    const ct = this.cyl(0.95, 0.95, 0.05, 0xc6ad86, 18.4, 0.4, 9.25);
    ct.material = this.wood('oak');
    ct.scale.z = 0.42;
    this.tallPlant(22.2, 7.9);
    this.tallPlant(16.5, 10.9);
    // 폰 부스
    for (const bx of [23.0, 24.4]) {
      this.glassRoom(bx, 7.9, bx + 1.2, 9.4, { side: 's', at: bx + 0.6 }, 2.2);
      this.box(1.0, 0.04, 0.4, 0xf4f0e8, bx + 0.6, 0.75, 8.15);
    }
    // 리셉션·엘리베이터 + 결재함 서류 (결재 대기 수만큼)
    this.tiles(25.8, 7.4, 29.6, 11.6, 0xe3e0da, 0xd2cec6, 0.6);
    this.box(2.4, 1.05, 0.6, 0xf4f0e8, 27.2, 0.52, 10.0);
    this.woodBox(2.5, 0.05, 0.75, 'walnut', 27.2, 1.07, 10.0);
    this.textPlane('LINDA', 'AI OFFICE · 2F', 2.2, 0.55, 0x1b211e, 0xffffff, 27.2, 0.62, 10.31);
    for (let i = 0; i < 5; i++) {
      const p = this.box(0.3, 0.012, 0.22, 0xf7f6f1, 26.4 + i * 0.01, 1.11 + i * 0.014, 10.0 + i * 0.01);
      p.rotation.y = i * 0.07;
      this.papers.push(p);
    }
    for (const ez of [8.2, 9.8]) this.box(0.1, 2.4, 1.2, 0xb7bdbd, 29.75, 1.2, ez, undefined, { metalness: 0.6, roughness: 0.3 });
    this.tallPlant(26.0, 7.8);
    // 마케팅·콘텐츠팀
    this.tiles(0.8, 12.5, 5.7, 17.4, 0xe9e0d1, 0xd9cdb8);
    this.hangingSign('마케팅 · 콘텐츠팀', 'Marketing', 3.3, 12.35);
    this.bench(1.3, 13.3, 2, names, { laptop: true, screen: 0xd7bf96, tone: 'oak', kind: 'doc' });
    this.whiteboard(3.3, 16.9, 2.6, Math.PI);
    this.pendant(3.3, 14.1);
    this.planterWall(5.95, 12.6, 17.2);
    // 리서치·전략팀
    this.tiles(6.2, 12.5, 10.6, 17.4, 0xd8e2e1, 0xc5d2d1);
    this.hangingSign('리서치 · 전략팀', 'Research', 8.4, 12.35);
    this.bench(6.4, 13.3, 2, names, { dual: true, screen: 0x93b3b0, tone: 'ash', kind: 'chart' });
    this.woodBox(2.6, 1.8, 0.35, 'walnut', 8.4, 0.9, 17.0);
    this.sphere(0.17, 0x3e7bd6, 9.4, 2.12, 16.95);
    this.pendant(8.4, 14.1);
    // 회의실 A
    this.tiles(11.0, 12.6, 16.6, 18.6, 0xcfd8d2, 0xbec9c2);
    this.glassRoom(11.0, 12.6, 16.6, 18.6, { side: 'n', at: 13.8 });
    this.meetingSign = {
      busy: this.textPlane('회의실 A · 사용 중', null, 1.6, 0.26, 0x2d64c8, 0xffffff, 15.3, 2.2, 12.57),
      free: this.textPlane('회의실 A · 비어 있음', null, 1.6, 0.26, 0x5b665f, 0xffffff, 15.3, 2.2, 12.57),
    };
    this.box(3.2, 1.8, 0.06, 0x1e2320, 13.8, 1.4, 18.5);
    const tv = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.6), this.screenMat(null, 0xa9c7e3));
    tv.position.set(13.8, 1.4, 18.46);
    tv.rotation.y = Math.PI;
    this.scene.add(tv);
    const mt = this.cyl(2.0, 2.0, 0.07, 0xb89b74, 13.8, 0.76, 15.6);
    mt.material = this.wood('oak');
    mt.scale.z = 0.43;
    this.cyl(0.15, 0.25, 0.72, 0x5e4a34, 13.8, 0.37, 15.6, undefined, 12);
    for (const s of MEETING_SEATS) this.chair(s.x, s.z, s.face);
    this.tallPlant(16.1, 18.1);
    // 운영지원
    this.tiles(16.9, 12.5, 23.0, 17.4, 0xe0e1d6, 0xcdcfc0);
    this.hangingSign('운영지원', 'Ops', 19.9, 12.35);
    this.bench(17.8, 13.3, 2, names, { screen: 0xb5b99a, tone: 'ash', kind: 'code' });
    this.box(0.9, 0.7, 0.6, 0xe9e7e1, 22.4, 0.35, 16.6);
    for (let lk = 0; lk < 6; lk++) this.box(0.5, 1.8, 0.45, 0xb5bec2, 17.4 + lk * 0.52, 0.9, 17.05);
    this.box(1.0, 0.5, 0.5, 0xc8b590, 22.4, 0.25, 15.6);
    this.pendant(19.9, 14.1);
    // 파견 라운지 (빌려 온 친구 계정, 8장)
    this.tiles(23.4, 12.5, 26.5, 17.4, 0xe6e0ee, 0xd6cee2);
    this.hangingSign('파견 라운지', '친구 계정', 24.95, 12.35);
    this.bench(23.95, 13.6, 1, names, { screen: 0xb9a9d4, tone: 'walnut', kind: 'code' });
    for (const [i, g] of GUEST_SEATS.entries()) {
      const z = g.face > 0 ? 13.95 : 15.25;
      this.box(0.24, 0.05, 0.14, 0x22262a, 25.55, 0.8, z);
      const lm = new THREE.MeshStandardMaterial({ color: 0x8e9496, emissive: 0x000000, emissiveIntensity: 1.2 });
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.02), lm);
      led.position.set(25.61, 0.83, z + 0.071 * (g.face > 0 ? -1 : 1));
      this.scene.add(led);
      this.docks[i] = lm;
    }
    this.box(0.9, 0.42, 0.45, 0xc9bfd9, 24.0, 0.21, 16.9);
    this.tallPlant(26.1, 17.0);
    this.planterWall(26.65, 12.6, 17.2);
    // 탕비실
    this.tiles(26.9, 12.5, 29.6, 18.9, 0xe4e1db, 0xd3cfc7, 0.5);
    this.box(2.4, 0.92, 0.65, 0xe9e5dd, 28.3, 0.46, 18.55);
    this.box(0.85, 1.9, 0.7, 0xd9d6d0, 29.2, 0.95, 17.6, undefined, { metalness: 0.3, roughness: 0.4 });
    this.box(0.85, 1.8, 0.75, 0x2f5d8a, 29.2, 0.9, 16.4);
    this.box(0.32, 1.05, 0.32, 0xf2eee6, 29.2, 0.52, 14.9);
    this.cyl(0.5, 0.5, 0.04, 0xf4f0e8, 27.9, 0.74, 14.2).material = this.wood('oak');
    this.chair(27.9, 13.45, 1, 0xc8b590);
    this.chair(27.9, 14.95, -1, 0xc8b590);
    this.mug(27.75, 14.1, 0xffffff, 0.4);
    // Git 고양이와 배달 로봇
    const cat = new THREE.Group();
    const o = 0xe8913a;
    this.box(0.5, 0.24, 0.24, o, 0, 0.26, 0, cat);
    this.sphere(0.14, o, 0.3, 0.38, 0, cat);
    for (const [x, z] of [[0.18, 0.08], [0.18, -0.08], [-0.18, 0.08], [-0.18, -0.08]] as const) this.box(0.06, 0.16, 0.06, o, x, 0.08, z, cat);
    this.box(0.05, 0.05, 0.32, o, -0.33, 0.42, 0, cat).rotation.z = 0.9;
    this.scene.add(cat);
    this.cat = cat;
    this.catLabel = this.label('git-cat');
    this.catLabel.hidden = true;
    const robot = new THREE.Group();
    this.box(0.6, 0.45, 0.5, 0xfafaf8, 0, 0.32, 0, robot);
    this.box(0.42, 0.18, 0.04, 0x262b28, 0, 0.45, 0.26, robot);
    this.scene.add(robot);
    this.robot = robot;
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
