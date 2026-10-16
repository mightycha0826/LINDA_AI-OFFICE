// 로그 탭 (12장): 시각, 보낸 사람 → 받는 사람, 티켓, 내용. 최신이 위. "회의" 필터는 회의록만.
import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '@ai-office/shared';
import { clock } from '../format.ts';

interface Props {
  snapshot: Snapshot;
  names: Map<string, string>;
  focusTicket: string | null;
  onOpenTicket: (id: string) => void;
}

export function LogTab({ snapshot, names, focusTicket, onOpenTicket }: Props) {
  const [minutesOnly, setMinutesOnly] = useState(false);
  const first = useRef<HTMLLIElement | null>(null);
  const rows = snapshot.log.filter((l) => (!minutesOnly || l.minutes) && (!focusTicket || l.ticketId === focusTicket));
  useEffect(() => first.current?.scrollIntoView({ block: 'nearest' }), [focusTicket]);
  const who = (id: string | null) => (id ? (names.get(id) ?? id) : '전체');

  return (
    <div className="ao-log">
      <div className="ao-log__filters">
        <button type="button" className={`pt-btn${minutesOnly ? '' : ' pt-btn--primary'}`} aria-pressed={!minutesOnly} onClick={() => setMinutesOnly(false)}>
          전체
        </button>
        <button type="button" className={`pt-btn${minutesOnly ? ' pt-btn--primary' : ''}`} aria-pressed={minutesOnly} onClick={() => setMinutesOnly(true)}>
          회의
        </button>
        {focusTicket && <span className="pt-badge">{focusTicket}만 보는 중</span>}
      </div>
      {rows.length === 0 ? (
        <div className="pt-empty" role="status">
          <div className="pt-empty__disc">
            <span className="material-symbols-rounded" aria-hidden="true">
              forum
            </span>
          </div>
          <p className="pt-empty__title">{minutesOnly ? '회의록이 없어요' : '대화가 아직 없어요'}</p>
          <p className="pt-empty__text">직원들이 일을 시작하면 여기에 쌓여요</p>
        </div>
      ) : (
        <ol className="ao-log__list">
          {rows.map((l, i) => (
            <li key={l.id} ref={i === 0 ? first : undefined} className="ao-log__row">
              <span className="ao-log__head">
                <span className="ao-num">{clock(l.at, snapshot.timezone)}</span>
                <span>
                  {who(l.fromId)} → {who(l.toId)}
                </span>
                {l.ticketId && (
                  <button type="button" className="ao-link" onClick={() => onOpenTicket(l.ticketId!)}>
                    {l.ticketId}
                  </button>
                )}
                {l.minutes && <span className="pt-badge">회의록</span>}
              </span>
              <span className="ao-log__text">{l.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
