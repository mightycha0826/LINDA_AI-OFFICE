// 3D 인형 머리카락 (13장 3D 캐릭터). 가닥(가늘어지는 띠)과 껍데기(구·원기둥 조각)로 만든다.
// main은 머리색, dark는 그늘색 조각. 합치는 일은 figure.ts가 한다. 좌표는 머리 중심 기준.
import * as THREE from 'three';
import type { Look } from './characters.ts';
import { ball, DEG, noise, sp, strand, tube, V3 } from './shapes.ts';

export function hair(look: Look, main: THREE.BufferGeometry[], dark: THREE.BufferGeometry[]): void {
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
