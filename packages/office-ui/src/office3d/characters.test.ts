// 3D 캐릭터 외모 표 (13장 3D 캐릭터): 이름 있는 9명이 기준 그림(Discord 봇 프로필)대로 서로 다르게 보이는가
import { describe, expect, it } from 'vitest';
import { lookOf, NAMED_LOOKS, shade } from './characters.ts';

const NINE = ['chief-of-staff', 'pm', 'developer', 'marketing', 'dev-a', 'dev-b', 'strategy', 'qa-local', 'reviewer'];

describe('3D 캐릭터 외모 표', () => {
  it('이름 있는 9명이 모두 있고, 모두 검은 정장이다 (사진과 같음)', () => {
    expect(Object.keys(NAMED_LOOKS).sort()).toEqual([...NINE].sort());
    for (const id of NINE) expect(lookOf(id).suit, id).toBe(true);
  });

  it('9명의 머리 모양·색 조합이 서로 겹치지 않는다', () => {
    const keys = NINE.map((id) => `${lookOf(id).style}:${lookOf(id).hair}:${lookOf(id).bangs}`);
    expect(new Set(keys).size).toBe(9);
  });

  it('사진의 특징: 안경은 백서진만, 웨이브는 한주아, 묶음은 서예린, 땋은 머리는 설아인', () => {
    expect(NINE.filter((id) => lookOf(id).glasses)).toEqual(['chief-of-staff']);
    expect(lookOf('dev-a').style).toBe('wavy');
    expect(lookOf('strategy').style).toBe('ponytail');
    expect(lookOf('developer').style).toBe('braid-bob');
    expect(lookOf('marketing').ribbon?.color).toBe(0xf7f5f0);
  });

  it('보조·임시 직원은 ID로 정해진 머리와 색 가디건 (정장 아님, 매번 같음)', () => {
    const a = lookOf('explainer');
    expect(a.suit).toBe(false);
    expect(lookOf('explainer')).toEqual(a);
    expect(a.glasses).toBe(false);
  });

  it('shade: 밝게·어둡게', () => {
    expect(shade(0x808080, 0)).toBe(0x808080);
    expect(shade(0x000000, 1)).toBe(0xffffff);
    expect(shade(0xffffff, -1)).toBe(0x000000);
  });
});
