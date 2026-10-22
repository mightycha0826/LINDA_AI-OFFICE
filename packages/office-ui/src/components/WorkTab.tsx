// 업무 탭 (12장): 칸반 대신 묶음 목록. 주인이 먼저 볼 것부터 위에 둔다.
// 상태별: 결재 대기 → 막힘 → 검토 중 → 진행 중 → 푸시 중 → 오늘 완료(접힘)
// 프로젝트별(기본, 2026-10-22 CEO 요청): 결재 대기 → 프로젝트 → 지시 → 티켓. 보는 방식은 이 브라우저에 기억한다
import type { ScreenTicket, Snapshot } from '@ai-office/shared';
import { useState, type ReactNode } from 'react';
import { PAUSE_LABEL, TYPE_LABEL, dayIn, elapsed } from '../format.ts';
import { projectGroups, type ProjectGroup } from '../projects.ts';

interface Props {
  snapshot: Snapshot;
  nowMs: number;
  names: Map<string, string>;
  onOpenTicket: (id: string) => void;
}

/** 지도 이름표와 같은 상태 점 (일하는 중 = 첫 번째 색, 막힘 = 두 번째 색, 멈춤 = 회색) */
const CARD_DOT: Partial<Record<ScreenTicket['status'], string>> = {
  in_progress: 'working',
  rework: 'working',
  in_review: 'reviewing',
  meeting: 'meeting',
  blocked: 'blocked',
  paused: 'paused',
};

interface CardProps {
  t: ScreenTicket;
  names: Map<string, string>;
  nowMs: number;
  onOpen: (id: string) => void;
  /** 상태별 보기에서만 프로젝트 칩을 붙인다 (프로젝트별 보기는 묶음 제목에 있다) */
  showProject: boolean;
  pushing: boolean;
}

function TicketCard({ t, names, nowMs, onOpen, showProject, pushing }: CardProps) {
  return (
    <button type="button" className="ao-ticket" onClick={() => onOpen(t.id)}>
      <span className="ao-ticket__line">
        <span className={`ao-dot ao-dot--${CARD_DOT[t.status] ?? 'idle'}`} aria-hidden="true" />
        <span className="ao-ticket__id ao-num">{t.id}</span>
        <span className="ao-ticket__type">{TYPE_LABEL[t.type]}</span>
        {t.status === 'blocked' && (
          <span className="material-symbols-rounded ao-warn" aria-label="막힘">
            warning
          </span>
        )}
        {t.status === 'paused' && <span className="pt-badge">{t.pauseReason ? PAUSE_LABEL[t.pauseReason] : '일시정지'}</span>}
        {t.status === 'meeting' && <span className="pt-badge">회의 중</span>}
        {t.status === 'rework' && <span className="pt-badge">재작업</span>}
        {t.lowPrecision && <span className="pt-badge">저정밀</span>}
        {pushing && !showProject && <span className="pt-badge">푸시 중</span>}
        {showProject && t.projectId && <span className="ao3-tag__proj">{t.projectId}</span>}
      </span>
      <span className="ao-ticket__title">{t.title}</span>
      <span className="ao-ticket__meta">
        {names.get(t.assigneeId) ?? t.assigneeId}
        {t.reworkCount > 0 ? ` · 반려 ${t.reworkCount}회` : ''}
        {t.startedAt ? ` · ${elapsed(t.startedAt, nowMs)}` : ''}
      </span>
    </button>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="ao-group">
      <h3 className="ao-group__title">
        {title} <span className="ao-group__count ao-num">{count}</span>
      </h3>
      <div className="ao-group__list">{children}</div>
    </section>
  );
}

type WorkView = 'project' | 'status';
const VIEW_KEY = 'ao-work-view';

function readView(): WorkView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'status' ? 'status' : 'project';
  } catch {
    return 'project';
  }
}

/** 프로젝트 묶음 머리: 이름 · 티켓 수 · 진행/막힘/완료 */
function ProjectGroupView({ g, repo, card }: { g: ProjectGroup; repo: string | undefined; card: (t: ScreenTicket) => ReactNode }) {
  const counts = (
    [
      ['진행', g.counts.active],
      ['막힘', g.counts.blocked],
      ['완료', g.counts.done],
    ] as const
  ).filter(([, n]) => n > 0);
  return (
    <section className="ao-group ao-proj" aria-label={g.projectId ? `프로젝트 ${g.projectId}` : '프로젝트 없는 지시'}>
      <h3 className="ao-group__title ao-proj__title" title={repo}>
        <span className="material-symbols-rounded" aria-hidden="true">
          {g.projectId ? 'folder' : 'inbox'}
        </span>
        <span className="ao-proj__name">{g.projectId ?? '프로젝트 없음'}</span>
        <span className="ao-group__count ao-num">{g.counts.total}</span>
        {counts.length > 0 && <span className="ao-proj__counts">{counts.map(([k, n]) => `${k} ${n}`).join(' · ')}</span>}
      </h3>
      {g.orders.map((o) => (
        <div key={o.order.id} className="ao-proj__order">
          <h4 className="ao-proj__order-title">
            <span className="ao-num">{o.order.id}</span>
            {o.order.text && <span className="ao-proj__order-text">{o.order.text}</span>}
          </h4>
          <div className="ao-group__list">{o.tickets.map(card)}</div>
        </div>
      ))}
    </section>
  );
}

