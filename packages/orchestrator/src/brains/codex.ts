// Codex 어댑터 (리뷰어 · 감사관, 7-3부터 개발자 A·B). 기본은 읽기 전용 샌드박스다 (6장, 7장 권한 분리, 0단계 #6).
// 쓰기(workspace-write)는 개발자의 티켓 작업이 그 티켓 worktree에서 돌 때만 codexSandboxFor가 준다(7장 7-3).
// 판단 근거는 직원·일 종류·폴더뿐이다. 설정이나 AI 출력으로 바꿀 길을 만들지 않는다. 쓰기 모드에서도 네트워크는 끈다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertInside, worktreePathFor } from '../workspace/paths.ts';
import { BrainError, type Brain, type BrainRequest, type BrainResult } from './brain.ts';
import { tail } from './classify.ts';
import { assertRan, cliFailure, withRunDir } from './cli-run.ts';
import { dropNullOptionals, extractJson, toJsonSchema, toStrictJsonSchema } from './json-schema.ts';
import { runProcess } from './process.ts';

export const CODEX_SANDBOX = 'read-only' as const;
export const CODEX_WRITE_SANDBOX = 'workspace-write' as const;
export type CodexSandbox = typeof CODEX_SANDBOX | typeof CODEX_WRITE_SANDBOX;
/** 쓰기 모드에서도 네트워크 없음 (7장 7-3). 푸시·패키지 설치·외부 전송을 샌드박스가 막는다 */
export const CODEX_NETWORK_OFF = 'sandbox_workspace_write.network_access=false';

/**
 * Codex 샌드박스 모드 (7장 7-3). 쓰기는 다음을 모두 만족할 때만:
 * 상시 직원이고 역할이 개발자, 일이 티켓 작업(work), 작업 폴더가 정확히 그 티켓의 worktree(<wt>\T-n).
 * 하나라도 아니면 읽기 전용이다. 샌드박스·실험 폴더·다른 티켓·하위 폴더는 모두 읽기 전용.
 */
export function codexSandboxFor(req: Pick<BrainRequest, 'employee' | 'task' | 'workdir' | 'ticketId'>, wtRoot: string): CodexSandbox {
  if (req.task !== 'work' || req.employee.role !== 'developer' || req.employee.isTemporary) return CODEX_SANDBOX;
  if (!req.ticketId || !req.workdir) return CODEX_SANDBOX;
  let expected: string;
  try {
    expected = worktreePathFor(wtRoot, req.ticketId);
  } catch {
    return CODEX_SANDBOX;
  }
  const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return norm(req.workdir) === norm(expected) ? CODEX_WRITE_SANDBOX : CODEX_SANDBOX;
}

export interface CodexOptions {
  bin: string;
  binArgs: readonly string[];
  timeoutMs: number;
  promptVia: 'stdin' | 'arg';
  wtRoot: string;
  dataDir: string;
  /** 회사 전용 CODEX_HOME (주인의 Codex 앱 설정과 분리) */
  home?: string;
  /** 비우면 계정 기본 모델 */
  model?: string;
  extraEnv?: Record<string, string>;
}

/**
 * 기본 스킬·플러그인 끄기 (0단계 #6, codex-cli 0.163.0).
 * 로그인하면 Codex가 skills\.system과 원격 플러그인 캐시를 스스로 깔고 프롬프트에
 * <skills_instructions>, <recommended_plugins>를 붙인다. `codex debug prompt-input`으로 이 키들이 둘 다 없앰을 확인했다.
 * 설정 파일과 상관없이 지키려고 실행할 때 -c로도 넘긴다.
 */
export const CODEX_ISOLATION_OVERRIDES: readonly string[] = [
  'skills.bundled.enabled=false',
  'skills.include_instructions=false',
  'features.plugins=false',
  'features.remote_plugin=false',
  'features.apps=false',
  'features.tool_suggest=false',
];

const CODEX_HOME_HEADER = '# AI 사무실 전용 Codex 설정 (오케스트레이터가 만듦).';

/** 회사 전용 Codex 설정. 플러그인·MCP 서버·기본 스킬·모델 지정 없이 시작한다 */
export const CODEX_HOME_CONFIG = `${CODEX_HOME_HEADER}
# 주인의 Codex 앱 설정(~/.codex)과 섞이지 않게 따로 둔다. 플러그인과 MCP 서버를 넣지 않는다.
# 로그인: PowerShell에서 \$env:CODEX_HOME = '<이 폴더>'; codex login
[windows]
sandbox = "elevated"

# Codex가 스스로 까는 기본 스킬과 원격(추천) 플러그인을 프롬프트에 넣지 않는다
[features]
plugins = false
remote_plugin = false
apps = false
tool_suggest = false

[skills]
include_instructions = false

[skills.bundled]
enabled = false
`;

