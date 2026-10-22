import * as T from 'three';
import { mergeBufferGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Act } from './layout.ts';

export interface Hand {
  root: T.Group;
  fingers: T.Group[][];
}

/** Palm down, wrist at the origin, fingertips toward +z. Side is the arm's x sign. */
export function buildHand(side: number, skin: T.Material, nail: T.Material): Hand {
  const root = new T.Group();
  root.name = 'articulated-hand';
  const ellipsoid = (parent: T.Object3D, x: number, y: number, z: number, a: number, b: number, c: number, material = skin) => {
    const g = new T.SphereGeometry(1, 12, 8);
    g.scale(a, b, c);
    g.translate(x, y, z);
    const m = new T.Mesh(g, material);
    m.castShadow = true;
    parent.add(m);
  };
  ellipsoid(root, 0, 0, 0.012, 0.021, 0.012, 0.023); // wrist
  ellipsoid(root, 0, 0.002, 0.042, 0.034, 0.016, 0.035);
  ellipsoid(root, -side * 0.024, -0.004, 0.035, 0.016, 0.014, 0.023); // thumb pad
  const fingers: T.Group[][] = [];
  // Index, middle, ring, little: separate lengths, knuckles and three phalanges.
  for (let i = 0; i < 5; i++) {
    const thumb = i === 4;
    const total = [0.055, 0.063, 0.058, 0.045][i] ?? 0.046;
    const parts = thumb ? [0.025, 0.021] : [total * 0.43, total * 0.33, total * 0.24];
    const chain: T.Group[] = [];
    let parent: T.Object3D = root;
    for (let j = 0; j < parts.length; j++) {
      const pivot = new T.Group();
      if (j === 0) {
        pivot.position.set(thumb ? -side * 0.029 : side * (-0.024 + i * 0.016), thumb ? -0.003 : 0.003, thumb ? 0.03 : 0.065 - (i === 3 ? 0.008 : 0));
        pivot.rotation.y = thumb ? -side * 0.7 : side * (i - 1.4) * 0.055;
      } else pivot.position.z = parts[j - 1]!;
      const radius = (thumb ? 0.009 : 0.0078 - i * 0.0005) * (1 - j * 0.12);
      ellipsoid(pivot, 0, 0, 0, radius, radius * 0.92, radius);
      ellipsoid(pivot, 0, 0, parts[j]! / 2, radius * 0.95, radius * 0.85, parts[j]! / 2 + radius * 0.45);
      if (j === parts.length - 1) ellipsoid(pivot, 0, radius * 0.79, parts[j]! * 0.62, radius * 0.68, 0.0012, parts[j]! * 0.26, nail);
      parent.add(pivot);
      parent = pivot;
      chain.push(pivot);
    }
    fingers.push(chain);
  }
  // Two skin surfaces per segment become one draw call; joints remain articulated.
  root.traverse(node => {
    if (!(node instanceof T.Group)) return;
    const meshes = node.children.filter((child): child is T.Mesh => child instanceof T.Mesh && child.material === skin);
    if (meshes.length < 2) return;
    const mesh = new T.Mesh(mergeBufferGeometries(meshes.map(m => m.geometry))!, skin);
    mesh.castShadow = true;
    meshes.forEach(m => { node.remove(m); m.geometry.dispose(); });
    node.add(mesh);
  });
  const hand = { root, fingers };
  animateHand(hand, 'idle', 0, 0, 0);
  return hand;
}

/** Keep fingers curved at rest; typing comes from small independent finger presses. */
export function animateHand(hand: Hand, act: Act, t: number, phase: number, motion: number): void {
  hand.fingers.forEach((chain, i) => {
    const tap = act === 'type' && i < 4 ? Math.max(0, Math.sin(t * (6.4 + i * 0.7) + phase + i * 1.9)) * 0.19 * motion : 0;
    chain.forEach((p, j) => {
      const relaxed = i === 4 ? 0.24 + j * 0.12 : 0.14 + j * 0.22 + i * 0.025;
      const open = act === 'talk' ? 0.48 : 1;
      p.rotation.x = relaxed * open + tap * (j === 0 ? 1 : 0.65);
    });
  });
}

export function gripHand(hand: Hand, strength: number): void {
  hand.fingers.forEach((chain, i) => chain.forEach((pivot, j) => {
    pivot.rotation.x += strength * (i === 4 ? 0.25 : j === 0 ? 0.65 : 0.8);
  }));
}
