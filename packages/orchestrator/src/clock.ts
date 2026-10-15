/** 시각은 항상 이 인터페이스로 얻는다. 테스트에서 시간을 앞으로 돌려 "자동 승인 없음"을 확인한다. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  private current: Date;

  constructor(start = '2026-10-15T09:00:00+09:00') {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  advanceHours(h: number): void {
    this.advance(h * 3_600_000);
  }
}
