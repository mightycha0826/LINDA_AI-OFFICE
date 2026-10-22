// 3D 직원 인형 (13장 3D 캐릭터, 코드 임시본). 외모 표(characters.ts)를 three.js 도형으로 만든다.
// 좌표는 자리 기준: 바닥 = 0, 의자 좌석 윗면 = 0.485, 캐릭터는 +z(책상 쪽)를 본다. 책상 윗면은 0.81, 책상 앞 모서리는 z 0.3.
// 머리카락은 가닥(가늘어지는 띠)과 껍데기(구·원기둥 조각)로 만들고, 같은 재질끼리 하나로 합쳐 그리기 횟수를 줄인다.
// 얼굴(눈·눈썹·입·볼)은 캔버스에 그려 머리 구에 입힌다. u = 0.25가 정면, 캔버스 오른쪽이 캐릭터의 왼쪽(+x).
import * as THREE from 'three';
import { mergeBufferGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { shade, type Look } from './characters.ts';
import { buildSeojin } from './seojin.ts';
import { buildHand, type Hand } from './hands.ts';

const V3 = THREE.Vector3;
type V3 = THREE.Vector3;
const DEG = Math.PI / 180;
// 색은 숫자로 적고 캔버스에 그릴 때만 문자열로 바꾼다 (scene.ts와 같은 방식, 17장 3D 예외)
const css = (n: number) => '#' + n.toString(16).padStart(6, '0');
const rgba = (n: number, a: number) => `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;

/** 머리 중심 높이·반지름 (머리 그룹은 세로 1.04배) */
const HEAD_Y = 1.34;
const HEAD_R = 0.2;
const HEAD_SCALE = new V3(0.97, 1.04, 0.97);
/** 몸통(재킷) 옆모습: [반지름, 허리에서 높이] */
const PROFILE: readonly [number, number][] = [
  [0.135, 0],
  [0.14, 0.05],
  [0.15, 0.13],
  [0.165, 0.22],
  [0.172, 0.29],
  [0.168, 0.33],
  [0.15, 0.37],
  [0.11, 0.41],
  [0.06, 0.44],
  [0.045, 0.46],
];
const TORSO_Y = 0.64;
const TORSO_Z = -0.02;
const TORSO_SZ = 0.66;

export interface Figure {
  /** 몸 전체 (scene.ts가 자리로 옮기고 돌린다) */
  root: THREE.Group;
  /** 고개 돌리기 */
  head: THREE.Group;
  /** 대기 중 몸 흔들기 (상체) */
  torso: THREE.Object3D;
  /** 타이핑·손짓 (팔꿈치 축, rotation.x만 바꾼다) */
  forearms: THREE.Group[];
  hands: Hand[];
  /** 정수리 높이 (이름표 기준) */
  top: number;
}

/** 재질·얼굴 그림 저장소. 같은 색은 한 재질을 같이 쓴다 */
export class FigureKit {
  private readonly toons = new Map<number, THREE.MeshToonMaterial>();
  private readonly faces = new Map<string, THREE.MeshToonMaterial>();
  private readonly gradient: THREE.DataTexture;
  private night = false;

  constructor() {
    // 애니 느낌 3단 명암
    const d = new Uint8Array([128, 128, 128, 255, 186, 186, 186, 255, 228, 228, 228, 255]);
    this.gradient = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat);
    this.gradient.minFilter = THREE.NearestFilter;
    this.gradient.magFilter = THREE.NearestFilter;
    this.gradient.generateMipmaps = false;
    this.gradient.needsUpdate = true;
  }

  toon(color: number): THREE.MeshToonMaterial {
    let m = this.toons.get(color);
    if (!m) {
      // 사진의 색(sRGB)이 화면에 그대로 나오게 선형으로 바꿔 넣는다
      m = new THREE.MeshToonMaterial({ color: new THREE.Color(color).convertSRGBToLinear(), gradientMap: this.gradient, side: THREE.DoubleSide });
      this.toons.set(color, m);
    }
    return m;
  }

  face(look: Look): THREE.MeshToonMaterial {
    const key = [look.skin, look.eyes, look.hairShade, look.smile, look.mole].join(':');
    let m = this.faces.get(key);
    if (!m) {
      const tex = new THREE.CanvasTexture(paintFace(look));
      tex.encoding = THREE.sRGBEncoding;
      tex.anisotropy = 4;
      // 얼굴은 그늘에서도 읽히게 조금 스스로 밝힌다(밤에는 줄임)
      m = new THREE.MeshToonMaterial({ map: tex, gradientMap: this.gradient, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: this.night ? 0.05 : 0.1 });
      this.faces.set(key, m);
    }
    return m;
  }

  setNight(on: boolean): void {
    this.night = on;
    for (const m of this.faces.values()) m.emissiveIntensity = on ? 0.05 : 0.1;
  }

  dispose(): void {
    for (const m of this.toons.values()) m.dispose();
    for (const m of this.faces.values()) {
      m.map?.dispose();
      m.dispose();
    }
    this.gradient.dispose();
  }
}

// ---------- 모양 도구 ----------

/** 머리 중심 기준 구면 좌표: theta = 정수리에서 내려온 각, lon = 정면에서 +x(캐릭터 왼쪽)로 돈 각 (도) */
function sp(theta: number, lon: number, r: number): V3 {
  const t = theta * DEG;
  const l = lon * DEG;
  return new V3(r * Math.sin(t) * Math.sin(l), r * Math.cos(t), r * Math.sin(t) * Math.cos(l));
}

/** 정해진 값으로 섞는 가짜 난수 (매번 같은 머리 모양) */
function noise(i: number, k = 1): number {
  const s = Math.sin(i * 91.7 + k * 12.3) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * 머리카락 한 가닥: 점들을 지나며 끝으로 갈수록 가늘어지는 띠. 가운데를 살짝 바깥으로 접어 두께감을 낸다.
 * 바깥 방향은 머리 중심보다 위에서는 구, 아래에서는 세로축 기준.
 */
function strand(pts: V3[], w0: number, w1: number, segs = 10): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const t = new V3();
  const n = new V3();
  const b = new V3();
  for (let i = 0; i <= segs; i++) {
    const s = i / segs;
    const p = curve.getPointAt(s);
    curve.getTangentAt(s, t);
    n.set(p.x, Math.max(p.y, 0), p.z);
    if (n.lengthSq() < 1e-8) n.set(0, 0, 1);
    n.normalize();
    b.crossVectors(t, n);
    if (b.lengthSq() < 1e-8) b.set(1, 0, 0);
    b.normalize();
    const w = (w0 + (w1 - w0) * Math.pow(s, 0.85)) / 2;
    const lift = w * 0.35;
    pos.push(p.x - b.x * w, p.y - b.y * w, p.z - b.z * w, p.x + n.x * lift, p.y + n.y * lift, p.z + n.z * lift, p.x + b.x * w, p.y + b.y * w, p.z + b.z * w);
    uv.push(0, s, 0.5, s, 1, s);
    if (i < segs) {
      const a = i * 3;
      idx.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 끝으로 갈수록 가늘어지는 관 (묶은 머리 꼬리) */
function tube(pts: V3[], r0: number, r1: number, segs = 18, radial = 10): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const frames = curve.computeFrenetFrames(segs, false);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const s = i / segs;
    const p = curve.getPointAt(s);
    const N = frames.normals[i]!;
    const B = frames.binormals[i]!;
    const r = r0 + (r1 - r0) * Math.pow(s, 1.3);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      pos.push(p.x + (N.x * Math.cos(a) + B.x * Math.sin(a)) * r, p.y + (N.y * Math.cos(a) + B.y * Math.sin(a)) * r, p.z + (N.z * Math.cos(a) + B.z * Math.sin(a)) * r);
      uv.push(j / radial, s);
      if (i < segs && j < radial) {
        const a0 = i * (radial + 1) + j;
        const a1 = a0 + radial + 1;
        idx.push(a0, a1, a0 + 1, a0 + 1, a1, a1 + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** a에서 b까지 원기둥 (팔·다리·안경테) */
function limb(a: V3, b: V3, r0: number, r1: number, radial = 12): THREE.BufferGeometry {
  const d = new V3().subVectors(b, a);
  const g = new THREE.CylinderGeometry(r1, r0, d.length(), radial, 1, false);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), d.clone().normalize()));
  const m = new V3().addVectors(a, b).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  return g;
}

function ball(r: number, at: V3, scale = new V3(1, 1, 1), seg = 16): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, seg, Math.max(8, seg * 0.75));
  g.scale(scale.x, scale.y, scale.z);
  g.translate(at.x, at.y, at.z);
  return g;
}

/** 재킷 몸통 반지름 (허리에서 높이 h) */
function torsoR(h: number): number {
  for (let i = 1; i < PROFILE.length; i++) {
    const [r1, h1] = PROFILE[i]!;
    const [r0, h0] = PROFILE[i - 1]!;
    if (h <= h1) return r0 + ((r1 - r0) * (h - h0)) / (h1 - h0);
  }
  return PROFILE[PROFILE.length - 1]![0];
}

function onTorso(h: number, a: number, off: number): V3 {
  const r = torsoR(h);
  return new V3((r + off) * Math.sin(a), TORSO_Y + h, TORSO_Z + (r * TORSO_SZ + off) * Math.cos(a));
}

/** 몸통 표면을 따라 붙인 조각 (셔츠 V·옷깃·넥타이). span(h) = [시작 각, 끝 각] */
function patch(h0: number, h1: number, span: (h: number) => [number, number], off: number, rows = 10, cols = 6): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= rows; i++) {
    const h = h0 + ((h1 - h0) * i) / rows;
    const [a0, a1] = span(h);
    for (let j = 0; j <= cols; j++) {
      const p = onTorso(h, a0 + ((a1 - a0) * j) / cols, off);
      pos.push(p.x, p.y, p.z);
      uv.push(j / cols, i / rows);
      if (i < rows && j < cols) {
        const a = i * (cols + 1) + j;
        idx.push(a, a + 1, a + cols + 1, a + 1, a + cols + 2, a + cols + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 같은 재질 조각을 모아 하나로 합친다 */
class Batch {
  private readonly items = new Map<THREE.Material, THREE.BufferGeometry[]>();
  add(mat: THREE.Material, ...geos: THREE.BufferGeometry[]): void {
    const list = this.items.get(mat) ?? [];
    list.push(...geos);
    this.items.set(mat, list);
  }
  into(parent: THREE.Object3D): void {
    for (const [mat, list] of this.items) {
      const merged = mergeBufferGeometries(list.map((g) => strip3(g)));
      const geos = merged ? [merged] : list;
      for (const g of geos) {
        const m = new THREE.Mesh(g, mat);
        m.castShadow = true;
        parent.add(m);
      }
      if (merged) list.forEach((g) => g.dispose());
    }
    this.items.clear();
  }
}

/** 합칠 수 있게 위치·법선·uv만 남긴다 (원기둥 뚜껑 묶음 정보 등은 버림) */
function strip3(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  g.clearGroups();
  return g;
}

// ---------- 머리카락 ----------

function hair(look: Look, main: THREE.BufferGeometry[], dark: THREE.BufferGeometry[]): void {
  const S = look.side;
  const style = look.style;
  const short = style === 'bob' || style === 'layered' || style === 'braid-bob';
  // 정수리 덮개와 뒤통수 껍데기 (뒤통수는 앞머리 옆에서 시작해 뒤로 돈다). 이마는 앞머리 가닥만 덮는다
  main.push(new THREE.SphereGeometry(0.214, 40, 12, 0, Math.PI * 2, 0, 52 * DEG));
  // 뒤통수는 얼굴 옆에서 짧고 뒤로 갈수록 목덜미까지 내려온다 [옆, 뒤]
  const [side, back] = ({ long: [108, 130], wavy: [110, 130], bob: [120, 124], layered: [116, 120], ponytail: [110, 132], 'braid-bob': [118, 122] } as const)[style];
  const edge = (lon: number) => side + (back - side) * Math.min(1, Math.max(0, (Math.abs(lon) - 58) / 92));
  main.push(trim(new THREE.SphereGeometry(0.218, 40, 20, Math.PI - 0.55, Math.PI + 1.1, 50 * DEG, (back - 50) * DEG), edge));
  dark.push(trim(new THREE.SphereGeometry(0.21, 32, 14, Math.PI - 0.5, Math.PI + 1.0, 70 * DEG, (back - 66) * DEG), edge));

  bangs(look, main);

  // 얼굴 옆 머리 (땋은 머리 쪽은 빼고)
  const lockEnd = { long: -0.46, wavy: -0.44, bob: -0.21, layered: -0.17, ponytail: -0.3, 'braid-bob': -0.2 }[style];
  for (const s2 of [-1, 1] as const) {
    if (style === 'braid-bob' && s2 === S) continue;
    const wave = style === 'wavy' ? 0.02 : 0;
    const pts = [sp(46, s2 * 68, 0.219), sp(78, s2 * 79, 0.226), sp(100, s2 * 81, 0.229), new V3(s2 * (0.212 + wave), (lockEnd - 0.04) / 2, 0.07), new V3(s2 * (0.2 - wave), lockEnd, 0.078)];
    main.push(strand(pts, style === 'ponytail' ? 0.05 : 0.09, 0.01, 12));
    if (!short) main.push(strand([sp(52, s2 * 82, 0.22), sp(96, s2 * 90, 0.229), new V3(s2 * 0.222, -0.15, 0.03), new V3(s2 * 0.215, lockEnd + 0.06, 0.045)], 0.08, 0.012, 12));
  }

  if (style === 'long' || style === 'wavy') longBack(look, main, dark);
  else if (style === 'ponytail') ponytail(look, main);
  else shortBack(look, main, dark);

  // 반묶음: 뒤쪽 옆에 작게 모은 머리
  if (look.ribbon && (style === 'long' || style === 'wavy')) main.push(ball(0.045, sp(94, S * 128, 0.222), new V3(1, 0.8, 0.8), 12));
}

/** 구 조각의 아래 끝을 경도마다 다르게 자른다 (edge(lon) = 그 경도에서 내려올 수 있는 가장 아래 각, 도) */
function trim(g: THREE.SphereGeometry, edge: (lon: number) => number): THREE.SphereGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new V3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const r = v.length();
    const theta = Math.acos(Math.max(-1, Math.min(1, v.y / r))) / DEG;
    const lon = Math.atan2(v.x, v.z) / DEG;
    const max = edge(lon);
    if (theta > max) {
      const q = sp(max, lon, r);
      p.setXYZ(i, q.x, q.y, q.z);
    }
  }
  g.computeVertexNormals();
  return g;
}

function bangs(look: Look, out: THREE.BufferGeometry[]): void {
  const S = look.side;
  type B = { lr: number; lt: number; tt: number; w0: number; w1: number };
  const list: B[] = [];
  switch (look.bangs) {
    case 'blunt':
      for (let i = 0; i <= 10; i++) {
        const lr = -60 + i * 12;
        list.push({ lr, lt: lr * 1.05, tt: Math.abs(lr) > 45 ? 97 : 85 + noise(i) * 2, w0: 0.1, w1: 0.05 });
      }
      break;
    case 'swept':
      for (let i = 0; i <= 8; i++) {
        const lr = -56 + i * 14;
        list.push({ lr, lt: lr + 16 * S, tt: 83 + ((S > 0 ? 8 - i : i) / 8) * 12, w0: 0.1, w1: 0.008 });
      }
      break;
    case 'curtain':
      for (let i = 0; i <= 12; i++) {
        const lr = -58 + i * 9.67;
        list.push({ lr, lt: lr + Math.sign(lr || 1) * 12, tt: 82 + (Math.abs(lr) / 58) * 18 + noise(i, 9) * 3, w0: 0.1, w1: 0.008 });
      }
      break;
    case 'over-eye':
      for (let i = 0; i <= 8; i++) {
        const lr = -56 + i * 14;
        list.push({ lr, lt: lr + 10 * -S, tt: lr * -S > 0 ? 101 : 86, w0: 0.1, w1: 0.012 });
      }
      break;
    case 'wispy':
      for (let i = 0; i <= 14; i++) {
        const lr = -60 + i * 8.6;
        list.push({ lr, lt: lr + (noise(i, 2) - 0.5) * 12, tt: 84 + noise(i, 3) * 15, w0: 0.065, w1: 0.004 });
      }
      break;
  }
  for (const b of list) {
    const pts = [sp(20, b.lr * 0.5, 0.216), sp(52, (b.lr + b.lt) / 2, 0.223), sp((52 + b.tt) / 2 + 6, b.lt * 0.98, 0.227), sp(b.tt, b.lt, 0.229)];
    out.push(strand(pts, b.w0, b.w1, 10));
  }
}

/** 긴 머리·웨이브: 뒤로 내려오는 머리 뭉치 + 가닥 + 어깨 앞으로 내려온 가닥 */
function longBack(look: Look, main: THREE.BufferGeometry[], dark: THREE.BufferGeometry[]): void {
  const wavy = look.style === 'wavy';
  const H = 0.24 + 0.32 * look.length;
  const bottom = -0.05 - H;
  // 뒤로 내려오는 머리 뭉치: 바깥은 머리색, 안쪽(얼굴 옆에서 보이는 면)은 그늘색
  for (const [r0, r1, list] of [
    [0.212, wavy ? 0.275 : 0.25, main],
    [0.204, wavy ? 0.265 : 0.24, dark],
  ] as const) {
    const curtain = new THREE.CylinderGeometry(r0, r1, H, 32, 10, true, Math.PI - 1.45, 2.9);
    curtain.translate(0, -0.05 - H / 2, -0.02);
    if (wavy) bend(curtain, 0.016);
    list.push(curtain);
  }
  const n = wavy ? 17 : 13;
  for (let i = 0; i < n; i++) {
    const lon = 100 + (i * 160) / (n - 1);
    const end = bottom + (noise(i, 4) - 0.3) * 0.06;
    const rb = wavy ? 0.272 : 0.25;
    const at = (y: number, r: number, dl = 0) => {
      const l = (lon + dl) * DEG;
      return new V3(r * Math.sin(l), y, -0.02 + r * Math.cos(l));
    };
    const w = wavy ? 7 : 0;
    const pts = [sp(96, lon, 0.224), sp(118, lon, 0.232), at(-0.24, 0.236, w), at((-0.24 + end) / 2, (0.24 + rb) / 2, -w), at(end, rb, w)];
    main.push(strand(pts, 0.125, 0.014, 14));
  }
  // 어깨 앞으로 내려온 가닥 (사진처럼 가슴 앞까지)
  if (look.length >= 0.7) {
    const yEnd = -0.25 - 0.35 * look.length;
    for (const s2 of [-1, 1] as const) {
      for (let k = 0; k < 2; k++) {
        const dx = k * 0.025;
        const w = wavy ? 0.02 * (k ? -1 : 1) : 0;
        const pts = [sp(98, s2 * (88 + k * 8), 0.226), new V3(s2 * (0.218 - dx), -0.17, 0.02 + k * 0.01), new V3(s2 * (0.212 - dx + w), -0.34, 0.085), new V3(s2 * (0.195 - dx - w), (yEnd - 0.34) / 2 - 0.05, 0.11), new V3(s2 * (0.18 - dx), yEnd, 0.112)];
        main.push(strand(pts, 0.085, 0.01, 14));
      }
    }
  }
}

/** 웨이브: 높이를 따라 반지름을 물결치게 한다 */
function bend(g: THREE.BufferGeometry, amp: number): void {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i) + 0.02;
    const a = Math.atan2(x, z);
    const deep = Math.min(1, Math.max(0, (-y - 0.1) / 0.3));
    const r = Math.hypot(x, z) + amp * Math.sin(y * 30 + a * 5) * deep;
    p.setXYZ(i, r * Math.sin(a), y, r * Math.cos(a) - 0.02);
  }
  g.computeVertexNormals();
}

/** 단발·레이어드·땋은 단발: 턱선까지 내려오는 치마 모양 + 끝 가닥 */
function shortBack(look: Look, main: THREE.BufferGeometry[], dark: THREE.BufferGeometry[]): void {
  const layered = look.style === 'layered';
  const hem = layered ? -0.16 : -0.21;
  const top = -0.07;
  const open = 52 * DEG;
  const skirt = new THREE.CylinderGeometry(0.205, layered ? 0.235 : 0.226, top - hem, 32, 2, true, open, Math.PI * 2 - open * 2);
  skirt.translate(0, (top + hem) / 2, 0);
  main.push(skirt);
  const inner = new THREE.CylinderGeometry(0.19, 0.205, top - hem, 28, 1, true, open, Math.PI * 2 - open * 2);
  inner.translate(0, (top + hem) / 2, 0);
  dark.push(inner);
  const n = layered ? 19 : 15;
  for (let i = 0; i < n; i++) {
    const lon = 58 + (i * 244) / (n - 1);
    const len = layered ? 0.03 + noise(i, 5) * 0.09 : 0.03 + noise(i, 6) * 0.02;
    const end = hem - len;
    const l = lon * DEG;
    // 단발은 끝이 안으로, 레이어드는 밖으로 살짝 뻗친다
    const rEnd = layered ? 0.25 + noise(i, 7) * 0.02 : 0.212;
    const pts = [sp(104, lon, 0.224), new V3(0.228 * Math.sin(l), hem + 0.05, 0.228 * Math.cos(l)), new V3(rEnd * Math.sin(l + (noise(i, 8) - 0.5) * 0.1), end, rEnd * Math.cos(l))];
    main.push(strand(pts, layered ? 0.07 : 0.1, layered ? 0.004 : 0.03, 8));
  }
  if (look.style === 'braid-bob') braid(look, main);
}

/** 옆머리를 땋아 뒤로 (설아인) */
function braid(look: Look, main: THREE.BufferGeometry[]): void {
  const S = look.side;
  const curve = new THREE.CatmullRomCurve3([sp(62, S * 56, 0.226), sp(80, S * 82, 0.232), sp(92, S * 108, 0.233), sp(101, S * 136, 0.229)]);
  const n = 11;
  const t = new V3();
  for (let i = 0; i < n; i++) {
    const s = i / (n - 1);
    const p = curve.getPointAt(s);
    curve.getTangentAt(s, t);
    const side = new V3().crossVectors(t, p.clone().normalize()).normalize().multiplyScalar((i % 2 ? 1 : -1) * 0.008);
    main.push(ball(0.027 - s * 0.006, p.add(side), new V3(1.15, 0.85, 0.85), 10));
  }
}

/** 낮게 묶어 어깨 앞으로 넘긴 머리 (서예린) */
function ponytail(look: Look, main: THREE.BufferGeometry[]): void {
  const S = look.side;
  const tie = new V3(S * 0.06, -0.15, -0.15);
  const pts = [tie, new V3(S * 0.14, -0.22, -0.12), new V3(S * 0.195, -0.25, -0.04), new V3(S * 0.212, -0.3, 0.05), new V3(S * 0.2, -0.45, 0.1), new V3(S * 0.18, -0.62, 0.115), new V3(S * 0.165, -0.74, 0.105)];
  main.push(tube(pts, 0.042, 0.008, 22, 10));
  for (let k = 0; k < 3; k++) {
    const o = (k - 1) * 0.018;
    main.push(strand(pts.slice(1).map((p, i) => p.clone().add(new V3(o, 0, 0.03 + (i > 1 ? 0.012 : 0)))), 0.05, 0.004, 14));
  }
  // 뒷머리가 묶는 곳으로 모이는 가닥
  for (let i = 0; i < 7; i++) {
    const from = sp(70, 110 + i * 23, 0.222);
    const mid = from.clone().lerp(tie, 0.5).setLength(0.224);
    main.push(strand([from, mid, tie.clone().multiplyScalar(1.05)], 0.07, 0.02, 8));
  }
}

// ---------- 소품 ----------

/** 리본: 매듭 + 고리 두 개 (+ 꼬리) */
function bow(color: number, tails: boolean, kit: FigureKit): THREE.Group {
  const g = new THREE.Group();
  const b = new Batch();
  const mat = kit.toon(color);
  b.add(mat, ball(0.016, new V3(0, 0, 0.004), new V3(1, 1, 0.8), 10));
  for (const s of [-1, 1] as const) {
    const loop = new THREE.ConeGeometry(0.032, 0.07, 8, 1, false);
    loop.scale(1, 1, 0.45);
    loop.rotateZ(s * -Math.PI / 2 + Math.PI);
    loop.rotateZ(s * 0.18);
    loop.translate(s * 0.036, 0.004, 0);
    b.add(mat, loop);
    const len = tails ? 0.17 : 0.07;
    const tail = new THREE.BoxGeometry(0.022, len, 0.004);
    tail.translate(0, -len / 2, 0);
    tail.rotateZ(s * 0.22);
    tail.translate(s * 0.006, -0.008, -0.002);
    b.add(mat, tail);
  }
  b.into(g);
  return g;
}

/** 머리 표면 위 점에 붙이고 바깥을 보게 한다 */
function stick(obj: THREE.Object3D, at: V3): void {
  obj.position.copy(at);
  obj.lookAt(at.clone().multiplyScalar(2));
}

function glasses(kit: FigureKit): THREE.Group {
  const g = new THREE.Group();
  const b = new Batch();
  const mat = kit.toon(0x1a1a1e);
  const r = 0.0035;
  for (const s of [-1, 1] as const) {
    const cx = s * 0.072;
    const cz = 0.216 - Math.abs(cx) * 0.25;
    const w = 0.043;
    const h = 0.027;
    const c = (dx: number, dy: number) => new V3(cx + dx, -0.022 + dy, cz - s * dx * 0.35);
    b.add(mat, limb(c(-w, h), c(w, h), r, r, 6), limb(c(-w, -h), c(w, -h), r, r, 6), limb(c(-w, -h), c(-w, h), r, r, 6), limb(c(w, -h), c(w, h), r, r, 6));
    b.add(mat, limb(c(s * w, h * 0.6), new V3(s * 0.205, -0.01, 0.0), r, r, 6));
  }
  b.add(mat, limb(new V3(-0.029, -0.012, 0.212), new V3(0.029, -0.012, 0.212), r, r, 6));
  b.into(g);
  return g;
}

// ---------- 얼굴 ----------

/** 동그란 구를 애니 얼굴형으로: 눈 아래부터 턱으로 갈수록 좁아지고 턱끝이 조금 앞으로 나온다 */
function faceShape(g: THREE.SphereGeometry): THREE.SphereGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y >= 0.0) continue;
    const t = Math.min(1, -y / HEAD_R);
    const k = Math.pow(t, 1.5);
    const z = p.getZ(i);
    p.setX(i, p.getX(i) * (1 - 0.34 * k));
    // 앞은 턱끝이 조금 나오고, 뒤는 목덜미로 좁아진다
    p.setZ(i, z > 0 ? z * (1 - 0.14 * k) + 0.025 * t * t : z * (1 - 0.34 * k));
    p.setY(i, y * (1 + 0.06 * k));
  }
  g.computeVertexNormals();
  return g;
}

function paintFace(look: Look): HTMLCanvasElement {
  const W = 1024;
  const H = 512;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d')!;
  c.fillStyle = css(look.skin);
  c.fillRect(0, 0, W, H);
  const cx = W * 0.25;
  // 볼
  for (const s of [-1, 1]) {
    const g = c.createRadialGradient(cx + s * 70, 314, 2, cx + s * 70, 314, 30);
    g.addColorStop(0, rgba(0xee8080, 0.35));
    g.addColorStop(1, rgba(0xee8080, 0));
    c.fillStyle = g;
    c.beginPath();
    c.ellipse(cx + s * 70, 314, 32, 16, 0, 0, Math.PI * 2);
    c.fill();
  }
  // 눈썹
  c.strokeStyle = css(shade(look.hairShade, 0.1));
  c.lineCap = 'round';
  c.lineWidth = 4;
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(cx + s * 30, 220);
    c.quadraticCurveTo(cx + s * 60, 207, cx + s * 92, 218);
    c.stroke();
  }
  for (const s of [-1, 1] as const) eye(c, cx + s * 60, 274, s, look);
  // 코 (작은 그늘)
  c.strokeStyle = css(shade(look.skin, -0.22));
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(cx + 2, 306);
  c.lineTo(cx - 1, 315);
  c.stroke();
  // 입
  const my = 338;
  if (look.smile) {
    c.fillStyle = css(0xe48f95);
    c.beginPath();
    c.moveTo(cx - 15, my);
    c.quadraticCurveTo(cx, my + 14, cx + 15, my);
    c.quadraticCurveTo(cx, my + 5, cx - 15, my);
    c.fill();
    c.strokeStyle = css(0xb4646a);
    c.lineWidth = 2.5;
    c.beginPath();
    c.moveTo(cx - 16, my - 1);
    c.quadraticCurveTo(cx, my + 8, cx + 16, my - 1);
    c.stroke();
  } else {
    c.fillStyle = css(0xe99ea2);
    c.beginPath();
    c.ellipse(cx, my + 3, 10, 4, 0, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = css(0xb8727a);
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(cx - 10, my + 1);
    c.quadraticCurveTo(cx, my + 4, cx + 10, my + 1);
    c.stroke();
  }
  if (look.mole) {
    c.fillStyle = css(0x5a3a32);
    c.beginPath();
    c.arc(cx - 78, 306, 2.8, 0, Math.PI * 2);
    c.fill();
  }
  return cv;
}

/** 애니 눈 하나. dir = 바깥 눈꼬리 방향 (+1 = 캔버스 오른쪽) */
function eye(c: CanvasRenderingContext2D, ex: number, ey: number, dir: 1 | -1, look: Look): void {
  const w = 68;
  const h = 60;
  const inner = { x: ex - dir * w * 0.5, y: ey + 6 };
  const outer = { x: ex + dir * w * 0.5, y: ey - 4 };
  const lower = look.smile ? 0.34 : 0.46;
  const shape = () => {
    c.beginPath();
    c.moveTo(inner.x, inner.y);
    c.bezierCurveTo(ex - dir * w * 0.28, ey - h * 0.62, ex + dir * w * 0.3, ey - h * 0.62, outer.x, outer.y);
    c.bezierCurveTo(ex + dir * w * 0.25, ey + h * lower, ex - dir * w * 0.22, ey + h * lower, inner.x, inner.y);
  };
  c.save();
  shape();
  c.clip();
  c.fillStyle = css(0xfbf7f4);
  c.fillRect(ex - w, ey - h, w * 2, h * 2);
  const g = c.createLinearGradient(0, ey - 28, 0, ey + 30);
  g.addColorStop(0, css(shade(look.eyes, -0.6)));
  g.addColorStop(0.45, css(look.eyes));
  g.addColorStop(1, css(shade(look.eyes, 0.42)));
  c.fillStyle = g;
  c.beginPath();
  c.ellipse(ex + dir * 1, ey + 3, 21, 28, 0, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = css(shade(look.eyes, -0.65));
  c.lineWidth = 2.5;
  c.stroke();
  c.fillStyle = css(shade(look.eyes, -0.78));
  c.beginPath();
  c.ellipse(ex + dir * 1, ey + 5, 8.5, 12.5, 0, 0, Math.PI * 2);
  c.fill();
  // 위 눈꺼풀 그늘
  c.fillStyle = rgba(0x462828, 0.28);
  c.fillRect(ex - w, ey - h, w * 2, h * 0.44);
  c.fillStyle = css(0xffffff);
  c.beginPath();
  c.arc(ex - dir * 7, ey - 7, 7, 0, Math.PI * 2);
  c.arc(ex + dir * 9, ey + 14, 3.2, 0, Math.PI * 2);
  c.fill();
  c.restore();
  // 위 속눈썹 (바깥 눈꼬리가 굵게 올라간다)
  c.strokeStyle = css(0x2a1e1e);
  c.lineCap = 'round';
  c.lineWidth = 6;
  c.beginPath();
  c.moveTo(inner.x + dir * 3, inner.y - 2);
  c.bezierCurveTo(ex - dir * w * 0.28, ey - h * 0.62, ex + dir * w * 0.3, ey - h * 0.62, outer.x, outer.y);
  c.stroke();
  c.fillStyle = css(0x2a1e1e);
  c.beginPath();
  c.moveTo(outer.x - dir * 8, outer.y - 6);
  c.lineTo(outer.x + dir * 11, outer.y - 11);
  c.lineTo(outer.x - dir * 1, outer.y + 4);
  c.fill();
  // 아래 속눈썹 (바깥쪽 절반만 옅게)
  c.strokeStyle = rgba(0x5a3737, 0.55);
  c.lineWidth = 1.6;
  c.beginPath();
  c.moveTo(outer.x - dir * 2, outer.y + 3);
  c.quadraticCurveTo(ex + dir * w * 0.2, ey + h * lower * 0.9, ex, ey + h * lower * 0.85);
  c.stroke();
}

// ---------- 인형 ----------

export function buildFigure(look: Look, kit: FigureKit): Figure {
  if (look.portraitModel === 'seojin') return buildSeojin();
  const root = new THREE.Group();
  const jacket = kit.toon(look.jacket);
  const edge = kit.toon(shade(look.jacket, look.suit ? 0.12 : -0.15));
  const shirt = kit.toon(0xf7f7f9);
  const skin = kit.toon(look.skin);
  const legs = kit.toon(look.suit ? 0x2e2f36 : 0x3d4148);
  const skirtMat = kit.toon(look.suit ? 0x26272d : 0x4a4f57);
  const shoe = kit.toon(0x15161a);

  // 다리·치마 (움직이지 않음)
  const lower = new Batch();
  for (const s of [-1, 1] as const) {
    const x = s * 0.085;
    lower.add(shoe, ball(0.05, new V3(x, 0.04, 0.45), new V3(0.9, 0.7, 1.7), 12));
    lower.add(legs, limb(new V3(x, 0.07, 0.41), new V3(x, 0.56, 0.39), 0.04, 0.05), ball(0.052, new V3(x, 0.56, 0.38), new V3(1, 1, 1), 12));
    lower.add(skirtMat, limb(new V3(x, 0.56, 0.0), new V3(x, 0.565, 0.36), 0.08, 0.066));
  }
  const hips = new THREE.CylinderGeometry(0.17, 0.19, 0.15, 24);
  hips.scale(1, 1, 0.8);
  hips.translate(0, 0.575, -0.01);
  const lap = new THREE.BoxGeometry(0.33, 0.12, 0.34);
  lap.translate(0, 0.575, 0.18);
  lower.add(skirtMat, hips, lap);
  const legGroup = new THREE.Group();
  lower.into(legGroup);
  root.add(legGroup);

  // 상체: 재킷·셔츠·넥타이·어깨·윗팔 (대기 중 함께 흔들린다)
  const upper = new THREE.Group();
  const top = new Batch();
  const torso = new THREE.LatheGeometry(PROFILE.map(([r, h]) => new THREE.Vector2(r, h)), 36);
  torso.scale(1, 1, TORSO_SZ);
  torso.translate(0, TORSO_Y, TORSO_Z);
  const peplum = new THREE.CylinderGeometry(0.137, 0.168, 0.12, 32, 1, true);
  peplum.scale(1, 1, 0.72);
  peplum.translate(0, TORSO_Y - 0.045, TORSO_Z);
  top.add(jacket, torso, peplum);
  const vHalf = (h: number) => 0.55 * Math.pow(Math.max(0, (h - 0.2) / 0.26), 0.9);
  top.add(shirt, patch(0.2, 0.455, (h) => [-vHalf(h), vHalf(h)], 0.003, 12, 8));
  for (const s of [-1, 1] as const) top.add(edge, patch(0.17, 0.43, (h) => (s > 0 ? [vHalf(h), vHalf(h) + 0.17] : [-vHalf(h) - 0.17, -vHalf(h)]), 0.007, 10, 3));
  const collar = new THREE.CylinderGeometry(0.05, 0.058, 0.05, 20, 1, true, 0.42, Math.PI * 2 - 0.84);
  collar.translate(0, TORSO_Y + 0.455, TORSO_Z + 0.004);
  top.add(shirt, collar);
  if (look.tie) {
    const tieMat = kit.toon(0x17181c);
    const half = (h: number) => {
      const w = look.tie === 'wide' ? 0.016 + (0.43 - h) * 0.06 : 0.009;
      const tip = Math.min(1, (h - 0.17) / 0.035);
      return (w * tip) / torsoR(h);
    };
    top.add(tieMat, patch(0.17, 0.43, (h) => [-half(h), half(h)], 0.01, 12, 2));
    top.add(tieMat, patch(0.425, 0.455, () => [-0.22, 0.22], 0.014, 2, 3));
  }
  top.add(skin, limb(new V3(0, TORSO_Y + 0.42, -0.015), new V3(0, HEAD_Y - 0.12, -0.012), 0.043, 0.04));
  for (const s of [-1, 1] as const) {
    const sh = new V3(s * 0.178, TORSO_Y + 0.355, TORSO_Z);
    const el = new V3(s * 0.215, 0.79, 0.09);
    top.add(jacket, ball(0.05, sh.clone().add(new V3(-s * 0.008, 0.005, 0)), new V3(1, 0.85, 1), 14), limb(sh, el, 0.048, 0.043), ball(0.044, el, new V3(1, 1, 1), 12));
  }
  top.into(upper);
  root.add(upper);

  // 아래팔 (타이핑): 팔꿈치 축, 손은 책상 위로
  const forearms: THREE.Group[] = [];
  const hands: Hand[] = [];
  for (const s of [-1, 1] as const) {
    const el = new THREE.Group();
    el.position.set(s * 0.215, 0.79, 0.09);
    el.rotation.y = -s * 0.22;
    const tilt = new THREE.Group();
    const fb = new Batch();
    fb.add(jacket, limb(new V3(0, 0, 0), new V3(0, 0.097, 0.29), 0.043, 0.027));
    fb.add(shirt, limb(new V3(0, 0.097, 0.285), new V3(0, 0.1, 0.31), 0.028, 0.027));
    fb.into(tilt);
    const hand = buildHand(s, skin, kit.toon(0xecd6cf));
    hand.root.position.set(0, 0.1, 0.312);
    tilt.add(hand.root);
    hands.push(hand);
    el.add(tilt);
    root.add(el);
    forearms.push(el);
  }

  // 머리: 얼굴 구 + 귀 + 머리카락 + 소품
  const head = new THREE.Group();
  head.position.set(0, HEAD_Y, -0.01);
  head.scale.copy(HEAD_SCALE);
  const face = new THREE.Mesh(faceShape(new THREE.SphereGeometry(HEAD_R, 48, 32)), kit.face(look));
  face.castShadow = true;
  head.add(face);
  const hb = new Batch();
  for (const s of [-1, 1] as const) hb.add(skin, ball(0.035, new V3(s * 0.196, -0.025, -0.005), new V3(0.45, 0.9, 0.7), 10));
  const main: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];
  hair(look, main, dark);
  hb.add(kit.toon(look.hair), ...main);
  hb.add(kit.toon(look.hairShade), ...dark);
  hb.into(head);
  if (look.glasses) head.add(glasses(kit));
  if (look.ribbon) {
    const b = bow(look.ribbon.color, look.ribbon.tails, kit);
    stick(b, look.style === 'braid-bob' ? sp(103, look.side * 140, 0.232) : sp(94, look.side * 128, 0.262));
    head.add(b);
  }
  if (look.earring) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), kit.toon(0x101014));
    e.position.set(look.side * 0.2, -0.065, 0.0);
    head.add(e);
  }
  root.add(head);

  return { root, head, torso: upper, forearms, hands, top: HEAD_Y + 0.226 * HEAD_SCALE.y };
}

/** 인형이 가진 도형을 버린다 (재질은 FigureKit이 갖고 있다) */
export function disposeFigure(root: THREE.Object3D): void {
  (root.userData.disposeMaterials as (() => void) | undefined)?.();
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose();
  });
}
