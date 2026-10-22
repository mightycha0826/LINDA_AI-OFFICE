// 티켓 상세 (12장 업무 탭): 완료 조건 체크리스트, 대화 로그, 변경 요약, 사용량, 회의록
import { useEffect, useState } from 'react';
import { fetchTicket, type TicketDetail } from '../data.ts';
import { PAUSE_LABEL, STATUS_LABEL, TYPE_LABEL, clock } from '../format.ts';
import { Meter } from './UsageCard.tsx';

export function TicketDetailView({ id, timezone, names }: { id: string; timezone: string; names: Map<string, string> }) {
  const [d, setD] = useState<TicketDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    fetchTicket(id)
      .then((x) => alive && setD(x))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [id, tries]);

  if (failed && !d)
    return (
      <div className="pt-empty pt-empty--error" role="status">
        <div className="pt-empty__disc">
          <span className="material-symbols-rounded" aria-hidden="true">
            cloud_off
          </span>
        </div>
        <p className="pt-empty__title">불러오지 못했어요</p>
        <p className="pt-empty__text">화면 서버 연결을 확인해 주세요</p>
        <button type="button" className="pt-btn" onClick={() => setTries((n) => n + 1)}>
          <span className="material-symbols-rounded" aria-hidden="true">
            refresh
          </span>
          다시 시도
        </button>
      </div>
    );
  if (!d)
    return (
      <div className="pt-empty pt-empty--loading" role="status">
        <div className="pt-empty__disc">
          <span className="material-symbols-rounded" aria-hidden="true">
            progress_activity
          </span>
        </div>
        <p className="pt-empty__title">불러오는 중</p>
        <p className="pt-empty__text">잠시만 기다려 주세요</p>
      </div>
    );

  const t = d.ticket;
  const who = (x: string | null) => (x ? (names.get(x) ?? x) : '전체');
  return (
    <div className="ao-detail">
      <p className="ao-detail__title">{t.title}</p>
      <div className="ao-detail__badges">
        <span className="pt-badge">{TYPE_LABEL[t.type]}</span>
        {t.status === 'blocked' ? (
          <span className="pt-badge">
            <span className="material-symbols-rounded ao-warn" aria-hidden="true">
              warning
            </span>
            막힘
          </span>
        ) : (
          <span className="pt-badge">{STATUS_LABEL[t.status]}</span>
        )}
        {t.pauseReason && <span className="pt-badge">{PAUSE_LABEL[t.pauseReason]}</span>}
        {t.reworkCount > 0 && <span className="pt-badge">반려 {t.reworkCount}회</span>}
        {t.branch && <span className="pt-badge">{t.branch}</span>}
      </div>
      <dl className="ao-dl">
        <dt>담당</dt>
        <dd>{who(t.assigneeId)}</dd>
        <dt>검토</dt>
        <dd>{who(t.reviewerId)}</dd>
      </dl>

      <h3 className="ao-group__title">완료 조건</h3>
      <ul className="ao-criteria">
        {d.acceptanceCriteria.map((c, i) => (
          <li key={i}>
            <span className={`material-symbols-rounded ao-crit ao-crit--${c.pass === null ? 'none' : c.pass ? 'pass' : 'fail'}`} aria-label={c.pass === null ? '판정 전' : c.pass ? '통과' : '미통과'}>
              {c.pass === null ? 'radio_button_unchecked' : c.pass ? 'check_circle' : 'cancel'}
            </span>
            <span>
              {c.criterion}
              {c.reason && <span className="ao-muted"> · {c.reason}</span>}
            </span>
          </li>
        ))}
      </ul>

      {d.summary && (
        <>
          <h3 className="ao-group__title">변경 요약</h3>
          <p className="ao-detail__text">{d.summary}</p>
        </>
      )}

      <h3 className="ao-group__title">사용량</h3>
      {d.usage.tokenCap === null || d.usage.turnCap === null ? <p className="ao-detail__text">누적 토큰 {d.usage.tokens.toLocaleString('ko-KR')} · {d.usage.turns}턴 · 자체 제한 없음</p> : <>
        <Meter label="토큰" used={(d.usage.tokens / Math.max(d.usage.tokenCap, 1)) * 100} limit={100} note={`${d.usage.tokens.toLocaleString('ko-KR')} / ${d.usage.tokenCap.toLocaleString('ko-KR')}`} />
        <Meter label="턴" used={(d.usage.turns / Math.max(d.usage.turnCap, 1)) * 100} limit={100} note={`${d.usage.turns} / ${d.usage.turnCap}`} />
      </>}

      <h3 className="ao-group__title">회의록</h3>
      {d.minutes.length === 0 ? (
        <p className="ao-muted">회의가 없었어요</p>
      ) : (
        d.minutes.map((m) => (
          <div key={m.id} className="ao-minutes">
            <p className="ao-minutes__head">
              {m.kind === 'gate-review' ? 'GPT 관문' : '회의'} · {m.outcome === 'agreed' ? '합의' : '불합의'}
            </p>
            {m.rounds.map((r) => (
              <div key={r.round}>
                <p className="ao-muted">{r.round}라운드</p>
                <ul>
                  {r.positions.map((p, i) => (
                    <li key={i}>
                      {who(p.employeeId)}: {p.claim}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {m.nextActions.length > 0 && <p className="ao-muted">다음 할 일: {m.nextActions.join(', ')}</p>}
          </div>
        ))
      )}

      <h3 className="ao-group__title">대화 로그</h3>
      <ol className="ao-log__list">
        {[...d.log].reverse().map((l) => (
          <li key={l.id} className="ao-log__row">
            <span className="ao-log__head">
              <span className="ao-num">{clock(l.at, timezone)}</span>
              <span>
                {who(l.fromId)} → {who(l.toId)}
              </span>
              <span className="pt-badge">{l.kind}</span>
            </span>
            <span className="ao-log__text">{l.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
