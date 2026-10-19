// Claude Code·Codex 공통 실행 도우미: 임시 폴더는 실패해도 지우고, 실패 종류는 출력으로 가린다.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrainError } from '../src/brains/brain.ts';
import { assertRan, cliFailure, withRunDir } from '../src/brains/cli-run.ts';
import type { RunResult } from '../src/brains/process.ts';

const ran = (over: Partial<RunResult> = {}): RunResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, aborted: false, durationMs: 1, ...over });

describe('withRunDir', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const dataDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'cli-run-'));
    dirs.push(d);
    return d;
  };

  it('호출이 끝나면 임시 폴더를 지운다', async () => {
    const data = dataDir();
    let seen = '';
    const out = await withRunDir(data, 'claude', async (dir) => {
      seen = dir;
      expect(existsSync(dir)).toBe(true);
      return 7;
    });
    expect(out).toBe(7);
    expect(seen).toContain(join(data, 'runs', 'claude-'));
    expect(readdirSync(join(data, 'runs'))).toEqual([]);
  });

  it('실패해도 임시 폴더(역할 카드·권한 설정)를 남기지 않는다', async () => {
    const data = dataDir();
    await expect(withRunDir(data, 'codex', async () => Promise.reject(new BrainError('crash', 'x')))).rejects.toThrow(BrainError);
    expect(readdirSync(join(data, 'runs'))).toEqual([]);
  });
});

describe('assertRan', () => {
  it('정지는 AbortError, 시간 초과는 timeout, 실행 실패는 crash', () => {
    expect(() => assertRan(ran({ aborted: true }), 'Codex', 60_000)).toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect(() => assertRan(ran({ timedOut: true }), 'Codex', 120_000)).toThrow(expect.objectContaining({ failure: 'timeout', message: 'Codex가 2분 안에 끝나지 않았어요' }));
    expect(() => assertRan(ran({ spawnError: 'ENOENT' }), 'Claude Code', 60_000)).toThrow(expect.objectContaining({ failure: 'crash' }));
    expect(() => assertRan(ran({ code: 1 }), 'Codex', 60_000)).not.toThrow(); // 종료 코드 해석은 어댑터 몫
  });
});

describe('cliFailure', () => {
  it('한도 도달이면 초기화 시각을 붙인다', () => {
    const err = cliFailure('usage limit reached, resets at 2026-10-20T03:00:00Z', 'm');
    expect(err).toMatchObject({ failure: 'limit', message: 'm', resetsAt: '2026-10-20T03:00:00.000Z' });
  });

  it('인터넷 끊김과 그 밖의 실패를 가린다', () => {
    expect(cliFailure('getaddrinfo ENOTFOUND api.anthropic.com', 'm')).toMatchObject({ failure: 'offline', resetsAt: undefined });
    expect(cliFailure('something odd', 'm').failure).toBe('crash');
  });
});
