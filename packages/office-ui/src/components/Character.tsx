// 캐릭터 (13장 코드 쪽 규칙): pose, facing, spriteSet만 받는다. 재생은 CSS 배경 이미지를 steps()로 넘긴다.
// 왼쪽을 볼 때는 scaleX(-1). 정면(front)은 `<동작>-front` 시트, 없으면 오른쪽 그림. 일시정지 회색 처리는 코드가 한다. 이름표·말풍선·느낌표는 위에 덧그린다.
import { useEffect, useState } from 'react';
import type { Facing, Pose } from '../director.ts';
import { loadManifest, poseSheet, type Manifest } from '../sprites.ts';

export interface CharacterProps {
  spriteSet: string;
  pose: Pose;
  facing: Facing;
}

export function Character({ spriteSet, pose, facing }: CharacterProps) {
  const [m, setM] = useState<Manifest | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void loadManifest(spriteSet).then((x) => alive && setM(x));
    return () => {
      alive = false;
    };
  }, [spriteSet]);

  if (m === undefined) return <div className="ao-sprite" />;
  if (m === null) return <div className="ao-sprite ao-sprite--missing" aria-hidden="true" />;
  const { sheet, flip } = poseSheet(m, pose, facing);
  const n = sheet.frames;
  return (
    <div
      className={`ao-sprite${pose === 'paused' ? ' ao-sprite--paused' : ''}`}
      style={{
        backgroundImage: `url(/assets/characters/${spriteSet}/${sheet.file})`,
        backgroundSize: `${n * 100}% 100%`,
        transform: flip ? 'scaleX(-1)' : undefined,
        animation: n > 1 && sheet.loop ? `ao-sprite ${n / sheet.fps}s steps(${n}, jump-none) infinite` : undefined,
      }}
    />
  );
}
