// 정기 점검 시각 (10장: 08:00, 18:00, 22:00, 주말 포함). 시각은 설정의 시간대(기본 Asia/Seoul)로 본다.
import type { Config } from '../config.ts';

export interface LocalTime {
  /** YYYY-MM-DD */
  date: string;
  minutes: number;
}

export function localTime(d: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * 지금 들어가 있는 점검 칸. 점검 시각부터 windowMin분 동안이다. 없으면 null.
 * 이름은 "2026-10-16 08:00" — 같은 칸을 두 번 처리하지 않는 열쇠로 쓴다.
 */
export function currentSlot(config: Config, now: Date, windowMin = config.schedule.checkWindowMin): string | null {
  const t = localTime(now, config.schedule.timezone);
  for (const hhmm of config.schedule.checkTimes) {
    const start = toMinutes(hhmm);
    if (t.minutes >= start && t.minutes < start + windowMin) return `${t.date} ${hhmm}`;
  }
  return null;
}

export function isInCheckWindow(config: Config, now: Date): boolean {
  return currentSlot(config, now) !== null;
}

/** 다음 점검 시각 표시용 (HH:MM) */
export function nextCheckTime(config: Config, now: Date): string {
  const t = localTime(now, config.schedule.timezone);
  const sorted = [...config.schedule.checkTimes].sort();
  return sorted.find((h) => toMinutes(h) > t.minutes) ?? sorted[0]!;
}
