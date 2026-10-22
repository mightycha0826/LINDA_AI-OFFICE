// 자원 탭 (12장): Claude 몫·개인용 여유·주간, GPT, GPU, 시스템. 모든 사용량에 추정치 여부.
import type { Snapshot } from '@ai-office/shared';
import { BUDGET_LABEL, clock, elapsed, pct } from '../format.ts';
import { Meter } from './UsageCard.tsx';

export function ResourceTab({ snapshot, nowMs }: { snapshot: Snapshot; nowMs: number }) {
  const u = (b: 'dev' | 'research' | 'review') => snapshot.usage.find((x) => x.budget === b)!;
  const s = snapshot.system;
  const est = snapshot.estimated ? '추정치' : '실측';
  return (
    <div className="ao-res">
      <section className="ao-card">
        <div className="ao-card__head">
          <h2>Claude</h2>
          <span className="pt-badge">{est}</span>
        </div>
        <Meter label={`5시간 ${BUDGET_LABEL.dev}`} used={u('dev').fiveHour} limit={u('dev').fiveHourLimit} />
        <Meter label={`5시간 ${BUDGET_LABEL.research}`} used={u('research').fiveHour} limit={u('research').fiveHourLimit} />
        <Meter label="주간 개발" used={u('dev').weekly} limit={u('dev').weeklyLimit} />
        <Meter label="주간 기획" used={u('research').weekly} limit={u('research').weeklyLimit} />
        {u('dev').fiveHourLimit === null ? <p className="ao-card__note">사용량은 참고용 추정치이며 작업을 중단하지 않습니다.</p> : <p className="ao-card__note">
          개인용 여유: 5시간 {pct(s.personalReserve.claudeFiveHour)}, 주간 {pct(s.personalReserve.claudeWeekly)}
        </p>}
        {s.account.claude && (
          <>
            <div className="ao-card__head">
              <h3 className="ao-group__title">계정 전체 (개인 사용 포함)</h3>
              <span className="pt-badge">실측</span>
            </div>
            {s.account.claude.fiveHourPct !== null && <Meter label="5시간" used={s.account.claude.fiveHourPct} limit={100} />}
            {s.account.claude.weeklyPct !== null && <Meter label="주간" used={s.account.claude.weeklyPct} limit={100} />}
            <p className="ao-card__note">{elapsed(s.account.claude.at, nowMs)} 전 Claude 호출 때 받은 값이에요</p>
          </>
        )}
      </section>

      <section className="ao-card">
        <div className="ao-card__head">
          <h2>GPT</h2>
          <span className="pt-badge">{est}</span>
        </div>
        <Meter label="5시간" used={u('review').fiveHour} limit={u('review').fiveHourLimit} />
        <Meter label="주간" used={u('review').weekly} limit={u('review').weeklyLimit} />
        {u('review').fiveHourLimit === null ? <p className="ao-card__note">사용량은 참고용 추정치이며 작업을 중단하지 않습니다.</p> : <p className="ao-card__note">
          개인용 여유: 5시간 {pct(s.personalReserve.gptFiveHour)}, 주간 {pct(s.personalReserve.gptWeekly)}
        </p>}
      </section>

      <section className="ao-card">
        <div className="ao-card__head">
          <h2>GPU</h2>
        </div>
        {s.gpu ? <Meter label="VRAM" used={(s.gpu.usedMB / s.gpu.totalMB) * 100} limit={100} note={`${Math.round(s.gpu.usedMB / 1024)} / ${Math.round(s.gpu.totalMB / 1024)}GB`} /> : <p className="ao-card__note">VRAM 정보를 읽지 못했어요</p>}
        <dl className="ao-dl">
          <dt>올라간 모델</dt>
          <dd>{s.loadedModel ?? '없음'}</dd>
          <dt>마지막 교체</dt>
          <dd>{s.lastModelSwitchAt ? `${clock(s.lastModelSwitchAt, snapshot.timezone)} (${elapsed(s.lastModelSwitchAt, nowMs)} 전)` : '없음'}</dd>
        </dl>
      </section>

      <section className="ao-card">
        <div className="ao-card__head">
          <h2>시스템</h2>
        </div>
        <dl className="ao-dl">
          <dt>가동 시간</dt>
          <dd>{elapsed(s.startedAt, nowMs)}</dd>
          <dt>인터넷</dt>
          <dd>{s.online ? '연결됨' : '끊김'}</dd>
          <dt>작업</dt>
          <dd>{s.stopped ? 'CEO 정지 중' : '진행 중'}</dd>
        </dl>
        {s.lastError ? (
          <div className="pt-notice pt-notice--danger" role="status">
            <span className="material-symbols-rounded" aria-hidden="true">
              error
            </span>
            <span className="pt-notice__text">{s.lastError}</span>
          </div>
        ) : (
          <p className="ao-card__note">최근 오류가 없어요</p>
        )}
      </section>
    </div>
  );
}
