// 3D 직원 인형 (13장 3D 캐릭터, 코드 임시본). 외모 표(characters.ts)를 three.js 도형으로 만든다.
// 좌표는 자리 기준: 바닥 = 0, 의자 좌석 윗면 = 0.485, 캐릭터는 +z(책상 쪽)를 본다. 책상 윗면은 0.81, 책상 앞 모서리는 z 0.3.
// 같은 재질끼리 하나로 합쳐 그리기 횟수를 줄인다. 머리카락은 hair.ts, 얼굴 그림은 face.ts, 모양 도구는 shapes.ts.
import * as THREE from 'three';
import { shade, type Look } from './characters.ts';
import { paintFace } from './face.ts';
import { hair } from './hair.ts';
import { buildHand, type Hand } from './hands.ts';
import { buildSeojin } from './seojin.ts';
import { ball, Batch, limb, sp, V3 } from './shapes.ts';

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

// ---------- 몸통 ----------

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
