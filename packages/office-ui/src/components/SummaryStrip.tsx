// 오늘 한눈에 (오른쪽 패널 맨 위, 2026-10-21): 결재 대기 · 막힘 · 진행 · 오늘 완료.
// 색은 상태에만: 결재 대기는 첫 번째 색 점, 막힘은 두 번째 색 점(README: 마감 경고), 나머지는 회색.
import type { Snapshot } from '@ai-office/shared';
import { dayIn } from '../format.ts';

export function todayCounts(s: Snapshot) {
  const today = dayIn(s.now, s.timezone);
  return {
    approvals: s.approvals.length,
    blocked: s.tickets.filter((t) => t.status === 'blocked').length,
    active: s.tickets.filter((t) => ['in_progress', 'rework', 'in_review', 'meeting'].includes(t.status)).length,
    done: s.tickets.filter((t) => t.status === 'done' && t.finishedAt && dayIn(t.finishedAt, s.timezone) === today).length,
  };
}

export function SummaryStrip({ snapshot }: { snapshot: Snapshot }) {
  const n = todayCounts(snapshot);
  const tiles = [
    { key: 'approvals', label: '결재 대기', value: n.approvals, dot: n.approvals > 0 ? 'primary' : null },
    { key: 'blocked', label: '막힘', value: n.blocked, dot: n.blocked > 0 ? 'point' : null },
    { key: 'active', label: '진행', value: n.active, dot: null },
    { key: 'done', label: '오늘 완료', value: n.done, dot: null },
  ] as const;
  return (
    <section className="ao-summary" aria-label="오늘 한눈에">
      {tiles.map((t) => (
        <div key={t.key} className="ao-summary__tile">
          <span className="ao-summary__label">
            {t.dot && <span className={`ao-summary__dot ao-summary__dot--${t.dot}`} aria-hidden="true" />}
            {t.label}
          </span>
          <span className="ao-summary__value ao-num">{t.value}</span>
        </div>
      ))}
    </section>
  );
}