/** 작업 폴더 안내. 명령의 현재 폴더를 믿지 말고 이 절대 경로로 파일을 읽게 한다 */
export function codexWorkdirNote(cwd: string, sandbox: CodexSandbox = CODEX_SANDBOX): string {
  const base = `## 작업 폴더\n\n${cwd}\n\n파일은 반드시 이 절대 경로를 붙여서 읽는다(예: ${cwd}\\src\\app.ts). 명령이 도는 현재 폴더는 이 폴더가 아닐 수 있다.`;
  if (sandbox !== CODEX_WRITE_SANDBOX) return base;
  // 쓰기 모드 (7장 7-3): .git은 worktree 밖이라 쓸 수 없고, 네트워크도 없다
  return `${base}\n\n이 폴더 안에서만 파일을 만들고 고친다. 커밋은 하지 않는다(Git 고양이가 모아 커밋한다). 네트워크가 꺼져 있어 패키지 설치와 외부 접속은 할 수 없다. 외부 패키지 없이 돌아가게 만든다.`;
}

/** 없으면 만들고, 오케스트레이터가 만든 예전 설정이면 새 내용으로 바꾼다. 주인이 직접 쓴 설정(머리줄 없음)은 건드리지 않는다 */
export function ensureCodexHome(home: string): void {
  mkdirSync(home, { recursive: true });
  const cfg = join(home, 'config.toml');
  if (!existsSync(cfg)) {
    writeFileSync(cfg, CODEX_HOME_CONFIG, 'utf8');
    return;
  }
  const cur = readFileSync(cfg, 'utf8').replace(/\r\n/g, '\n');
  if (cur.startsWith(CODEX_HOME_HEADER) && cur !== CODEX_HOME_CONFIG) writeFileSync(cfg, CODEX_HOME_CONFIG, 'utf8');
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

  buildArgs(sandbox: CodexSandbox, workdir: string, files: { schema: string; lastMessage: string }, prompt: string): string[] {
    return [
      ...this.o.binArgs,
      'exec',
      '--sandbox', sandbox,
      ...(sandbox === CODEX_WRITE_SANDBOX ? ['-c', CODEX_NETWORK_OFF] : []),
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      ...CODEX_ISOLATION_OVERRIDES.flatMap((kv) => ['-c', kv]),
      ...(this.o.model ? ['-m', this.o.model] : []),
      '-C', workdir,
      '--output-schema', files.schema,
      '-o', files.lastMessage,
      this.o.promptVia === 'stdin' ? '-' : prompt,
    ];
  }

  async call(req: BrainRequest): Promise<BrainResult> {
    if (req.employee.brain.provider !== 'codex') throw new BrainError('crash', `${req.employee.id}은(는) Codex 직원이 아니에요`);
    const cwd = assertInside(this.o.wtRoot, req.workdir, `Codex(${req.employee.id})`);
    const sandbox = codexSandboxFor(req, this.o.wtRoot);
    const schema = toJsonSchema(req.schema);

    // Codex에는 시스템 프롬프트 옵션이 없어 역할 카드를 앞에 붙인다.
    // Windows 샌드박스에서는 -C 폴더가 아니라 C:\에서 명령이 돈다(0단계 #6). 작업 폴더를 절대 경로로 알려 준다.
    const prompt = `${req.prompt.system}\n\n---\n\n${codexWorkdirNote(cwd, sandbox)}\n\n${req.prompt.user}`;

    if (this.o.home) ensureCodexHome(this.o.home);
    const env = { ...(this.o.home ? { CODEX_HOME: this.o.home } : {}), ...this.o.extraEnv };
    return withRunDir(this.o.dataDir, 'codex', async (runDir) => {
      const files = { schema: join(runDir, 'schema.json'), lastMessage: join(runDir, 'last.json') };
      writeFileSync(files.schema, JSON.stringify(toStrictJsonSchema(schema)), 'utf8');

      const r = await runProcess({
        bin: this.o.bin,
        args: this.buildArgs(sandbox, cwd, files, prompt),
        cwd,
        ...(this.o.promptVia === 'stdin' ? { stdin: prompt } : {}),
        timeoutMs: this.o.timeoutMs,
        signal: req.signal,
        ...(Object.keys(env).length ? { extraEnv: env } : {}),
      });
      assertRan(r, 'Codex', this.o.timeoutMs);

      const last = existsSync(files.lastMessage) ? readFileSync(files.lastMessage, 'utf8') : '';
      if (r.code !== 0 || !last.trim()) {
        const text = `${r.stderr}\n${tail(r.stdout, 2000)}`;
        throw cliFailure(text, `Codex 실패(종료 코드 ${r.code}): ${tail(text.trim())}`);
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
    });
  }
}