export function WorkTab({ snapshot, nowMs, names, onOpenTicket }: Props) {
  const [view, setView] = useState<WorkView>(readView);
  const pickView = (v: WorkView) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* 저장할 수 없는 브라우저면 이번 화면에서만 */
    }
  };
  const ts = snapshot.tickets;
  const pushing = new Set(snapshot.pushing);
  const blocked = ts.filter((t) => t.status === 'blocked');
  const review = ts.filter((t) => t.status === 'in_review');
  const doing = ts.filter((t) => ['in_progress', 'rework', 'meeting', 'paused', 'planned'].includes(t.status) && !pushing.has(t.id));
  const push = ts.filter((t) => pushing.has(t.id));
  const today = dayIn(snapshot.now, snapshot.timezone);
  const done = ts.filter((t) => t.status === 'done' && t.finishedAt && dayIn(t.finishedAt, snapshot.timezone) === today);
  const card = (t: ScreenTicket) => <TicketCard key={t.id} t={t} names={names} nowMs={nowMs} onOpen={onOpenTicket} showProject={view === 'status'} pushing={pushing.has(t.id)} />;

  const empty = snapshot.approvals.length + blocked.length + review.length + doing.length + push.length + done.length === 0;
  if (empty)
    return (
      <div className="pt-empty" role="status">
        <div className="pt-empty__disc">
          <span className="material-symbols-rounded" aria-hidden="true">
            checklist
          </span>
        </div>
        <p className="pt-empty__title">진행 중인 업무가 없어요</p>
        <p className="pt-empty__text">Discord 지시 채널에 일을 적으면 여기에 나타나요</p>
      </div>
    );

  // 프로젝트별 보기도 상태별과 같은 티켓만 (지난 날 완료는 빼고)
  const shown = [...new Map([...blocked, ...review, ...doing, ...push, ...done].map((t) => [t.id, t])).values()];
  const repos = new Map((snapshot.projects ?? []).map((p) => [p.id, p.repoUrl]));

  return (
    <div className="ao-work">
      <div className="ao-view ao-view--work" role="group" aria-label="업무 보기">
        {(
          [
            ['project', 'folder', '프로젝트별'],
            ['status', 'view_agenda', '상태별'],
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
      <Group title="결재 대기" count={snapshot.approvals.length}>
        {snapshot.approvals.map((a) => {
          const body = (
            <>
              <span className="pt-badge pt-badge--primary">
                <span className="pt-badge__dot" aria-hidden="true" />
                결재
              </span>
              <span className="pt-notice__text">{a.summary}</span>
              {a.link && (
                <span className="material-symbols-rounded" aria-hidden="true">
                  open_in_new
                </span>
              )}
            </>
          );
          return a.link ? (
            <a key={a.id} className="pt-notice ao-approval" href={a.link} target="_blank" rel="noreferrer" aria-label={`${a.summary}. Discord에서 결재`}>
              {body}
            </a>
          ) : (
            <div key={a.id} className="pt-notice ao-approval">
              {body}
            </div>
          );
        })}
      </Group>
      {view === 'project' ? (
        projectGroups({ tickets: shown, orders: snapshot.orders ?? [] }).map((g) => (
          <ProjectGroupView key={g.projectId ?? '-'} g={g} repo={g.projectId ? repos.get(g.projectId) : undefined} card={card} />
        ))
      ) : (
        <>
          <Group title="막힘" count={blocked.length}>
            {blocked.map(card)}
          </Group>
          <Group title="검토 중" count={review.length}>
            {review.map(card)}
          </Group>
          <Group title="진행 중" count={doing.length}>
            {doing.map(card)}
          </Group>
          <Group title="푸시 중" count={push.length}>
            {push.map(card)}
          </Group>
          {done.length > 0 && (
            <details className="ao-group ao-done">
              <summary className="ao-group__title">
                오늘 완료 <span className="ao-group__count ao-num">{done.length}</span>
              </summary>
              <div className="ao-group__list">{done.map(card)}</div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
