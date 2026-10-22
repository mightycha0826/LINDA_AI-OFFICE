// 3D 인형 모양 도구: 구면 좌표, 가늘어지는 띠·관, 원기둥 팔다리, 같은 재질끼리 합치기.
// 좌표는 figure.ts와 같다(머리 도구는 머리 중심 기준).
import * as THREE from 'three';
import { mergeBufferGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const V3 = THREE.Vector3;
export type V3 = THREE.Vector3;
export const DEG = Math.PI / 180;

/** 머리 중심 기준 구면 좌표: theta = 정수리에서 내려온 각, lon = 정면에서 +x(캐릭터 왼쪽)로 돈 각 (도) */
export function sp(theta: number, lon: number, r: number): V3 {
  const t = theta * DEG;
  const l = lon * DEG;
  return new V3(r * Math.sin(t) * Math.sin(l), r * Math.cos(t), r * Math.sin(t) * Math.cos(l));
}

/** 정해진 값으로 섞는 가짜 난수 (매번 같은 머리 모양) */
export function noise(i: number, k = 1): number {
  const s = Math.sin(i * 91.7 + k * 12.3) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * 머리카락 한 가닥: 점들을 지나며 끝으로 갈수록 가늘어지는 띠. 가운데를 살짝 바깥으로 접어 두께감을 낸다.
 * 바깥 방향은 머리 중심보다 위에서는 구, 아래에서는 세로축 기준.
 */
export function strand(pts: V3[], w0: number, w1: number, segs = 10): THREE.BufferGeometry {
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
export function tube(pts: V3[], r0: number, r1: number, segs = 18, radial = 10): THREE.BufferGeometry {
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
export function limb(a: V3, b: V3, r0: number, r1: number, radial = 12): THREE.BufferGeometry {
  const d = new V3().subVectors(b, a);
  const g = new THREE.CylinderGeometry(r1, r0, d.length(), radial, 1, false);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), d.clone().normalize()));
  const m = new V3().addVectors(a, b).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  return g;
}

export function ball(r: number, at: V3, scale = new V3(1, 1, 1), seg = 16): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, seg, Math.max(8, seg * 0.75));
  g.scale(scale.x, scale.y, scale.z);
  g.translate(at.x, at.y, at.z);
  return g;
}

/** 같은 재질 조각을 모아 하나로 합친다 */
export class Batch {
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
