import { describe, expect, it } from 'vitest';
import * as T from 'three';
import { animateHand, buildHand } from './hands.ts';
import { buildKeyboard, buildMouse } from './peripherals.ts';
import { DESK_SEATS } from './layout.ts';

const skin = new T.MeshBasicMaterial();
const nail = new T.MeshBasicMaterial();
const materials = new Map<number, T.Material>();
const material = (color: number) => {
  if (!materials.has(color)) materials.set(color, new T.MeshBasicMaterial({ color }));
  return materials.get(color)!;
};

describe('seated character and desk details', () => {
  it('interpreter sits at the south chair of the 13.3m bench, not inside its backrest', () => {
    expect(DESK_SEATS.interpreter!.z).toBeCloseTo(13.3 + 1.65 + 0.3);
    expect(DESK_SEATS.interpreter!.face).toBe(-1);
  });

  it('hands mirror around the wrist and have separate finger chains with an opposable thumb', () => {
    const left = buildHand(1, skin, nail), right = buildHand(-1, skin, nail);
    const a = new T.Box3().setFromObject(left.root), b = new T.Box3().setFromObject(right.root);
    expect(a.max.x).toBeCloseTo(-b.min.x);
    expect(a.min.x).toBeCloseTo(-b.max.x);
    expect(left.fingers.map(chain => chain.length)).toEqual([3,3,3,3,2]);
    expect(left.fingers[4]![0]!.position.x).toBeLessThan(left.fingers[0]![0]!.position.x);
    expect(a.max.z).toBeGreaterThan(0.11);
    expect(a.min.y).toBeGreaterThan(-0.055);
  });

  it('typing presses fingers independently while reduced motion preserves a stable resting pose', () => {
    const hand = buildHand(1, skin, nail);
    const angles = () => hand.fingers.flat().map(j => j.rotation.x);
    animateHand(hand, 'type', 0.7, 0.3, 1); const first = angles();
    animateHand(hand, 'type', 1.1, 0.3, 1);
    expect(angles()).not.toEqual(first);
    animateHand(hand, 'idle', 0, 0, 0); const rest = angles();
    animateHand(hand, 'type', 50, 3, 0);
    expect(angles()).toEqual(rest);
    animateHand(hand, 'talk', 0, 0, 1);
    expect(hand.fingers[0]![1]!.rotation.x).toBeLessThan(rest[1]!);
  });

  it('detailed peripherals sit above the desk, fit their allotted space and batch static keys', () => {
    for (const [model, width, depth, height] of [[buildKeyboard(material), 0.47, 0.18, 0.043], [buildMouse(material), 0.075, 0.12, 0.048]] as const) {
      const box = new T.Box3().setFromObject(model);
      const size = box.getSize(new T.Vector3());
      expect(box.min.y).toBeGreaterThan(-0.0001);
      expect(size.x).toBeLessThan(width);
      expect(size.z).toBeLessThan(depth);
      expect(box.max.y).toBeLessThan(height);
      let meshes = 0;
      model.traverse(node => { if (node instanceof T.Mesh) meshes++; });
      expect(meshes).toBeLessThan(14);
    }
  });
});
