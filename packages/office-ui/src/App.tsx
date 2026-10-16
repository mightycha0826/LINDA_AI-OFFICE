// 사무실 화면 (12장). 보기 전용: 승인·푸시 같은 동작 버튼은 없다. 결재는 Discord에서만 한다.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Snapshot } from '@ai-office/shared';
import { useOffice, type LiveEvent } from './data.ts';
import { Director } from './director.ts';
import { hourIn } from './format.ts';
import { useTheme } from './theme.ts';
import { LogTab } from './components/LogTab.tsx';
import { OfficeMap } from './components/OfficeMap.tsx';
import { ResourceTab } from './components/ResourceTab.tsx';
import { Sheet } from './components/Sheet.tsx';
import { TicketDetailView } from './components/TicketDetailView.tsx';
import { TopBar } from './components/TopBar.tsx';
import { UsageCard } from './components/UsageCard.tsx';
import { WorkTab } from './components/WorkTab.tsx';
import { STATUS_LABEL } from './format.ts';

type PanelTab = 'work' | 'log' | 'res';
type MobileTab = 'office' | 'work' | 'res';

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

  const map = <OfficeMap snapshot={snapshot} director={director} night={night || !snapshot.system.ceoPresent} onOpenTicket={openLogFor} onSelectEmployee={setEmployee} />;
  const tabs = (
    <div className="ao-tabs" role="tablist" aria-label="패널">
      {(
        [
          ['work', '업무'],
          ['log', '로그'],
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
    ) : (
      <ResourceTab snapshot={snapshot} nowMs={nowMs} />
    );

  const emp = employee ? snapshot.employees.find((e) => e.id === employee) : null;
  const empTicket = emp ? director.ticketOf(emp.id) : null;

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
          {mobile === 'office' && <div className="ao-map-scroll">{map}</div>}
          {mobile === 'work' && (
            <div className="ao-panel">
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
        <main className="ao-main">
          <div className="ao-map-wrap">{map}</div>
          <aside className="ao-panel">
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
        <Sheet title={emp.displayName} onClose={closeEmployee}>
          <dl className="ao-dl">
            <dt>역할</dt>
            <dd>
              {emp.department}
              {emp.isTemporary ? ' · 임시 직원' : ''}
            </dd>
            <dt>두뇌</dt>
            <dd>{emp.brainLabel}</dd>
            <dt>지금</dt>
            <dd>{empTicket ? `${empTicket.id} ${STATUS_LABEL[empTicket.status]}` : '대기 중'}</dd>
          </dl>
          {empTicket && (
            <button
              type="button"
              className="pt-btn pt-btn--primary"
              onClick={() => {
                setEmployee(null);
                setTicket(empTicket.id);
              }}
            >
              {empTicket.id} 상세 보기
            </button>
          )}
        </Sheet>
      )}
    </div>
  );
}

function nameMap(s: Snapshot) {
  const m = new Map<string, string>(s.employees.map((e) => [e.id, e.displayName]));
  m.set('ceo', 'CEO');
  m.set('orchestrator', '시스템');
  return m;
}
