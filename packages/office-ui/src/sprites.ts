// 캐릭터 스프라이트 (13장). 캐릭터 하나 = 폴더 하나(assets/characters/<세트>/manifest.json + 동작별 PNG).
// 불러올 때 Zod로 manifest를 검사한다. 빠진 동작은 idle로 대신 재생해서 그림이 덜 준비돼도 화면이 깨지지 않게 한다.
import { z } from 'zod';
import type { Facing, Pose } from './director.ts';

const PoseSpec = z.object({ file: z.string().regex(/^[\w-]+\.png$/), frames: z.number().int().min(1).max(24), fps: z.number().positive().max(30), loop: z.boolean() });
export const ManifestSchema = z.object({
  id: z.string(),
  frame: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  anchor: z.object({ x: z.number(), y: z.number() }),
  poses: z.record(z.string(), PoseSpec).refine((p) => 'idle' in p, 'idle 동작은 꼭 있어야 해요'),
});
export type Manifest = z.infer<typeof ManifestSchema>;

const cache = new Map<string, Promise<Manifest | null>>();

export function loadManifest(set: string): Promise<Manifest | null> {
  if (!/^[\w-]+$/.test(set)) return Promise.resolve(null);
  let p = cache.get(set);
  if (!p) {
    p = fetch(`/assets/characters/${set}/manifest.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const parsed = ManifestSchema.safeParse(j);
        return parsed.success ? parsed.data : null;
      })
      .catch(() => null);
    cache.set(set, p);
  }
  return p;
}

/** 이 동작의 시트와 좌우 반전 여부.
 *  정면: `<동작>-front` → 옆 그림(오른쪽) → `idle-front` → idle. 옆: 동작 → idle. 왼쪽은 오른쪽 그림을 반전 */
export function poseSheet(m: Manifest, pose: Pose, facing: Facing = 'right') {
  if (facing === 'front') {
    const sheet = m.poses[`${pose}-front`] ?? m.poses[pose] ?? m.poses['idle-front'] ?? m.poses.idle!;
    return { sheet, flip: false };
  }
  return { sheet: m.poses[pose] ?? m.poses.idle!, flip: facing === 'left' };
}
