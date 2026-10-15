export type Mode = 'light' | 'dark';
export interface Combo { index: number; name: string; primary: string; point: string; gray: 'cool' | 'neutral' | 'warm' }
/** CSS 변수 이름(앞의 -- 뺀 것) → 값. tokens.css의 색 토큰과 같은 이름. */
export type ThemeVars = Record<string, string>;
export interface ThemeOptions { /** 다크에서만, 0–0.6. 조합색 채도를 낮춤. 기본 0. */ mute?: number }
/** 조합(0–9)과 모드로 테마 값을 계산. 대비가 모자란 조합색은 자동 보정. */
export declare function theme(index: number, mode: Mode, opts?: ThemeOptions): ThemeVars;
/** theme() 결과를 요소의 CSS 변수로 입히고 data-theme도 바꿈. */
export declare function apply(el: HTMLElement, index: number, mode: Mode, opts?: ThemeOptions): ThemeVars;
export declare const COMBOS: Combo[];
declare global { interface Window { Point: { theme: typeof theme; apply: typeof apply; COMBOS: Combo[] } } }
