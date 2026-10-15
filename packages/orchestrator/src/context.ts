import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { OfficeEventType } from '@ai-office/shared';
import type { Clock } from './clock.ts';
import type { Config } from './config.ts';
import type { DbLike } from './db/client.ts';
import { events, systemState } from './db/schema.ts';

/** 핵심 함수가 받는 실행 맥락. db는 트랜잭션일 수도 있다. */
export interface Ctx {
  db: DbLike;
  config: Config;
  clock: Clock;
}

/**
 * 트랜잭션 안에서 실행한다. 이미 트랜잭션 안이면 savepoint로 중첩된다.
 * 상태 변경과 events 기록은 반드시 같은 inTx 안에서 한다 (4장 불변 조건).
 */
export function inTx<T>(c: Ctx, fn: (t: Ctx) => T): T {
  return c.db.transaction((tx) => fn({ ...c, db: tx }), { behavior: 'immediate' });
}

export function nowIso(c: Ctx): string {
  return c.clock.now().toISOString();
}

export function newId(): string {
  return randomUUID();
}

/** 'T-12' 같은 사람이 읽는 순번 ID. 트랜잭션 안에서 부른다. */
export function nextSeqId(c: Ctx, table: 'tickets' | 'orders' | 'plans', prefix: string): string {
  const row = c.db.get<{ n: number | null }>(
    sql`SELECT MAX(CAST(SUBSTR(id, ${prefix.length + 2}) AS INTEGER)) AS n FROM ${sql.identifier(table)} WHERE id LIKE ${prefix + '-%'}`,
  );
  return `${prefix}-${(row?.n ?? 0) + 1}`;
}

/** 화면용 이벤트를 남긴다. 추가만 가능하다(트리거로 강제). */
export function emit(c: Ctx, type: OfficeEventType, payload: unknown): number {
  const row = c.db.insert(events).values({ type, payload, createdAt: nowIso(c) }).returning({ seq: events.seq }).get();
  return row.seq;
}

export function getState<T>(c: Ctx, key: string, fallback: T): T {
  const row = c.db.select().from(systemState).where(eq(systemState.key, key)).get();
  return row ? (row.value as T) : fallback;
}

export function setState(c: Ctx, key: string, value: unknown): void {
  c.db.insert(systemState).values({ key, value }).onConflictDoUpdate({ target: systemState.key, set: { value } }).run();
}

export function isStopped(c: Ctx): boolean {
  return getState(c, 'stopped', false);
}

export function clearState(c: Ctx, key: string): void {
  c.db.delete(systemState).where(eq(systemState.key, key)).run();
}
