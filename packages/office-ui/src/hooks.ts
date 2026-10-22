// 화면 상태 훅 (12장): 좁은 화면, 30초마다 바뀌는 지금 시각, 이 브라우저에만 남기는 보기 설정(오른쪽 패널, 3D/2D).
import { useEffect, useMemo, useState } from 'react';
import { webglAvailable } from './office3d/layout.ts';

export type View = '3d' | '2d';

export function useNarrow() {
  const q = '(max-width: 767px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const f = () => setNarrow(m.matches);
    // 처음 그린 뒤 창 크기가 바뀌었을 수 있으니 한 번 맞추고, resize도 같이 듣는다
    f();
    m.addEventListener('change', f);
    window.addEventListener('resize', f);
    return () => {
      m.removeEventListener('change', f);
      window.removeEventListener('resize', f);
    };
  }, []);
  return narrow;
}

export function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/** 오른쪽 패널 숨기기·열기. 고른 상태는 이 브라우저에만 남는다 */
export function usePanelOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(readPanelOpen);
  const toggle = () =>
    setOpen((o) => {
      writePanelOpen(!o);
      return !o;
    });
  return [open, toggle];
}

/** 사무실 보기: PC는 3D, 폰은 2D가 기본. 고른 값은 이 브라우저에만 남는다. WebGL이 없으면 2D만 */
export function useOfficeView(narrow: boolean): { view: View; has3d: boolean; pick: (v: View) => void } {
  const has3d = useMemo(webglAvailable, []);
  const [picked, setPicked] = useState<View | null>(readView);
  const view: View = has3d ? (picked ?? (narrow ? '2d' : '3d')) : '2d';
  const pick = (v: View) => {
    writeView(v);
    setPicked(v);
  };
  return { view, has3d, pick };
}

const PANEL_KEY = 'ao-panel-open';

function readPanelOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) !== '0';
  } catch {
    return true;
  }
}

function writePanelOpen(open: boolean) {
  try {
    localStorage.setItem(PANEL_KEY, open ? '1' : '0');
  } catch {
    /* 저장할 수 없는 브라우저면 이번 화면에서만 */
  }
}

const VIEW_KEY = 'ao-office-view';

function readView(): View | null {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === '3d' || v === '2d' ? v : null;
  } catch {
    return null;
  }
}

function writeView(v: View) {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* 저장할 수 없는 브라우저면 이번 화면에서만 */
  }
}
