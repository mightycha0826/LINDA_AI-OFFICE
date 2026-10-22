// 화면 전환 버튼 (12장): 사무실 3D/2D, 오른쪽 패널 탭, 폰 아래 메뉴.
import type { View } from '../hooks.ts';

export type PanelTab = 'work' | 'log' | 'staff' | 'res';
export type MobileTab = 'office' | 'work' | 'res';

export function ViewSwitch({ view, onPick }: { view: View; onPick: (v: View) => void }) {
  return (
    <div className="ao-view" role="group" aria-label="사무실 보기">
      {(
        [
          ['3d', 'view_in_ar', '3D'],
          ['2d', 'map', '2D'],
        ] as const
      ).map(([k, icon, label]) => (
        <button key={k} type="button" className="ao-view__btn" aria-pressed={view === k} onClick={() => onPick(k)}>
          <span className="material-symbols-rounded" aria-hidden="true">
            {icon}
          </span>
          {label}
        </button>
      ))}
    </div>
  );
}

/** 업무·로그·직원·자원. 폰에서는 자원이 아래 메뉴에 따로 있어 뺀다 */
export function PanelTabs({ panel, narrow, approvals, onSelect }: { panel: PanelTab; narrow: boolean; approvals: number; onSelect: (k: PanelTab) => void }) {
  return (
    <div className="ao-tabs" role="tablist" aria-label="패널">
      {(
        [
          ['work', '업무'],
          ['log', '로그'],
          ['staff', '직원'],
          ['res', '자원'],
        ] as const
      )
        .filter(([k]) => !narrow || k !== 'res')
        .map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={panel === k} className="ao-tab" onClick={() => onSelect(k)}>
            {label}
            {k === 'work' && approvals > 0 && <span className="ao-tab__dot" aria-label={`결재 대기 ${approvals}건`} />}
          </button>
        ))}
    </div>
  );
}

export function MobileTabBar({ current, onSelect }: { current: MobileTab; onSelect: (k: MobileTab) => void }) {
  return (
    <div className="pt-dock ao-dock">
      <nav className="pt-tabbar" aria-label="주 메뉴">
        {(
          [
            ['office', 'apartment', '사무실'],
            ['work', 'checklist', '업무'],
            ['res', 'bar_chart', '자원'],
          ] as const
        ).map(([k, icon, label]) => (
          <button key={k} type="button" className="pt-tab" aria-current={current === k ? 'page' : undefined} onClick={() => onSelect(k)}>
            <span className="material-symbols-rounded" aria-hidden="true">
              {icon}
            </span>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
