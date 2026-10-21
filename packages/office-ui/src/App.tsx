// 사무실 화면 (12장). 보기 전용: 승인·푸시 같은 동작 버튼은 없다. 결재는 Discord에서만 한다.
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import type { Snapshot } from '@ai-office/shared';
import { useOffice, type LiveEvent } from './data.ts';
import { Director } from './director.ts';
import { fullName, hourIn } from './format.ts';
import { useTheme } from './theme.ts';
import { EmployeeSheet } from './components/EmployeeSheet.tsx';
import { LogTab } from './components/LogTab.tsx';
import { OfficeMap } from './components/OfficeMap.tsx';
import { webglAvailable } from './office3d/layout.ts';
import { ResourceTab } from './components/ResourceTab.tsx';
import { StaffTab } from './components/StaffTab.tsx';
import { SummaryStrip } from './components/SummaryStrip.tsx';
import { Sheet } from './components/Sheet.tsx';
import { TicketDetailView } from './components/TicketDetailView.tsx';
import { TopBar } from './components/TopBar.tsx';
import { UsageCard } from './components/UsageCard.tsx';
import { WorkTab } from './components/WorkTab.tsx';

// three.js는 3D를 볼 때만 불러온다 (첫 화면을 가볍게)
const Office3DView = lazy(() => import('./components/Office3DView.tsx'));

