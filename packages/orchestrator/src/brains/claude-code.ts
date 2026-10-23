// Claude Code 어댑터 (개발자, 경영전략 · 리서치). `claude -p`를 사람 개입 없이 돌린다 (6장, 0단계 #4).
// - 개발자 작업: 티켓 worktree 안에서만. 파일 수정·명령 실행 가능, git push·원격 조작은 거부.
// - 리서치: 빈 샌드박스에서 웹 검색·읽기 도구만 (15장: 웹을 읽는 직원에게 실행 권한 없음).
// - 그 밖(회의 발언 등): 읽기 전용.
// - 권한 설정과 역할 카드는 worktree 밖(paths.data)에 두고 --settings, --append-system-prompt-file로 넘긴다.
// - 묻는 창이 뜨면 아무도 답할 수 없으므로 --permission-prompts none으로 거부한다.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { devSettings, readonlySettings } from '../workspace/claude-settings.ts';
import { assertInside } from '../workspace/paths.ts';
import { BrainError, type AccountUsage, type Brain, type BrainRequest, type BrainResult } from './brain.ts';
import { tail } from './classify.ts';
import { assertRan, cliFailure, withRunDir } from './cli-run.ts';
import { extractJson, toJsonSchema } from './json-schema.ts';
import { runProcess } from './process.ts';

export interface ClaudeCodeOptions {
  bin: string;
  binArgs: readonly string[];
  timeoutMs: number;
  maxTurns: number | null;
  wtRoot: string;
  dataDir: string;
  /** 비우면 계정 기본 모델 */
  model?: string;
  /** --effort (low…max). 비우면 CLI 기본 */
  effort?: string;
  /** 테스트용 가짜 CLI 설정 등. 비밀로 보이는 이름은 거부된다 */
  extraEnv?: Record<string, string>;
}

export type ClaudeProfile = 'dev-work' | 'research' | 'readonly';

/** 직원과 작업에 따라 쓸 수 있는 도구가 정해진다. AI 출력으로 바뀌지 않는다. */
export const CLAUDE_PROFILES: Record<ClaudeProfile, { tools: string; permissionMode: string; settings: (dataDir: string) => object }> = {
  'dev-work': { tools: 'Bash,Read,Edit,Write,Glob,Grep', permissionMode: 'acceptEdits', settings: devSettings },
  research: { tools: 'WebSearch,WebFetch', permissionMode: 'default', settings: readonlySettings },
  readonly: { tools: 'Read,Glob,Grep', permissionMode: 'default', settings: readonlySettings },
};

export function claudeProfileFor(req: BrainRequest): ClaudeProfile {
  const b = req.employee.brain;
  if (b.provider !== 'claude-code') throw new BrainError('crash', `${req.employee.id}은(는) Claude Code 직원이 아니에요`);
  // 파일을 고치는 일은 티켓 작업과 병합 담당의 통합 브랜치 충돌 풀기(11장, 2026-10-23)뿐이다
  if (req.task !== 'work' && req.task !== 'merge') return 'readonly';
  // 임시 직원은 파일 수정·명령 실행 권한이 없다 (2장, 7장). 검색이 허락된 종류만 웹을 읽는다.
  if (req.employee.isTemporary) return req.employee.canSearchWeb ? 'research' : 'readonly';
  return b.budget === 'research' ? 'research' : 'dev-work';
}

/**
 * stream-json 출력에서 최종 결과와 계정 사용률(rate_limit_event)을 꺼낸다.
 * 줄 단위 JSON이 아니면(예전 json 출력) 통째로 결과로 본다.
 */
