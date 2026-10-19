// Claude Code·Codex 어댑터가 함께 쓰는 실행 도우미.
// - 호출마다 paths.data 아래에 임시 폴더를 만들고, 끝나면 성공·실패와 상관없이 지운다.
// - 정지·시간 초과·실행 실패는 두 CLI가 같은 방식으로 알린다.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BrainError } from './brain.ts';
import { classifyFailure, findResetTime } from './classify.ts';
import type { RunResult } from './process.ts';

export async function withRunDir<T>(dataDir: string, prefix: string, fn: (runDir: string) => Promise<T>): Promise<T> {
  const runDir = join(dataDir, 'runs', `${prefix}-${randomUUID()}`);
  mkdirSync(runDir, { recursive: true });
  try {
    return await fn(runDir);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

/** 프로세스가 끝까지 돌지 못했으면 알맞은 오류를 던진다. 종료 코드와 출력 해석은 어댑터 몫이다. */
export function assertRan(r: RunResult, name: string, timeoutMs: number): void {
  if (r.aborted) throw new DOMException('정지됨', 'AbortError');
  if (r.timedOut) throw new BrainError('timeout', `${name}가 ${Math.round(timeoutMs / 60000)}분 안에 끝나지 않았어요`);
  if (r.spawnError) throw new BrainError('crash', `${name}를 실행하지 못했어요: ${r.spawnError}`);
}

/** CLI 출력(text)으로 실패 종류를 가린 오류. 한도 도달이면 초기화 시각도 붙인다. */
export function cliFailure(text: string, message: string): BrainError {
  const failure = classifyFailure(text);
  return new BrainError(failure, message, failure === 'limit' ? findResetTime(text) : undefined);
}
