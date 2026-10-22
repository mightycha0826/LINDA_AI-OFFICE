// 3D 캐릭터 외모 표 (13장 3D 캐릭터, 2026-10-21 CEO 결정). 기준 그림은 Discord 직원 봇 프로필(assets/portraits)이다.
// 그림 코드(figure.ts)와 나눠 WebGL 없이 시험한다. 색은 숫자(0xRRGGBB): 3D 장면 안에서만 쓰는 예외 색(17장).
// side: 리본·묶음·땋은 머리가 있는 쪽. 1 = 캐릭터의 왼쪽(+x, 정면에서 보면 오른쪽). 사진 9장 모두 그쪽이다.

export type HairStyle =
  /** 가슴까지 긴 생머리 */
  | 'long'
  /** 층을 낸 긴 웨이브 */
  | 'wavy'
  /** 턱선 단발 */
  | 'bob'
  /** 귀 아래 짧은 레이어드 컷 */
  | 'layered'
  /** 목 뒤에서 낮게 묶어 어깨 앞으로 */
  | 'ponytail'
  /** 짧은 단발 + 옆머리를 땋아 뒤로 */
  | 'braid-bob';

export type Bangs =
  /** 눈썹을 덮는 일자 */
  | 'blunt'
  /** 옆으로 흐르는 */
  | 'swept'
  /** 가운데 가르마, 양옆으로 */
  | 'curtain'
  /** 한쪽 눈을 살짝 가림 */
  | 'over-eye'
  /** 가늘고 들쭉날쭉 */
  | 'wispy';

export interface Look {
  /** Reference-sculpted model, separate from the shared office mannequin. */
  portraitModel?: 'seojin';
  hair: number;
  /** 머리 안쪽·그늘 색 */
  hairShade: number;
  style: HairStyle;
  bangs: Bangs;
  /** 긴 머리가 어깨 아래로 내려오는 정도 (0~1) */
  length: number;
  eyes: number;
  smile: boolean;
  glasses: boolean;
  /** 반묶음·땋은 머리 끝의 리본 */
  ribbon: { color: number; tails: boolean } | null;
  tie: 'wide' | 'thin' | null;
  /** 눈 밑 점 */
  mole: boolean;
  earring: boolean;
  side: 1 | -1;
  /** 이름 있는 9명은 검은 정장(사진과 같음), 보조·임시 직원은 색 가디건 */
  suit: boolean;
  jacket: number;
  skin: number;
}

const SUIT = 0x23252b;
/** 조명을 받으면 사진의 밝은 피부(#F6E0D6 언저리)로 보이는 값 */
const SKIN = 0xe9c9b9;

const named = (o: Partial<Look> & Pick<Look, 'hair' | 'hairShade' | 'style' | 'bangs' | 'eyes'>): Look => ({
  length: 0.6,
  smile: false,
  glasses: false,
  ribbon: null,
  tie: null,
  mole: false,
  earring: false,
  side: 1,
  suit: true,
  jacket: SUIT,
  skin: SKIN,
  ...o,
});

