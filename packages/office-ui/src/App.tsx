// 사무실 화면 (12장). 보기 전용: 승인·푸시 같은 동작 버튼은 없다. 결재는 Discord에서만 한다.
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import type { Snapshot } from '@ai-office/shared';
import { useOffice, type LiveEvent } from './data.ts';
import { Director } from './director.ts';
import { fullName, hourIn } from './format.ts';
import { useNarrow, useNow, useOfficeView, usePanelOpen } from './hooks.ts';
import { useTheme } from './theme.ts';
import { BootScreen } from './components/BootScreen.tsx';
import { EmployeeSheet } from './components/EmployeeSheet.tsx';
import { LogTab } from './components/LogTab.tsx';
import { MobileTabBar, PanelTabs, ViewSwitch, type MobileTab, type PanelTab } from './components/Nav.tsx';
import { OfficeMap } from './components/OfficeMap.tsx';
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

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
  const [panelOpen, togglePanel] = usePanelOpen();
  const { view, has3d, pick: pickView } = useOfficeView(narrow);

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

  if (!snapshot) return <BootScreen failed={connection === 'failed'} onRetry={retry} />;

  const names = nameMap(snapshot);
  const hour = hourIn(new Date(nowMs).toISOString(), snapshot.timezone);
  const night = hour >= 20 || hour < 7;
  // 화면에서 말풍선을 누르면 그 대화 로그로 이동한다 (12장)
  const openLogFor = (id: string) => {
    setLogFocus(id);
    setPanel('log');
    if (narrow) setMobile('work');
  };
  const selectPanel = (k: PanelTab) => {
    setPanel(k);
    if (k !== 'log') setLogFocus(null);
  };

  const dark = night || !snapshot.system.ceoPresent;
  const viewSwitch = has3d && <ViewSwitch view={view} onPick={pickView} />;
  const map2d = <OfficeMap snapshot={snapshot} director={director} night={dark} onOpenTicket={openLogFor} onSelectEmployee={setEmployee} />;
  const map3d = (
    <Suspense fallback={<div className="ao3 pt-empty pt-empty--loading" role="status" aria-label="3D 사무실을 여는 중" />}>
      <Office3DView snapshot={snapshot} night={dark} onSelectEmployee={setEmployee} />
    </Suspense>
  );
  const tabs = <PanelTabs panel={panel} narrow={narrow} approvals={snapshot.approvals.length} onSelect={selectPanel} />;
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
          <MobileTabBar current={mobile} onSelect={setMobile} />
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

function nameMap(s: Snapshot) {
  const m = new Map<string, string>(s.employees.map((e) => [e.id, fullName(e)]));
  m.set('ceo', 'CEO');
  m.set('orchestrator', '시스템');
  return m;
}
