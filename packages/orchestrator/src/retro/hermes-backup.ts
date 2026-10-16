// 비서실장(헤르메스) 기억·스킬 폴더 매일 백업 (14장 7). 보고는 하지 않는다.
// 헤르메스의 자체 학습은 전부 허용하되, 이상한 방향으로 배우면 며칠 전 상태로 되돌릴 수 있게 한다.
// 백업: <backupDir>/<YYYY-MM-DD>/<폴더>. keepDays보다 오래된 것은 지운다(백업 폴더 안에서만).
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from '../config.ts';
import { localTime } from '../discord/schedule.ts';
import { isInside } from '../workspace/paths.ts';

export interface BackupResult {
  date: string;
  copied: string[];
  skipped: 'no-home' | 'already' | null;
  pruned: string[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function backupHermes(config: Config, now: Date): BackupResult {
  const { homeDir, folders, backupDir, keepDays } = config.hermes;
  const date = localTime(now, config.schedule.timezone).date;
  const result: BackupResult = { date, copied: [], skipped: null, pruned: [] };
  if (!homeDir || !existsSync(homeDir)) return { ...result, skipped: 'no-home' };
  const dest = join(backupDir, date);
  if (existsSync(dest)) result.skipped = 'already';
  else {
    const tmp = `${dest}.partial`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    for (const f of folders) {
      const src = resolve(homeDir, f);
      if (!isInside(resolve(homeDir), src) || !existsSync(src)) continue;
      cpSync(src, join(tmp, f), { recursive: true, dereference: false, verbatimSymlinks: true });
      result.copied.push(f);
    }
    // 다 복사한 뒤에 이름을 바꿔서, 반쯤 된 백업이 그날 백업으로 남지 않게 한다
    renameSync(tmp, dest);
  }
  // 오래된 백업 정리
  const cutoff = new Date(`${date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - keepDays);
  const limit = cutoff.toISOString().slice(0, 10);
  for (const name of existsSync(backupDir) ? readdirSync(backupDir) : []) {
    const p = join(backupDir, name);
    if (DAY.test(name) && name < limit && statSync(p).isDirectory() && isInside(resolve(backupDir), resolve(p))) {
      rmSync(p, { recursive: true, force: true });
      result.pruned.push(name);
    }
  }
  return result;
}

export function listHermesBackups(config: Config): string[] {
  const dir = config.hermes.backupDir;
  return existsSync(dir) ? readdirSync(dir).filter((n) => DAY.test(n)).sort() : [];
}

/**
 * 백업으로 되돌린다(주인이 직접 실행: npm run hermes:restore -- 2026-10-15).
 * 되돌리기 전 지금 상태를 <날짜>-before-restore-<시각>으로 한 번 더 남긴다. 헤르메스는 꺼 둔 상태에서 실행한다.
 */
export function restoreHermes(config: Config, date: string, now = new Date()): string[] {
  if (!DAY.test(date)) throw new Error(`날짜 형식이 아니에요: ${date}`);
  const { homeDir, folders, backupDir } = config.hermes;
  const src = join(backupDir, date);
  if (!homeDir || !existsSync(src)) throw new Error(`백업이 없어요: ${src}`);
  const keep = join(backupDir, `${date}-before-restore-${now.getTime()}`);
  const restored: string[] = [];
  for (const f of folders) {
    const from = join(src, f);
    const to = resolve(homeDir, f);
    if (!existsSync(from) || !isInside(resolve(homeDir), to)) continue;
    if (existsSync(to)) cpSync(to, join(keep, f), { recursive: true });
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
    restored.push(f);
  }
  return restored;
}
