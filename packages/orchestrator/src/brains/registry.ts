// 직원 → 두뇌 연결. 직원의 brain 설정(4장)으로 어댑터를 고른다.
// 리서치 몫이 소진된 경영전략은 로컬 Qwen으로 바꿔 쓴다 (8장).
import { LOCAL_MODEL } from '@ai-office/shared';
import type { Config } from '../config.ts';
import type { EmployeeRow } from '../core/budget.ts';
import { BrainError, type Brain } from './brain.ts';
import { ClaudeCodeBrain } from './claude-code.ts';
import { CodexBrain } from './codex.ts';
import { GpuQueue } from './gpu-queue.ts';
import { OllamaBrain } from './ollama.ts';

export type BrainFor = (employee: EmployeeRow, opts: { lowPrecision: boolean }) => Brain;

export interface RegistryOptions {
  onModelSwitch?: (from: string | null, to: string) => void;
  /** 테스트에서 가짜 CLI에 넘길 환경 변수 */
  extraEnv?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export function createBrainRegistry(config: Config, opts: RegistryOptions = {}): { brainFor: BrainFor; queue: GpuQueue } {
  const queue = new GpuQueue({ maxWaitMs: config.ollama.maxWaitSec * 1000, ...(opts.onModelSwitch ? { onModelSwitch: opts.onModelSwitch } : {}) });
  const env = opts.extraEnv ? { extraEnv: opts.extraEnv } : {};
  const ollama = new OllamaBrain({
    host: config.ollama.host,
    numCtx: config.ollama.numCtx,
    timeoutMs: config.ollama.timeoutSec * 1000,
    keepAlive: config.ollama.keepAlive,
    queue,
    fallbackModel: LOCAL_MODEL,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const claude = new ClaudeCodeBrain({
    bin: config.claude.bin,
    binArgs: config.claude.binArgs,
    timeoutMs: config.claude.timeoutMin * 60_000,
    maxTurns: config.claude.maxTurns,
    wtRoot: config.paths.wt,
    dataDir: config.paths.data,
    ...(config.claude.model ? { model: config.claude.model } : {}),
    ...(config.claude.effort ? { effort: config.claude.effort } : {}),
    ...env,
  });
  const codex = new CodexBrain({
    bin: config.codex.bin,
    binArgs: config.codex.binArgs,
    timeoutMs: config.codex.timeoutMin * 60_000,
    promptVia: config.codex.promptVia,
    wtRoot: config.paths.wt,
    dataDir: config.paths.data,
    home: config.codex.home,
    ...(config.codex.model ? { model: config.codex.model } : {}),
    ...env,
  });

  const brainFor: BrainFor = (e, { lowPrecision }) => {
    if (lowPrecision) return ollama;
    switch (e.brain.provider) {
      case 'ollama':
        return ollama;
      case 'claude-code':
        return claude;
      case 'codex':
        return codex;
      case 'none':
        throw new BrainError('crash', `${e.id}은(는) AI 직원이 아니에요`);
    }
  };
  return { brainFor, queue };
}
