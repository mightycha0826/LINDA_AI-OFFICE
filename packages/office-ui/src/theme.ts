// 테마 (17장 적용 방법 3): Point.apply(document.documentElement, 조합-1, 모드).
// 화면 테마는 사용자가 고른다(시스템 / 라이트 / 다크). 고른 값은 이 브라우저에만 저장한다.
import { useEffect, useState } from 'react';

export type ModePref = 'system' | 'light' | 'dark';
const KEY = 'ao-theme';

function readPref(): ModePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function writePref(p: ModePref) {
  try {
    if (p === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch {
    /* 저장할 수 없는 브라우저면 이번 화면에서만 쓴다 */
  }
}

const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function resolveMode(p: ModePref): 'light' | 'dark' {
  return p === 'system' ? (media().matches ? 'dark' : 'light') : p;
}

export function applyTheme(combo: number, mode: 'light' | 'dark') {
  const idx = Math.min(Math.max(Math.round(combo) - 1, 0), 9);
  if (window.Point) window.Point.apply(document.documentElement, idx, mode);
  else document.documentElement.dataset.theme = mode;
}

export function useTheme(combo: number) {
  const [pref, setPref] = useState<ModePref>(readPref);
  const [mode, setMode] = useState(() => resolveMode(pref));

  useEffect(() => {
    const m = media();
    const update = () => setMode(resolveMode(pref));
    update();
    m.addEventListener('change', update);
    return () => m.removeEventListener('change', update);
  }, [pref]);

  useEffect(() => applyTheme(combo, mode), [combo, mode]);

  const cycle = () => {
    const next: ModePref = pref === 'system' ? 'light' : pref === 'light' ? 'dark' : 'system';
    writePref(next);
    setPref(next);
  };
  return { pref, mode, cycle };
}

declare global {
  interface Window {
    Point?: { apply: (el: HTMLElement, index: number, mode: 'light' | 'dark') => Record<string, string> };
  }
}