type PanelTab = 'work' | 'log' | 'staff' | 'res';
type MobileTab = 'office' | 'work' | 'res';
type View = '3d' | '2d';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function useNarrow() {
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

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

export function App() {
  const director = useMemo(() => new Director(reduced()), []);
  const onEvent = useCallback((e: LiveEvent) => director.handle(e), [director]);
  const { snapshot, connection, retry } = useOffice(onEvent);
  const { pref, cycle } = useTheme(snapshot?.combo ?? 1);
  const nowMs = useNow();
  const narrow = useNarrow();
  const [panel, setPanel] = useState<PanelTab>('work');
  const [mobile, setMobile] = useState<MobileTab>('office');
  const [ticket, setTicket] = useState<string | null>(null);
  const [employee, setEmployee] = useState<string | null>(null);
  const [logFocus, setLogFocus] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(readPanelOpen);
  // 사무실 보기: PC는 3D, 폰은 2D가 기본. 고른 값은 이 브라우저에만 남는다. WebGL이 없으면 2D만
  const has3d = useMemo(webglAvailable, []);
  const [viewPick, setViewPick] = useState<View | null>(readView);
  const view: View = has3d ? (viewPick ?? (narrow ? '2d' : '3d')) : '2d';
  const pickView = (v: View) => {
    writeView(v);
    setViewPick(v);
  };
  const togglePanel = () =>
    setPanelOpen((open) => {
      writePanelOpen(!open);
      return !open;
    });

  useEffect(() => {
    if (snapshot) director.sync(snapshot);
  }, [snapshot, director]);
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    const f = () => (director.reducedMotion = m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, [director]);

  const closeTicket = useCallback(() => setTicket(null), []);
  const closeEmployee = useCallback(() => setEmployee(null), []);

  if (!snapshot) {
    const failed = connection === 'failed';
    return (
      <main className="ao-boot">
        <div className={`pt-empty${failed ? ' pt-empty--error' : ' pt-empty--loading'}`} role="status">
          <div className="pt-empty__disc">
            <span className="material-symbols-rounded" aria-hidden="true">
              {failed ? 'cloud_off' : 'progress_activity'}
            </span>
          </div>
          <p className="pt-empty__title">{failed ? '불러오지 못했어요' : '사무실을 여는 중'}</p>
          <p className="pt-empty__text">{failed ? '오케스트레이터가 켜져 있는지 확인해 주세요' : '잠시만 기다려 주세요'}</p>
          {failed && (
            <button type="button" className="pt-btn" onClick={retry}>
              <span className="material-symbols-rounded" aria-hidden="true">
                refresh
              </span>
              다시 시도
            </button>
          )}
        </div>
      </main>
    );
  }

  const names = nameMap(snapshot);
  const hour = hourIn(new Date(nowMs).toISOString(), snapshot.timezone);
  const night = hour >= 20 || hour < 7;
  // 화면에서 말풍선을 누르면 그 대화 로그로 이동한다 (12장)
  const openLogFor = (id: string) => {
    setLogFocus(id);
    setPanel('log');
    if (narrow) setMobile('work');
  };

  const dark = night || !snapshot.system.ceoPresent;
  const viewSwitch = has3d && (
    <div className="ao-view" role="group" aria-label="사무실 보기">
      {(
        [
          ['3d', 'view_in_ar', '3D'],
          ['2d', 'map', '2D'],
        ] as const
      ).map(([k, icon, label]) => (
        <button key={k} type="button" className="ao-view__btn" aria-pressed={view === k} onClick={() => pickView(k)}>
          <span className="material-symbols-rounded" aria-hidden="true">
            {icon}
          </span>
          {label}
        </button>
      ))}
    </div>
  );
  const map2d = <OfficeMap snapshot={snapshot} director={director} night={dark} onOpenTicket={openLogFor} onSelectEmployee={setEmployee} />;
  const map3d = (
    <Suspense fallback={<div className="ao3 pt-empty pt-empty--loading" role="status" aria-label="3D 사무실을 여는 중" />}>
      <Office3DView snapshot={snapshot} night={dark} onSelectEmployee={setEmployee} />
    </Suspense>
  );
  const tabs = (
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
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={panel === k}
            className="ao-tab"
            onClick={() => {
              setPanel(k);
              if (k !== 'log') setLogFocus(null);
            }}
          >
            {label}
            {k === 'work' && snapshot.approvals.length > 0 && <span className="ao-tab__dot" aria-label={`결재 대기 ${snapshot.approvals.length}건`} />}
          </button>
        ))}
    </div>
  );
  const panelBody =
    panel === 'work' || (narrow && panel === 'res') ? (
      <WorkTab snapshot={snapshot} nowMs={nowMs} names={names} onOpenTicket={setTicket} />
    ) : panel === 'log' ? (
      <LogTab snapshot={snapshot} names={names} focusTicket={logFocus} onOpenTicket={setTicket} />
    ) : panel === 'staff' ? (
      <StaffTab snapshot={snapshot} onSelectEmployee={setEmployee} />
    ) : (
      <ResourceTab snapshot={snapshot} nowMs={nowMs} />
    );

  const emp = employee ? snapshot.employees.find((e) => e.id === employee) : null;

  return (
    <div className="ao-app">
      {connection === 'reconnecting' && (
        <div className="pt-refresh ao-refresh" role="status" aria-label="다시 연결 중">
          <span className="pt-refresh__bar" />
        </div>
      )}
      <TopBar snapshot={snapshot} nowMs={nowMs} pref={pref} onCycleTheme={cycle} />

      {narrow ? (
        <main className="ao-mobile">
          {mobile === 'office' && (
            <>
              {viewSwitch}
              {view === '3d' ? map3d : <div className="ao-map-scroll">{map2d}</div>}
            </>
          )}
          {mobile === 'work' && (
            <div className="ao-panel">
              <SummaryStrip snapshot={snapshot} />
              {tabs}
              {panelBody}
            </div>
          )}
          {mobile === 'res' && (
            <div className="ao-panel">
              <UsageCard snapshot={snapshot} />
              <ResourceTab snapshot={snapshot} nowMs={nowMs} />
            </div>
          )}
          <div className="pt-dock ao-dock">
            <nav className="pt-tabbar" aria-label="주 메뉴">
              {(
                [
                  ['office', 'apartment', '사무실'],
                  ['work', 'checklist', '업무'],
                  ['res', 'bar_chart', '자원'],
                ] as const
              ).map(([k, icon, label]) => (
                <button key={k} type="button" className="pt-tab" aria-current={mobile === k ? 'page' : undefined} onClick={() => setMobile(k)}>
                  <span className="material-symbols-rounded" aria-hidden="true">
                    {icon}
                  </span>
                  {label}
                </button>
              ))}
            </nav>
          </div>
        </main>
      ) : (
        <main className={`ao-main${panelOpen ? '' : ' ao-main--collapsed'}`}>
          <div className="ao-map-wrap">
            {viewSwitch}
            {view === '3d' ? map3d : map2d}
          </div>
          {/* 오른쪽 패널 숨기기·열기. 숨기면 지도가 넓어진다. 고른 상태는 이 브라우저에만 남는다 */}
          <div className="ao-panel-rail">
            <button
              type="button"
              className="pt-icon-btn ao-panel-toggle"
              aria-controls="ao-side"
              aria-expanded={panelOpen}
              aria-label={panelOpen ? '오른쪽 패널 숨기기' : `오른쪽 패널 열기${snapshot.approvals.length ? `, 결재 대기 ${snapshot.approvals.length}건` : ''}`}
              title={panelOpen ? '패널 숨기기' : '패널 열기'}
              onClick={togglePanel}
            >
              <span className="material-symbols-rounded" aria-hidden="true">
                {panelOpen ? 'chevron_right' : 'chevron_left'}
              </span>
              {!panelOpen && snapshot.approvals.length > 0 && <span className="ao-panel-toggle__dot" aria-hidden="true" />}
            </button>
          </div>
          <aside id="ao-side" className="ao-panel ao-side" inert={!panelOpen} aria-hidden={!panelOpen}>
            <SummaryStrip snapshot={snapshot} />
            <UsageCard snapshot={snapshot} />
            {tabs}
            {panelBody}
          </aside>
        </main>
      )}

      {ticket && (
        <Sheet title={ticket} onClose={closeTicket}>
          <TicketDetailView id={ticket} timezone={snapshot.timezone} names={names} />
        </Sheet>
      )}
      {emp && (
        <EmployeeSheet
          employee={emp}
          ticket={director.ticketOf(emp.id)}
          onClose={closeEmployee}
          onOpenTicket={(id) => {
            setEmployee(null);
            setTicket(id);
          }}
        />
      )}
    </div>
  );
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

function nameMap(s: Snapshot) {
  const m = new Map<string, string>(s.employees.map((e) => [e.id, fullName(e)]));
  m.set('ceo', 'CEO');
  m.set('orchestrator', '시스템');
  return m;
}
