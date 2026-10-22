// 3D 사무실 공용 도우미.
// 색은 숫자(0xRRGGBB)로 적고, 캔버스에 그릴 때만 css()로 바꾼다.
export const css = (n: number) => '#' + n.toString(16).padStart(6, '0');

/** 씨앗으로 정해지는 0~1 값. 같은 씨앗이면 늘 같은 값이라 가구 배치가 매번 같다 */
export function rnd(seed: number): number {
  const s = Math.sin(seed * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}
