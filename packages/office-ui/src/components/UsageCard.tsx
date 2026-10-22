// 사용량 요약 카드 (오른쪽 패널 위, 항상 보임). 막대 = 이 몫 안에서 쓴 비율.
import type { ScreenUsage, Snapshot } from '@ai-office/shared';
import { BUDGET_LABEL, pct } from '../format.ts';

export function Meter({ label, used, limit, note }: { label: string; used: number; limit: number | null; note?: string | undefined }) {
  const ratio = limit !== null && limit > 0 ? Math.min(used / limit, 1) : 0;
  const full = limit !== null && limit > 0 && used >= limit;
  return (
    <div className="ao-meter">
      <div className="ao-meter__head">
        <span>{label}</span>
        <span className="ao-num">
          {pct(used)} / {limit === null ? '자체 제한 없음' : pct(limit)}
          {note ? ` · ${note}` : ''}
        </span>
      </div>
      {limit !== null && <div className="ao-meter__track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.round(used)}>
        <span className={`ao-meter__bar${full ? ' ao-meter__bar--full' : ''}`} style={{ width: `${ratio * 100}%` }} />
      </div>}
    </div>
  );
}

export function UsageCard({ snapshot }: { snapshot: Snapshot }) {
  const by = (b: ScreenUsage['budget']) => snapshot.usage.find((u) => u.budget === b);
  return (
    <section className="ao-card" aria-label="사용량 요약">
      <div className="ao-card__head">
        <h2>사용량 (5시간)</h2>
        {snapshot.estimated && <span className="pt-badge">추정치</span>}
      </div>
      {(['dev', 'research', 'review'] as const).map((b) => {
        const u = by(b);
        if (!u) return null;
        return <Meter key={b} label={u.fiveHourLimit === null ? b === 'dev' ? 'Claude 개발' : b === 'research' ? 'Claude 기획' : 'Codex' : BUDGET_LABEL[b]} used={u.fiveHour} limit={u.fiveHourLimit} note={u.blockedUntil ? '제공자 한도' : undefined} />;
      })}
    </section>
  );
}
