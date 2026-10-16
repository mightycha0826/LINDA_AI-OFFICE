// CEO 접속 중 모드 (10장). 주인이 Discord에 메시지를 보내거나 버튼을 누르면 "접속 중",
// 마지막 활동 뒤 absenceMinutes(기본 20분)가 지나면 "부재".
import { emit, getState, inTx, setState, type Ctx } from '../context.ts';

const LAST = 'ceo.lastActive';
const STATE = 'ceo.presence';

export function isCeoPresent(c: Ctx, now = c.clock.now()): boolean {
  const last = getState<string | null>(c, LAST, null);
  return !!last && now.getTime() - new Date(last).getTime() < c.config.absenceMinutes * 60_000;
}

export function markCeoActive(c: Ctx): void {
  inTx(c, (t) => {
    setState(t, LAST, t.clock.now().toISOString());
    if (getState<string>(t, STATE, 'away') !== 'online') {
      setState(t, STATE, 'online');
      emit(t, 'ceo.presence', { status: 'online' });
    }
  });
}

/** 주기적으로 불러 부재로 바뀐 것을 기록한다 (화면의 CEO실 불이 꺼짐) */
export function refreshPresence(c: Ctx): void {
  if (getState<string>(c, STATE, 'away') === 'online' && !isCeoPresent(c)) {
    inTx(c, (t) => {
      setState(t, STATE, 'away');
      emit(t, 'ceo.presence', { status: 'away' });
    });
  }
}
