import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.ts';

export type Schema = typeof schema;
export type Db = BetterSQLite3Database<Schema> & { $client: Database.Database };
/** 데이터베이스 또는 트랜잭션. 핵심 함수는 둘 다 받는다. */
export type DbLike = BaseSQLiteDatabase<'sync', Database.RunResult, Schema>;

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * SQLite를 열고 마이그레이션을 적용한다. 파일 DB는 WAL 모드(3장).
 * ':memory:'는 테스트와 시뮬레이션용.
 */
export function openDb(path: string): Db {
  const sqlite = new Database(path);
  if (path !== ':memory:') sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  // 표를 다시 만드는 마이그레이션(CHECK 바꾸기, 예: 0008)은 외래 키를 잠시 꺼야 한다.
  // 마이그레이션은 트랜잭션 안에서 돌아 그 안의 PRAGMA foreign_keys는 효과가 없으므로 밖에서 끄고 켠다.
  // 켠 뒤 외래 키 검사로 깨진 참조가 하나라도 있으면 시작하지 않는다.
  sqlite.pragma('foreign_keys = OFF');
  migrate(db, { migrationsFolder: MIGRATIONS });
  sqlite.pragma('foreign_keys = ON');
  const broken = sqlite.pragma('foreign_key_check') as unknown[];
  if (broken.length) throw new Error(`마이그레이션 뒤 외래 키 참조가 깨졌어요: ${JSON.stringify(broken.slice(0, 5))}`);
  return db;
}
