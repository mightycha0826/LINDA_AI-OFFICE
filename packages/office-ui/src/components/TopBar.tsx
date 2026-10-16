// 상단 바 (12장 레이아웃): 회사 이름, "보기 전용", CEO 접속 상태, 근무 시간대와 시각, 다음 정기 보고
import type { Snapshot } from '@ai-office/shared';
import { clock } from '../format.ts';
import type { ModePref } from '../theme.ts';

const MODE_ICON: Record<ModePref, string> = { system: 'routine', light: 'light_mode', dark: 'dark_mode' };
const MODE_NAME: Record<ModePref, string> = { system: '시스템 설정', light: '라이트', dark: '다크' };

interface Props {
  snapshot: Snapshot;
  nowMs: number;
  pref: ModePref;
  onCycleTheme: () => void;
}

export function TopBar({ snapshot, nowMs, pref, onCycleTheme }: Props) {
  const s = snapshot.system;
  return (
    <header className="ao-top">
      <div className="ao-top__title">
        <h1>{snapshot.companyName}</h1>
        <span className="pt-badge">보기 전용</span>
      </div>
      <div className="ao-top__meta">
        {s.stopped && (
          <span className="pt-badge pt-badge--point">
            <span className="pt-badge__dot" aria-hidden="true" />
            정지 중
          </span>
        )}
        {!s.online && (
          <span className="pt-badge pt-badge--danger">
            <span className="material-symbols-rounded" aria-hidden="true">
              error
            </span>
            인터넷 끊김
          </span>
        )}
        <span className={`pt-badge${s.ceoPresent ? ' pt-badge--primary' : ''}`}>
          {s.ceoPresent && <span className="pt-badge__dot" aria-hidden="true" />}
          {s.ceoPresent ? 'CEO 접속 중' : 'CEO 부재'}
        </span>
        <span className="ao-top__time">
          {snapshot.timezone.split('/').pop()} {clock(new Date(nowMs).toISOString(), snapshot.timezone)}
        </span>
        <span className="ao-top__next">다음 보고 {snapshot.nextReport}</span>
        <button type="button" className="pt-icon-btn" aria-label={`화면 테마: ${MODE_NAME[pref]}. 눌러서 바꾸기`} title={`테마: ${MODE_NAME[pref]}`} onClick={onCycleTheme}>
          <span className="material-symbols-rounded" aria-hidden="true">
            {MODE_ICON[pref]}
          </span>
        </button>
      </div>
    </header>
  );
}
