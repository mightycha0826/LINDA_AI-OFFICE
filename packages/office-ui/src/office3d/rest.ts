import type { ScreenTicket } from '@ai-office/shared';
import type { Seat } from './layout.ts';

export type RestKind = 'coffee' | 'read' | 'stretch' | 'relax';
export interface RestProfile { kind: RestKind; side: 0 | 1; pace: number; color: number }
export interface RestContext { now: string; nextReport: string; timezone: string; clock?: number }
export const REST_LABEL: Record<RestKind, string> = { coffee: '커피 휴식', read: '독서 휴식', stretch: '스트레칭', relax: '벤치 휴식' };

/** Each character keeps their own break habit, hand, rhythm and mug color. */
export const REST_PROFILES: Readonly<Record<string, RestProfile>> = {
  'chief-of-staff': { kind: 'coffee', side: 1, pace: 0.85, color: 0x5a6a90 },
  pm: { kind: 'coffee', side: 0, pace: 1.05, color: 0xb09bc5 },
  developer: { kind: 'coffee', side: 0, pace: 0.95, color: 0x7c9da6 },
  'dev-a': { kind: 'stretch', side: 1, pace: 1.1, color: 0x9fbaa7 },
  'dev-b': { kind: 'read', side: 0, pace: 0.8, color: 0x7d91ae },
  reviewer: { kind: 'read', side: 1, pace: 0.9, color: 0x937e9e },
  'qa-local': { kind: 'relax', side: 1, pace: 0.95, color: 0x779e96 },
  strategy: { kind: 'read', side: 0, pace: 0.7, color: 0x819e95 },
  marketing: { kind: 'stretch', side: 0, pace: 0.85, color: 0xc49c83 },
  'diff-summarizer': { kind: 'relax', side: 0, pace: 1.1, color: 0x9eacbf },
  'retro-scribe': { kind: 'read', side: 1, pace: 1.1, color: 0xb3a4c6 },
  explainer: { kind: 'coffee', side: 1, pace: 1.15, color: 0xb5a482 },
  briefer: { kind: 'relax', side: 1, pace: 0.8, color: 0x8aa8b7 },
  drafter: { kind: 'read', side: 0, pace: 1.05, color: 0xc19eaa },
  interpreter: { kind: 'coffee', side: 0, pace: 0.75, color: 0x9d86b8 },
  'commit-scribe': { kind: 'stretch', side: 1, pace: 1.2, color: 0x9ba779 },
};
export function restProfile(id: string): RestProfile {
  return REST_PROFILES[id] ?? { kind: 'relax', side: 0, pace: 1, color: 0x8a9a95 };
}

export interface RestSeat extends Seat { zone: 'coffee' | 'lounge' | 'bench' }
export const REST_SEATS: readonly RestSeat[] = [
  ...[12, 13.2, 14.4].map(x => ({ x, z: 9.35, face: -1 as const, seatY: 0.62, zone: 'coffee' as const })),
  ...[17.3, 18.4, 19.5].flatMap(x => [
    // Sit near the front edge of the deep sofa so shins stay outside its cushion.
    { x, z: 8.35, face: 1 as const, seatY: 0.42, zone: 'lounge' as const },
    { x, z: 10.15, face: -1 as const, seatY: 0.42, zone: 'lounge' as const },
  ]),
  ...[20.85, 21.7].flatMap(x => [
    { x, z: 8.25, face: 1 as const, seatY: 0.46, zone: 'bench' as const },
    { x, z: 10.35, face: -1 as const, seatY: 0.46, zone: 'bench' as const },
  ]),
  ...[18, 18.8, 19.6].map(x => ({ x, z: 18.2, face: -1 as const, seatY: 0.46, zone: 'bench' as const })),
  { x: 27.9, z: 13.45, face: 1, zone: 'coffee' },
  { x: 27.9, z: 14.95, face: -1, zone: 'coffee' },
];

/** nextReport is a local HH:mm; anchor it to the server snapshot to handle midnight and stale clocks. */
export function reportWaitMs(context: RestContext): number {
  const stamp = Date.parse(context.now), match = /^(\d{2}):(\d{2})$/.exec(context.nextReport);
  if (!Number.isFinite(stamp) || !match || Number(match[1]) > 23 || Number(match[2]) > 59) return -1;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: context.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(stamp);
    const part = (name: string) => Number(parts.find(p => p.type === name)?.value ?? 0);
    const local = (part('hour') * 3600 + part('minute') * 60 + part('second')) * 1000 + stamp % 1000;
    const target = (Number(match[1]) * 60 + Number(match[2])) * 60_000;
    return (target - local + 86_400_000) % 86_400_000 - Math.max(0, (context.clock ?? stamp) - stamp);
  } catch { return -1; }
}

/** Pause a reviewer only when their review stage was actually interrupted. Other live work wins. */
export function canRest(id: string, tickets: readonly ScreenTicket[], context?: RestContext): boolean {
  if (!context || reportWaitMs(context) < 3_600_000) return false;
  const active = tickets.some(t =>
    (t.status === 'meeting' && (t.assigneeId === id || t.reviewerId === id)) ||
    ((t.status === 'in_progress' || t.status === 'rework' || t.status === 'blocked') && t.assigneeId === id) ||
    (t.status === 'in_review' && t.reviewerId === id));
  return !active && tickets.some(t => t.status === 'paused' && (t.pauseReason === 'cap' || t.pauseReason === 'budget') &&
    (t.pausedFrom === 'in_review' ? t.reviewerId === id : t.assigneeId === id));
}

const smooth = (a: number, b: number, t: number) => { const u = Math.max(0, Math.min(1, (t - a) / (b - a))); return u * u * (3 - 2 * u); };
export interface RestMotion { arms: [number, number]; wrists: [number, number]; headX: number; headY: number; torso: number; sip: number }
/** Shared pose curves for procedural figures and imported VRM characters. */
export function restMotion(profile: RestProfile, time: number, phase: number, motion: number): RestMotion {
  const t = motion ? time * profile.pace + phase * 3 : 0;
  const cycle = t % 18;
  const sip = (smooth(2, 4, cycle) - smooth(7, 9, cycle)) * motion;
  const breathe = Math.sin(t * 0.8) * 0.018 * motion;
  const pose: RestMotion = { arms: [0.6, 0.6], wrists: [0, 0], headX: 0.03, headY: Math.sin(t * 0.32) * 0.16 * motion, torso: breathe, sip: 0 };
  if (profile.kind === 'coffee') {
    pose.arms[profile.side] = 0.12 - sip * 1.22;
    pose.wrists[profile.side] = profile.side === 0 ? -0.55 : 0.55;
    pose.headX = -sip * 0.08; pose.sip = sip;
  }
  if (profile.kind === 'read') { pose.arms = [0.24 + breathe, 0.24 - breathe]; pose.headX = 0.2; pose.headY *= 0.2; }
  if (profile.kind === 'stretch') {
    const lift = (0.5 + 0.5 * Math.sin(t * 0.5)) * motion;
    pose.arms = [0.35 - lift * 1.85, 0.35 - lift * 1.75];
    pose.wrists = [Math.sin(t * 1.1) * 0.3 * motion, -Math.sin(t * 1.1) * 0.3 * motion];
    pose.headX = -lift * 0.08;
  }
  return pose;
}
