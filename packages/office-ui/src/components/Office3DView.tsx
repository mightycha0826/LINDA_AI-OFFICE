// 3D 사무실 (12장, 2026-10-21 CEO 결정). 2D 지도와 같은 스냅샷을 3D 층에 그린다. 보기 전용.
// 이름표를 누르면 카메라가 다가가고 직원 상세가 열린다. WebGL이 없으면 App이 2D 지도를 쓴다.
// 왼쪽 캐릭터 목록(2026-10-22 CEO 요청): 누르면 그 캐릭터 앞쪽 위로 가까이 다가간다. 이름표·목록 오른쪽에 지금 맡은 프로젝트.
import { useEffect, useMemo, useRef, useState } from 'react';
import { deriveEmployeeStatus, type Snapshot } from '@ai-office/shared';
import { CAT_ID, place3d } from '../office3d/layout.ts';
import { Office3D } from '../office3d/scene.ts';
import { projectOf } from '../projects.ts';
import { characterList } from '../staff.ts';

interface Props {
  snapshot: Snapshot;
  night: boolean;
  onSelectEmployee: (id: string) => void;
}

export default function Office3DView({ snapshot, night, onSelectEmployee }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const officeRef = useRef<Office3D | null>(null);
  const selectRef = useRef(onSelectEmployee);
  selectRef.current = onSelectEmployee;
  const [failed, setFailed] = useState(false);
  const [spin, setSpin] = useState(false);
  const [listOpen, setListOpen] = useState(readListOpen);
  const [focused, setFocused] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  // 책상 명패는 처음 그릴 때 한 번 (이름이 바뀌는 일은 드물다)
  const names = useMemo(() => Object.fromEntries(snapshot.employees.map((e) => [e.id, e.personalName ?? e.displayName])), [snapshot.employees]);
  const namesRef = useRef(names);
  const people = useMemo(() => characterList(snapshot.employees), [snapshot.employees]);

  useEffect(() => {
    if (!canvasRef.current || !labelsRef.current) return;
    try {
      officeRef.current = new Office3D(canvasRef.current, labelsRef.current, (id) => selectRef.current(id), namesRef.current);
    } catch {
      setFailed(true);
    }
    return () => {
      officeRef.current?.dispose();
      officeRef.current = null;
    };
  }, []);

  // 화면 데이터가 바뀔 때마다 자리·상태·결재 서류를 맞춘다. 테마가 바뀌면 배경도 다시 읽는다
  useEffect(() => {
    const office = officeRef.current;
    if (!office) return;
    const cat = snapshot.employees.find((e) => e.id === CAT_ID && !e.leftAt);
    office.update({
      placed: place3d(snapshot.employees, snapshot.tickets, { now: snapshot.now, nextReport: snapshot.nextReport, timezone: snapshot.timezone, clock }),
      night,
      background: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || 'white',
      approvals: snapshot.approvals.length,
      cat: cat ? { name: cat.personalName ?? cat.displayName, status: deriveEmployeeStatus(cat.id, snapshot.tickets, cat.leftAt) } : null,
    });
  });

  useEffect(() => {
    officeRef.current?.setAutoRotate(spin);
  }, [spin]);

  if (failed) {
    return (
      <div className="pt-empty pt-empty--error ao3" role="status">
        <p className="pt-empty__title">3D 화면을 열지 못했어요</p>
        <p className="pt-empty__text">위의 2D 버튼으로 지도를 볼 수 있어요</p>
      </div>
    );
  }

  const toggleList = () =>
    setListOpen((open) => {
      if (!isPhone()) writeListOpen(!open);
      return !open;
    });
  // 폰에서는 목록이 화면 대부분을 가리니 고르면 접고(기억하지 않음), 넓으면 목록 옆 빈자리에 보이게 비킨다
  const zoomTo = (id: string) => {
    const phone = isPhone();
    officeRef.current?.focus(id, true, phone ? 0 : (listRef.current?.offsetWidth ?? 0) + 12);
    if (phone) setListOpen(false);
    setFocused(id);
  };

  const pending = snapshot.approvals.length;
  return (
    <div className="ao3" role="region" aria-label={`3D 사무실. 결재 대기 ${pending}건, ${snapshot.system.ceoPresent ? 'CEO 접속 중' : 'CEO 부재'}. 이름표를 누르면 직원 상세가 열려요`}>
      <canvas ref={canvasRef} className="ao3__canvas" />
      <div ref={labelsRef} className="ao3__labels" />
      {listOpen && (
        <nav ref={listRef} className="ao3__list" aria-label="캐릭터 목록. 누르면 그 캐릭터로 다가가요">
          {people.map((g) => (
            <section key={g.title} className="ao3__list-group">
              <h3 className="ao3__list-title">
                {g.title} <span className="ao-num">{g.members.length}</span>
              </h3>
              {g.members.map((e) => {
                const project = projectOf(e.id, snapshot.tickets);
                const name = e.personalName ?? e.displayName;
                return (
                  <button
                    key={e.id}
                    type="button"
                    className="ao3-person"
                    aria-pressed={focused === e.id}
                    aria-label={`${name}${project ? `, 프로젝트 ${project}` : ''}로 다가가기`}
                    onClick={() => zoomTo(e.id)}
                  >
                    <i className="ao3-dot" data-status={deriveEmployeeStatus(e.id, snapshot.tickets, e.leftAt)} aria-hidden="true" />
                    <span className="ao3-person__name">{name}</span>
                    {project && <span className="ao3-tag__proj">{project}</span>}
                  </button>
                );
              })}
            </section>
          ))}
        </nav>
      )}
      <div className="ao3__tools">
        <button type="button" className="pt-icon-btn" aria-pressed={listOpen} aria-label="캐릭터 목록" title="캐릭터 목록" onClick={toggleList}>
          <span className="material-symbols-rounded" aria-hidden="true">
            groups
          </span>
        </button>
        <button
          type="button"
          className="pt-icon-btn"
          aria-label="처음 시점으로"
          title="처음 시점으로"
          onClick={() => {
            officeRef.current?.goHome();
            setFocused(null);
          }}
        >
          <span className="material-symbols-rounded" aria-hidden="true">
            home
          </span>
        </button>
        <button type="button" className="pt-icon-btn" aria-pressed={spin} aria-label="천천히 돌려 보기" title="천천히 돌려 보기" onClick={() => setSpin((v) => !v)}>
          <span className="material-symbols-rounded" aria-hidden="true">
            360
          </span>
        </button>
      </div>
      <p className="ao3__hint">끌어서 돌리기 · 휠로 확대 · 오른쪽 끌기로 이동</p>
    </div>
  );
}

const LIST_KEY = 'ao-3d-list-open';

const isPhone = () => window.matchMedia('(max-width: 767px)').matches;

/** 목록은 PC에서 펴는 것이 기본이고 고른 값은 이 브라우저에만 남는다. 폰은 화면을 가리니 늘 접힌 채 시작 */
function readListOpen(): boolean {
  if (isPhone()) return false;
  try {
    const v = localStorage.getItem(LIST_KEY);
    if (v === '1' || v === '0') return v === '1';
  } catch {
    /* 저장소를 못 쓰면 기본값 */
  }
  return true;
}

function writeListOpen(open: boolean) {
  try {
    localStorage.setItem(LIST_KEY, open ? '1' : '0');
  } catch {
    /* 저장할 수 없는 브라우저면 이번 화면에서만 */
  }
}
