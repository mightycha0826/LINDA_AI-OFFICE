// Codex 어댑터 (리뷰어 · 감사관). 항상 읽기 전용 샌드박스로 돌린다 (6장, 7장 권한 분리, 0단계 #6).
// 샌드박스 모드는 상수다. 설정이나 AI 출력으로 바꿀 길을 만들지 않는다.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertInside } from '../workspace/paths.ts';
import { BrainError, type Brain, type BrainRequest, type BrainResult } from './brain.ts';
import { classifyFailure, findResetTime, tail } from './classify.ts';
import { dropNullOptionals, extractJson, toJsonSchema, toStrictJsonSchema } from './json-schema.ts';
import { runProcess } from './process.ts';

export const CODEX_SANDBOX = 'read-only' as const;

export interface CodexOptions {
  bin: string;
  binArgs: readonly string[];
  timeoutMs: number;
  promptVia: 'stdin' | 'arg';
  wtRoot: string;
  dataDir: string;
  extraEnv?: Record<string, string>;
}

/** --json 이벤트 줄에서 토큰 사용량을 찾는다. 형식이 문서에 없어 알려진 자리를 넓게 본다. */
export function findCodexUsage(jsonl: string): { input: number; output: number } | null {
  let found: { input: number; output: number } | null = null;
  for (const line of jsonl.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    const candidates = [
      ev.usage,
      (ev.msg as Record<string, unknown> | undefined)?.info && ((ev.msg as Record<string, unknown>).info as Record<string, unknown>).total_token_usage,
      (ev.info as Record<string, unknown> | undefined)?.total_token_usage,
    ];
    for (const c of candidates) {
      if (c && typeof c === 'object' && 'input_tokens' in c) {
        const u = c as { input_tokens?: number; output_tokens?: number };
        found = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
      }
    }
  }
  return found;
}

export class CodexBrain implements Brain {
  private readonly o: CodexOptions;

  constructor(o: CodexOptions) {
    this.o = o;
  }

  buildArgs(workdir: string, files: { schema: string; lastMessage: string }, prompt: string): string[] {
    return [
      ...this.o.binArgs,
      'exec',
      '--sandbox', CODEX_SANDBOX,
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '-C', workdir,
      '--output-schema', files.schema,
      '-o', files.lastMessage,
      this.o.promptVia === 'stdin' ? '-' : prompt,
    ];
  }

  async call(req: BrainRequest): Promise<BrainResult> {
    if (req.employee.brain.provider !== 'codex') throw new BrainError('crash', `${req.employee.id}은(는) Codex 직원이 아니에요`);
    const cwd = assertInside(this.o.wtRoot, req.workdir, `Codex(${req.employee.id})`);
    const schema = toJsonSchema(req.schema);

    const runDir = join(this.o.dataDir, 'runs', `codex-${randomUUID()}`);
    mkdirSync(runDir, { recursive: true });
    const files = { schema: join(runDir, 'schema.json'), lastMessage: join(runDir, 'last.json') };
    writeFileSync(files.schema, JSON.stringify(toStrictJsonSchema(schema)), 'utf8');
    // Codex에는 시스템 프롬프트 옵션이 없어 역할 카드를 앞에 붙인다
    const prompt = `${req.prompt.system}\n\n---\n\n${req.prompt.user}`;

    try {
      const r = await runProcess({
        bin: this.o.bin,
        args: this.buildArgs(cwd, files, prompt),
        cwd,
        ...(this.o.promptVia === 'stdin' ? { stdin: prompt } : {}),
        timeoutMs: this.o.timeoutMs,
        signal: req.signal,
        ...(this.o.extraEnv ? { extraEnv: this.o.extraEnv } : {}),
      });
      if (r.aborted) throw new DOMException('정지됨', 'AbortError');
      if (r.timedOut) throw new BrainError('timeout', `Codex가 ${Math.round(this.o.timeoutMs / 60000)}분 안에 끝나지 않았어요`);
      if (r.spawnError) throw new BrainError('crash', `Codex를 실행하지 못했어요: ${r.spawnError}`);

      const last = existsSync(files.lastMessage) ? readFileSync(files.lastMessage, 'utf8') : '';
      if (r.code !== 0 || !last.trim()) {
        const text = `${r.stderr}\n${tail(r.stdout, 2000)}`;
        const failure = classifyFailure(text);
        throw new BrainError(failure, `Codex 실패(종료 코드 ${r.code}): ${tail(text.trim())}`, failure === 'limit' ? findResetTime(text) : undefined);
      }
      const usage = findCodexUsage(r.stdout);
      return {
        output: dropNullOptionals(extractJson(last), schema),
        usage: {
          // 사용량 이벤트가 없으면 글자 수로 어림잡는다 (한국어·영어 섞임, 약 3자 = 1토큰)
          inputTokens: usage?.input ?? Math.ceil(prompt.length / 3),
          outputTokens: usage?.output ?? Math.ceil(last.length / 3),
          source: 'estimated',
        },
      };
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  }
}