/** 이름 있는 9명 (DESIGN 13장 기준 그림 표). 색은 docs/VROID-GUIDE.md와 같은 사진에서 뽑았고, 은발 두 명만 조명에 하얗게 날지 않게 조금 어둡게 했다 */
export const NAMED_LOOKS: Readonly<Record<string, Look>> = {
  // 백서진: 긴 검은 생머리, 일자 앞머리, 가는 사각 안경, 반묶음 검은 리본, 검은 넥타이, 호박색 눈
  'chief-of-staff': named({ portraitModel: 'seojin', hair: 0x1c1a1f, hairShade: 0x0e0d12, style: 'long', bangs: 'blunt', length: 0.75, eyes: 0xb8892e, glasses: true, ribbon: { color: 0x15151a, tails: false }, tie: 'wide' }),
  // 류하영: 짙은 갈색 턱선 단발, 시스루 앞머리, 웃는 얼굴
  pm: named({ hair: 0x3a2a26, hairShade: 0x241915, style: 'bob', bangs: 'swept', eyes: 0x6b4636, smile: true }),
  // 설아인: 은백색 짧은 단발, 옆머리를 땋아 뒤로, 긴 꼬리 검은 리본, 귀걸이, 가는 넥타이
  developer: named({ hair: 0xcdc7c4, hairShade: 0x9a9395, style: 'braid-bob', bangs: 'swept', eyes: 0x7d8696, ribbon: { color: 0x15151a, tails: true }, tie: 'thin', earring: true }),
  // 서지우: 꿀빛 금발 긴 생머리, 흰 리본 반묶음, 눈 밑 점, 넥타이
  marketing: named({ hair: 0xe3c38f, hairShade: 0xc29a62, style: 'long', bangs: 'swept', length: 0.85, eyes: 0xb07a35, ribbon: { color: 0xf7f5f0, tails: true }, tie: 'wide', mole: true }),
  // 한주아: 붉은 갈색 긴 웨이브, 웃는 얼굴
  'dev-a': named({ hair: 0x6e2a2a, hairShade: 0x4a1a1c, style: 'wavy', bangs: 'curtain', length: 0.8, eyes: 0x8a4a42, smile: true }),
  // 한서윤: 검은 턱선 일자 단발, 한쪽 눈을 가리는 앞머리
  'dev-b': named({ hair: 0x1d1d22, hairShade: 0x0f0f13, style: 'bob', bangs: 'over-eye', eyes: 0x8a8698 }),
  // 서예린: 갈색 긴 머리를 낮게 묶어 어깨 앞으로, 가르마 앞머리
  strategy: named({ hair: 0x5a3a2c, hairShade: 0x3a251c, style: 'ponytail', bangs: 'curtain', length: 0.8, eyes: 0x6a4a3a }),
  // 백예원: 회갈색 긴 생머리, 검은 리본 반묶음
  'qa-local': named({ hair: 0xc8b7a0, hairShade: 0x9c8b76, style: 'long', bangs: 'swept', length: 0.75, eyes: 0x9a7a52, ribbon: { color: 0x15151a, tails: true } }),
  // 차은설: 은회색 짧은 레이어드 컷, 눈을 덮는 가는 앞머리
  reviewer: named({ hair: 0xaeb1ba, hairShade: 0x7e818c, style: 'layered', bangs: 'wispy', eyes: 0x8090a4 }),
};

const HAIRS: readonly [number, number][] = [
  [0x3a2e28, 0x241c18],
  [0x2e2420, 0x1a1412],
  [0x5c4636, 0x3c2c22],
  [0x4c3b30, 0x30251e],
  [0x2b2b2e, 0x18181b],
  [0x54412f, 0x382a1e],
];
const CARDIGANS = [0x8fa89a, 0xc77e6b, 0xd9b26c, 0xa9b7c6, 0xb6a6c9, 0x8c9a6e, 0x4e8c74, 0x8e6fb0];
const HELPER_STYLES: readonly HairStyle[] = ['bob', 'long', 'layered', 'ponytail'];

export function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** 이름 있는 9명은 표대로, 나머지(보조·임시 직원)는 ID로 고른 머리와 색 가디건 */
export function lookOf(id: string): Look {
  const known = NAMED_LOOKS[id];
  if (known) return known;
  const h = hash(id);
  const [hair, hairShade] = HAIRS[h % HAIRS.length]!;
  return {
    hair,
    hairShade,
    style: HELPER_STYLES[(h >>> 3) % HELPER_STYLES.length]!,
    bangs: (h >>> 5) % 2 ? 'swept' : 'curtain',
    length: 0.5,
    eyes: 0x5a4032,
    smile: (h >>> 7) % 2 === 0,
    glasses: false,
    ribbon: null,
    tie: null,
    mole: false,
    earring: false,
    side: 1,
    suit: false,
    jacket: CARDIGANS[hash(id + 's') % CARDIGANS.length]!,
    skin: SKIN,
  };
}

/** 0xRRGGBB를 t(−1~1)만큼 밝게(+)·어둡게(−) */
export function shade(color: number, t: number): number {
  const ch = (k: number) => {
    const v = (color >> k) & 0xff;
    return Math.round(t >= 0 ? v + (255 - v) * t : v * (1 + t));
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
