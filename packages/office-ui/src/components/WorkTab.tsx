// 업무 탭 (12장): 칸반 대신 상태별 묶음 목록. 주인이 먼저 볼 것부터 위에 둔다.
// 결재 대기 → 막힘 → 검토 중 → 진행 중 → 푸시 중 → 오늘 완료(접힘)
import type { ScreenTicket, Snapshot } from '@ai-office/shared';
import type { ReactNode } from 'react';
import { PAUSE_LABEL, TYPE_LABEL, dayIn, elapsed } from '../format.ts';

interface Props {
  snapshot: Snapshot;
  nowMs: number;
  names: Map<string, string>;
  onOpenTicket: (id: string) => void;
}

function TicketCard({ t, names, nowMs, onOpen }: { t: ScreenTicket; names: Map<string, string>; nowMs: number; onOpen: (id: string) => void }) {
  return (
    <button type="button" className="ao-ticket" onClick={() => onOpen(t.id)}>
      <span className="ao-ticket__line">
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
        {title} <span className="ao-num">{count}</span>
      </h3>
      <div className="ao-group__list">{children}</div>
    </section>
  );
}

export function WorkTab({ snapshot, nowMs, names, onOpenTicket }: Props) {
  const ts = snapshot.tickets;
  const pushing = new Set(snapshot.pushing);
  const blocked = ts.filter((t) => t.status === 'blocked');
  const review = ts.filter((t) => t.status === 'in_review');
  const doing = ts.filter((t) => ['in_progress', 'rework', 'meeting', 'paused', 'planned'].includes(t.status) && !pushing.has(t.id));
  const push = ts.filter((t) => pushing.has(t.id));
  const today = dayIn(snapshot.now, snapshot.timezone);
  const done = ts.filter((t) => t.status === 'done' && t.finishedAt && dayIn(t.finishedAt, snapshot.timezone) === today);
  const card = (t: ScreenTicket) => <TicketCard key={t.id} t={t} names={names} nowMs={nowMs} onOpen={onOpenTicket} />;

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

  return (
    <div className="ao-work">
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
            오늘 완료 <span className="ao-num">{done.length}</span>
          </summary>
          <div className="ao-group__list">{done.map(card)}</div>
        </details>
      )}
    </div>
  );
}
