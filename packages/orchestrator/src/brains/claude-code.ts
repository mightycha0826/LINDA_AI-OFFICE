// Claude Code 어댑터 (개발자, 경영전략 · 리서치). `claude -p`를 사람 개입 없이 돌린다 (6장, 0단계 #4).
// - 개발자 작업: 티켓 worktree 안에서만. 파일 수정·명령 실행 가능, git push·원격 조작은 거부.
// - 리서치: 빈 샌드박스에서 웹 검색·읽기 도구만 (15장: 웹을 읽는 직원에게 실행 권한 없음).
// - 그 밖(회의 발언 등): 읽기 전용.
// - 권한 설정과 역할 카드는 worktree 밖(paths.data)에 두고 --settings, --append-system-prompt-file로 넘긴다.
// - 묻는 창이 뜨면 아무도 답할 수 없으므로 --permission-prompts none으로 거부한다.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { devSettings, readonlySettings } from '../workspace/claude-settings.ts';
import { assertInside } from '../workspace/paths.ts';
import { BrainError, type Brain, type BrainRequest, type BrainResult } from './brain.ts';
import { classifyFailure, findResetTime, tail } from './classify.ts';
import { extractJson, toJsonSchema } from './json-schema.ts';
import { runProcess } from './process.ts';

export interface ClaudeCodeOptions {
  bin: string;
  binArgs: readonly string[];
  timeoutMs: number;
  maxTurns: number;
  wtRoot: string;
  dataDir: string;
  /** 테스트용 가짜 CLI 설정 등. 비밀로 보이는 이름은 거부된다 */
  extraEnv?: Record<string, string>;
}

export type ClaudeProfile = 'dev-work' | 'research' | 'readonly';

/** 직원과 작업에 따라 쓸 수 있는 도구가 정해진다. AI 출력으로 바뀌지 않는다. */
export const CLAUDE_PROFILES: Record<ClaudeProfile, { tools: string; permissionMode: string; settings: () => object }> = {
  'dev-work': { tools: 'Bash,Read,Edit,Write,Glob,Grep', permissionMode: 'acceptEdits', settings: devSettings },
  research: { tools: 'WebSearch,WebFetch', permissionMode: 'default', settings: readonlySettings },
  readonly: { tools: 'Read,Glob,Grep', permissionMode: 'default', settings: readonlySettings },
};

export function claudeProfileFor(req: BrainRequest): ClaudeProfile {
  const b = req.employee.brain;
  if (b.provider !== 'claude-code') throw new BrainError('crash', `${req.employee.id}은(는) Claude Code 직원이 아니에요`);
  if (req.task !== 'work') return 'readonly';
  return b.budget === 'research' && !req.employee.isTemporary ? 'research' : 'dev-work';
}

interface ClaudeJson {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

export class ClaudeCodeBrain implements Brain {
  private readonly o: ClaudeCodeOptions;

  constructor(o: ClaudeCodeOptions) {
    this.o = o;
  }

  /** 실행할 인자. 테스트에서 안전 규칙을 확인하려고 따로 꺼낸다. */
  buildArgs(profile: ClaudeProfile, files: { settings: string; systemPrompt: string }, schema: object): string[] {
    const p = CLAUDE_PROFILES[profile];
    return [
      ...this.o.binArgs,
      '-p',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(schema),
      '--tools', p.tools,
      '--permission-mode', p.permissionMode,
      '--permission-prompts', 'none',
      '--max-turns', String(this.o.maxTurns),
      '--no-session-persistence',
      '--settings', files.settings,
      '--append-system-prompt-file', files.systemPrompt,
    ];
  }

  async call(req: BrainRequest): Promise<BrainResult> {
    const profile = claudeProfileFor(req);
    const cwd = assertInside(this.o.wtRoot, req.workdir, `Claude Code(${req.employee.id})`);

    const runDir = join(this.o.dataDir, 'runs', `claude-${randomUUID()}`);
    mkdirSync(runDir, { recursive: true });
    const files = { settings: join(runDir, 'settings.json'), systemPrompt: join(runDir, 'role-card.md') };
    writeFileSync(files.settings, JSON.stringify(CLAUDE_PROFILES[profile].settings(), null, 2), 'utf8');
    writeFileSync(files.systemPrompt, req.prompt.system, 'utf8');

    try {
      const r = await runProcess({
        bin: this.o.bin,
        args: this.buildArgs(profile, files, toJsonSchema(req.schema)),
        cwd,
        stdin: req.prompt.user,
        timeoutMs: this.o.timeoutMs,
        signal: req.signal,
        ...(this.o.extraEnv ? { extraEnv: this.o.extraEnv } : {}),
      });
      if (r.aborted) throw new DOMException('정지됨', 'AbortError');
      if (r.timedOut) throw new BrainError('timeout', `Claude Code가 ${Math.round(this.o.timeoutMs / 60000)}분 안에 끝나지 않았어요`);
      if (r.spawnError) throw new BrainError('crash', `Claude Code를 실행하지 못했어요: ${r.spawnError}`);

      const parsed = extractJson(r.stdout);
      const json = parsed && typeof parsed === 'object' ? (parsed as ClaudeJson) : null;
      if (!json || json.is_error || r.code !== 0) {
        const text = `${json?.result ?? ''}\n${json?.subtype ?? ''}\n${r.stderr}\n${json ? '' : r.stdout}`;
        const failure = classifyFailure(text);
        throw new BrainError(failure, `Claude Code 실패(${json?.subtype ?? `종료 코드 ${r.code}`}): ${tail(text.trim())}`, failure === 'limit' ? findResetTime(text) : undefined);
      }
      const u = json.usage ?? {};
      return {
        output: json.structured_output ?? extractJson(json.result ?? ''),
        usage: {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
          // 토큰 수는 CLI가 알려준 값이지만 한도 %는 추정이다
          source: 'estimated',
        },
      };
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  }
}