export function parseClaudeStream(stdout: string): { result: ClaudeJson | null; account: AccountUsage | null } {
  let result: ClaudeJson | null = null;
  let account: AccountUsage | null = null;
  let sawLine = false;
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    sawLine = true;
    if (ev.type === 'result') result = ev as ClaudeJson;
    if (ev.type === 'rate_limit_event') {
      const info = (ev.rate_limit_info ?? {}) as { status?: string; unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> };
      const w = info.unifiedWindows ?? {};
      const pct = (x?: { utilization?: number }) => (typeof x?.utilization === 'number' ? Math.round(x.utilization * 1000) / 10 : null);
      const at = (x?: { resetsAt?: number }) => (typeof x?.resetsAt === 'number' ? new Date(x.resetsAt * 1000).toISOString() : null);
      account = { provider: 'claude', fiveHourPct: pct(w.five_hour), weeklyPct: pct(w.seven_day), fiveHourResetsAt: at(w.five_hour), weeklyResetsAt: at(w.seven_day), status: info.status ?? null };
    }
  }
  // 줄 단위 JSON이 하나도 없을 때만(여러 줄로 펼친 JSON 등) 통째로 읽는다.
  // 줄은 있는데 result가 없으면 실패다. 다른 이벤트(system 등)를 결과로 착각하지 않는다.
  if (!sawLine) {
    const parsed = extractJson(stdout);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) result = parsed as ClaudeJson;
  }
  return { result, account };
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
      // stream-json이어야 계정 사용률(rate_limit_event)이 함께 온다 (0단계 #5)
      '--output-format', 'stream-json',
      '--verbose',
      '--json-schema', JSON.stringify(schema),
      '--tools', p.tools,
      '--permission-mode', p.permissionMode,
      '--permission-prompts', 'none',
      ...(this.o.maxTurns === null ? [] : ['--max-turns', String(this.o.maxTurns)]),
      '--no-session-persistence',
      // 주인 개인 설정(플러그인, 스킬, MCP 서버, 훅)을 물려받지 않는다. 권한은 아래 --settings와 worktree의 프로젝트 설정만 (0단계 #5)
      '--setting-sources', 'project,local',
      '--strict-mcp-config',
      '--disable-slash-commands',
      ...(this.o.model ? ['--model', this.o.model] : []),
      ...(this.o.effort ? ['--effort', this.o.effort] : []),
      '--settings', files.settings,
      '--append-system-prompt-file', files.systemPrompt,
    ];
  }

  async call(req: BrainRequest): Promise<BrainResult> {
    const profile = claudeProfileFor(req);
    const cwd = assertInside(this.o.wtRoot, req.workdir, `Claude Code(${req.employee.id})`);

    return withRunDir(this.o.dataDir, 'claude', async (runDir) => {
      const files = { settings: join(runDir, 'settings.json'), systemPrompt: join(runDir, 'role-card.md') };
      writeFileSync(files.settings, JSON.stringify(CLAUDE_PROFILES[profile].settings(this.o.dataDir), null, 2), 'utf8');
      writeFileSync(files.systemPrompt, req.prompt.system, 'utf8');

      const r = await runProcess({
        bin: this.o.bin,
        args: this.buildArgs(profile, files, toJsonSchema(req.schema)),
        cwd,
        stdin: req.prompt.user,
        timeoutMs: this.o.timeoutMs,
        signal: req.signal,
        ...(this.o.extraEnv ? { extraEnv: this.o.extraEnv } : {}),
      });
      assertRan(r, 'Claude Code', this.o.timeoutMs);

      const { result: json, account } = parseClaudeStream(r.stdout);
      if (!json || json.is_error || r.code !== 0) {
        const text = `${json?.result ?? ''}\n${json?.subtype ?? ''}\n${r.stderr}\n${json ? '' : r.stdout}`;
        throw cliFailure(text, `Claude Code 실패(${json?.subtype ?? `종료 코드 ${r.code}`}): ${tail(text.trim())}`);
      }
      const u = json.usage ?? {};
      return {
        output: json.structured_output ?? extractJson(json.result ?? ''),
        usage: {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
          // 토큰 수는 CLI가 알려준 값이지만 회사 몫 %는 추정이다. 계정 전체 %는 따로 실측으로 붙인다
          source: 'estimated',
          ...(account ? { account } : {}),
        },
      };
    });
  }
}
