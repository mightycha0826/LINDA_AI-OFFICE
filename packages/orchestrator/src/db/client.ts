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
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}
