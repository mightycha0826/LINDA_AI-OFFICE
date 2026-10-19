// 2단계 어댑터 안전 규칙: 가짜 claude·codex CLI와 가짜 Ollama로 확인한다.
import { eq } from 'drizzle-orm';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DevOutputSchema, GateOutputSchema, ReviewOutputSchema, DocOutputSchema } from '@ai-office/shared';
import { BrainError, type BrainRequest } from '../src/brains/brain.ts';
import { ClaudeCodeBrain } from '../src/brains/claude-code.ts';
import { CODEX_SANDBOX, CodexBrain } from '../src/brains/codex.ts';
import { GpuQueue } from '../src/brains/gpu-queue.ts';
import { OllamaBrain } from '../src/brains/ollama.ts';
import { safeEnv } from '../src/brains/process.ts';
import { claudeDeny } from '../src/workspace/claude-settings.ts';
import { employees } from '../src/db/schema.ts';
import { OfficeError } from '../src/errors.ts';
import { startFakeOllama } from './fakes/fake-ollama.ts';
import { setup } from './helpers.ts';

const FAKES = fileURLToPath(new URL('./fakes/', import.meta.url));
const node = process.execPath;

function env(s: ReturnType<typeof setup>, mode = 'ok', extra: Record<string, string> = {}) {
  const logFile = join(s.root, 'fake-log.jsonl');
  return { logFile, extraEnv: { FAKE_LOG: logFile, FAKE_MODE: mode, ...extra } };
}
function readLog(file: string): Record<string, unknown>[] {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
function emp(s: ReturnType<typeof setup>, id: string) {
  return s.db.select().from(employees).where(eq(employees.id, id)).get()!;
}
function dir(s: ReturnType<typeof setup>, name: string) {
  const d = join(s.config.paths.wt, name);
  mkdirSync(d, { recursive: true });
  return d;
}
function request(s: ReturnType<typeof setup>, over: Partial<BrainRequest> & Pick<BrainRequest, 'employee' | 'task' | 'schema'>): BrainRequest {
  return {
    input: {},
    prompt: { system: '# 역할 카드\n시스템 프롬프트', user: '## 티켓 T-1 · 기능\n\n### 완료 조건 (이것으로만 판정한다)\n\n1. 단위 테스트 통과' },
    attempt: 1,
    signal: new AbortController().signal,
    ...over,
  };
}
function claude(s: ReturnType<typeof setup>, extraEnv: Record<string, string>, timeoutMs = 20_000) {
  return new ClaudeCodeBrain({ bin: node, binArgs: [join(FAKES, 'fake-claude.mjs')], timeoutMs, maxTurns: 40, wtRoot: s.config.paths.wt, dataDir: s.config.paths.data, extraEnv });
}
function codex(s: ReturnType<typeof setup>, extraEnv: Record<string, string>) {
  return new CodexBrain({ bin: node, binArgs: [join(FAKES, 'fake-codex.mjs')], timeoutMs: 20_000, promptVia: 'stdin', wtRoot: s.config.paths.wt, dataDir: s.config.paths.data, extraEnv });
}

const SECRETS = { GITHUB_TOKEN: 'ghp_secret', ANTHROPIC_API_KEY: 'sk-ant-secret', OPENAI_API_KEY: 'sk-secret', MY_PASSWORD: 'x' };
afterEach(() => {
  for (const k of Object.keys(SECRETS)) delete process.env[k];
});

describe('자식 프로세스 환경 변수', () => {
  it('허용 목록만 넘기고, 비밀은 이름만 봐도 뺀다. git 자격 증명 도우미는 끈다', () => {
    const e = safeEnv({}, { PATH: 'p', SystemRoot: 'C:\\Windows', GITHUB_TOKEN: 't', GH_TOKEN: 't', OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', RANDOM_VAR: 'r' });
    expect(Object.keys(e).sort()).toEqual(['GCM_INTERACTIVE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_TERMINAL_PROMPT', 'PATH', 'SystemRoot']);
    expect(e).toMatchObject({ GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_TERMINAL_PROMPT: '0' });
  });

  it('비밀로 보이는 이름을 일부러 넘기려 해도 거부한다', () => {
    expect(() => safeEnv({ GITHUB_TOKEN: 'x' })).toThrow(/비밀/);
  });
});

describe('Claude Code 어댑터', () => {
  it('개발자 작업: worktree에서, push 거부 설정과 함께, 묻지 않고 거부 모드로 실행한다', async () => {
    Object.assign(process.env, SECRETS);
    const s = setup();
    const { logFile, extraEnv } = env(s);
    const wt = dir(s, 'T-1');
    const res = await claude(s, extraEnv).call(request(s, { employee: emp(s, 'developer'), task: 'work', schema: DevOutputSchema, workdir: wt }));

    const [run] = readLog(logFile) as { argv: string[]; cwd: string; envKeys: string[]; stdin: string; settings: { permissions: { deny: string[] } }; systemPrompt: string; gitHelper: string[] }[];
    expect(run!.cwd.toLowerCase()).toBe(wt.toLowerCase());
    expect(run!.argv).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', '--no-session-persistence']));
    expect(run!.argv[run!.argv.indexOf('--tools') + 1]).toBe('Bash,Read,Edit,Write,Glob,Grep');
    expect(run!.settings.permissions.deny).toEqual(expect.arrayContaining(['Bash(git push)', 'Bash(git push *)', 'Bash(gh *)', 'Edit(.claude/**)']));
    expect(run!.settings.permissions.deny).toEqual(claudeDeny(s.config.paths.data));
    // 데이터 폴더(secrets.json 등) 읽기도 거부한다 (7장 비밀 파일 읽기)
    expect(run!.settings.permissions.deny).toEqual(expect.arrayContaining(['Bash(*secrets.json*)']));
    expect(run!.settings.permissions.deny.some((r) => r.startsWith('Read(//') && r.endsWith('/**)'))).toBe(true);
    // 설정 파일과 역할 카드는 worktree 밖(data)에 있다
    const settingsPath = run!.argv[run!.argv.indexOf('--settings') + 1]!;
    expect(settingsPath.startsWith(s.config.paths.data)).toBe(true);
    expect(run!.systemPrompt).toContain('# 역할 카드');
    expect(run!.stdin).toContain('단위 테스트 통과');
    // 비밀 환경 변수는 넘어가지 않는다
    for (const k of Object.keys(SECRETS)) expect(run!.envKeys).not.toContain(k);
    expect(run!.gitHelper).toEqual(['credential.helper', '']);
    // 실행 뒤 설정·프롬프트 임시 파일은 지운다
    expect(existsSync(settingsPath)).toBe(false);

    expect(DevOutputSchema.parse(res.output).changedFiles).toEqual(['feature.txt']);
    expect(res.usage).toMatchObject({ inputTokens: 1700, outputTokens: 300, source: 'estimated' });
    expect(existsSync(join(wt, 'feature.txt'))).toBe(true);
  });

  it('리서치: 웹 검색·읽기 도구만, 빈 샌드박스에서', async () => {
    const s = setup();
    const { logFile, extraEnv } = env(s);
    // 7-4부터 전략가는 GPT라, Claude 리서치 프로필은 기획실장(Claude, 리서치 몫)으로 본다
    await claude(s, extraEnv).call(request(s, { employee: emp(s, 'pm'), task: 'work', schema: DocOutputSchema, workdir: dir(s, '_sandbox/T-2') }));
    const [run] = readLog(logFile) as { argv: string[]; settings: { permissions: { deny: string[] } } }[];
    expect(run!.argv[run!.argv.indexOf('--tools') + 1]).toBe('WebSearch,WebFetch');
    expect(run!.settings.permissions.deny).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write']));
  });

  it('회의 발언처럼 작업이 아니면 읽기 전용 도구만', async () => {
    const s = setup();
    const { logFile, extraEnv } = env(s);
    await claude(s, extraEnv).call(request(s, { employee: emp(s, 'developer'), task: 'meeting', schema: GateOutputSchema, workdir: dir(s, 'T-3') }));
    const [run] = readLog(logFile) as { argv: string[] }[];
    expect(run!.argv[run!.argv.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
  });

  it('작업 공간 밖이나 작업 공간 자체에서는 실행하지 않는다', async () => {
    const s = setup();
    const { logFile, extraEnv } = env(s);
    const brain = claude(s, extraEnv);
    for (const workdir of [s.root, s.config.paths.wt, join(s.config.paths.wt, '..', 'repos'), undefined]) {
      await expect(brain.call(request(s, { employee: emp(s, 'developer'), task: 'work', schema: DevOutputSchema, ...(workdir ? { workdir } : {}) }))).rejects.toThrow(OfficeError);
    }
    expect(readLog(logFile)).toHaveLength(0);
  });

  it('실패 종류를 가린다: 한도 도달(초기화 시각 포함), 인터넷 끊김, 비정상 종료, 시간 초과', async () => {
    const s = setup();
    const wt = dir(s, 'T-4');
    const call = (mode: string, timeoutMs?: number) =>
      claude(s, env(s, mode).extraEnv, timeoutMs).call(request(s, { employee: emp(s, 'developer'), task: 'work', schema: DevOutputSchema, workdir: wt }));
    await expect(call('limit')).rejects.toMatchObject({ failure: 'limit', resetsAt: '2026-10-15T15:00:00.000Z' });
    await expect(call('offline')).rejects.toMatchObject({ failure: 'offline' });
    await expect(call('crash')).rejects.toMatchObject({ failure: 'crash' });
    await expect(call('slow', 1500)).rejects.toMatchObject({ failure: 'timeout' });
  });

  it('/정지 신호가 오면 실행 중인 CLI를 끝낸다', async () => {
    const s = setup();
    const ac = new AbortController();
    const started = Date.now();
    const p = claude(s, env(s, 'slow').extraEnv).call(request(s, { employee: emp(s, 'developer'), task: 'work', schema: DevOutputSchema, workdir: dir(s, 'T-5'), signal: ac.signal }));
    setTimeout(() => ac.abort(), 500);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('Codex 어댑터', () => {
  it('항상 읽기 전용 샌드박스. 다른 모드를 넘길 길이 없다', async () => {
    Object.assign(process.env, SECRETS);
    const s = setup();
    const { logFile, extraEnv } = env(s);
    const wt = dir(s, 'T-1');
    const res = await codex(s, extraEnv).call(request(s, { employee: emp(s, 'reviewer'), task: 'review', schema: ReviewOutputSchema, workdir: wt }));
    const [run] = readLog(logFile) as { argv: string[]; cwd: string; envKeys: string[]; stdin: string; schema: Record<string, unknown> }[];

    expect(CODEX_SANDBOX).toBe('read-only');
    expect(run!.argv.slice(run!.argv.indexOf('exec'), run!.argv.indexOf('exec') + 3)).toEqual(['exec', '--sandbox', 'read-only']);
    expect(run!.argv.join(' ')).not.toMatch(/workspace-write|danger|yolo|bypass|full-auto/);
    expect(run!.cwd.toLowerCase()).toBe(wt.toLowerCase());
    for (const k of Object.keys(SECRETS)) expect(run!.envKeys).not.toContain(k);
    // 역할 카드와 작업이 stdin으로 같이 간다
    expect(run!.stdin).toContain('# 역할 카드');
    expect(run!.stdin).toContain('단위 테스트 통과');
    // 엄격 모드 스키마: 모든 속성 required, 추가 속성 금지
    expect(run!.schema).toMatchObject({ additionalProperties: false, required: ['verdict', 'criteria', 'reasonCategory', 'fixRequests'] });

    // 엄격 모드가 채운 null은 지워져 Zod 검사를 통과한다
    expect(ReviewOutputSchema.parse(res.output)).toEqual({ verdict: 'pass', criteria: [{ criterion: '단위 테스트 통과', pass: true }], fixRequests: [] });
    expect(res.usage).toMatchObject({ inputTokens: 900, outputTokens: 120 });
  });

  it('실패 종류를 가린다', async () => {
    const s = setup();
    const wt = dir(s, 'T-2');
    const call = (mode: string) => codex(s, env(s, mode).extraEnv).call(request(s, { employee: emp(s, 'reviewer'), task: 'gate', schema: GateOutputSchema, workdir: wt }));
    await expect(call('limit')).rejects.toMatchObject({ failure: 'limit' });
    await expect(call('offline')).rejects.toMatchObject({ failure: 'offline' });
    await expect(call('crash')).rejects.toBeInstanceOf(BrainError);
  });

  it('작업 공간 밖에서는 실행하지 않는다', async () => {
    const s = setup();
    const { logFile, extraEnv } = env(s);
    await expect(codex(s, extraEnv).call(request(s, { employee: emp(s, 'reviewer'), task: 'gate', schema: GateOutputSchema, workdir: s.root }))).rejects.toThrow(/작업 공간/);
    expect(readLog(logFile)).toHaveLength(0);
  });
});

describe('Ollama 어댑터', () => {
  it('JSON 스키마로 구조화 출력을 강제하고, 생각 모드를 끄고, 역할 카드를 system으로 보낸다', async () => {
    const s = setup();
    const fake = await startFakeOllama();
    try {
      const brain = new OllamaBrain({ host: fake.host, numCtx: 8192, timeoutMs: 5000, keepAlive: '30m', queue: new GpuQueue({ maxWaitMs: 60_000 }) });
      const res = await brain.call(request(s, { employee: emp(s, 'qa-local'), task: 'review', schema: ReviewOutputSchema }));
      const body = fake.calls[0]!.body as { model: string; format: Record<string, unknown>; think: boolean; stream: boolean; messages: { role: string; content: string }[]; options: { num_ctx: number } };
      expect(body).toMatchObject({ model: 'gemma4:12b-64k', think: false, stream: false, options: { num_ctx: 8192 } });
      expect(body.format).toMatchObject({ type: 'object', required: ['verdict', 'criteria', 'fixRequests'] });
      expect(body.messages[0]).toEqual({ role: 'system', content: '# 역할 카드\n시스템 프롬프트' });
      expect(ReviewOutputSchema.parse(res.output).verdict).toBe('pass');
      expect(res.usage).toEqual({ inputTokens: 800, outputTokens: 200, source: 'reported', estimatedPct: 0, estimatedWeeklyPct: 0 });
    } finally {
      await fake.close();
    }
  });

  it('리서치 몫 소진 때는 Claude 직원도 로컬(7-2부터 Gemma 64K)로 처리한다', async () => {
    const s = setup();
    const fake = await startFakeOllama();
    try {
      const brain = new OllamaBrain({ host: fake.host, numCtx: 8192, timeoutMs: 5000, keepAlive: '30m', queue: new GpuQueue({ maxWaitMs: 60_000 }) });
      await brain.call(request(s, { employee: emp(s, 'strategy'), task: 'work', schema: DocOutputSchema, lowPrecision: true }));
      expect(fake.calls[0]!.model).toBe('gemma4:12b-64k');
    } finally {
      await fake.close();
    }
  });

  it('```json 블록으로 감싼 답도 꺼낸다', async () => {
    const s = setup();
    const fake = await startFakeOllama({ reply: () => '결과는 이렇습니다\n```json\n{"passed": true, "issues": [], "objection": null}\n```' });
    try {
      const brain = new OllamaBrain({ host: fake.host, numCtx: 8192, timeoutMs: 5000, keepAlive: '30m', queue: new GpuQueue({ maxWaitMs: 60_000 }) });
      const res = await brain.call(request(s, { employee: emp(s, 'qa-local'), task: 'gate', schema: GateOutputSchema }));
      expect(res.output).toEqual({ passed: true, issues: [], objection: null });
    } finally {
      await fake.close();
    }
  });

  it('Ollama가 꺼져 있으면 인터넷 끊김이 아니라 비정상(crash)으로 본다', async () => {
    const s = setup();
    const brain = new OllamaBrain({ host: 'http://127.0.0.1:1', numCtx: 8192, timeoutMs: 3000, keepAlive: '30m', queue: new GpuQueue({ maxWaitMs: 60_000 }) });
    await expect(brain.call(request(s, { employee: emp(s, 'qa-local'), task: 'gate', schema: GateOutputSchema }))).rejects.toMatchObject({ failure: 'crash' });
  });

  it('응답이 늦으면 시간 초과', async () => {
    const s = setup();
    const fake = await startFakeOllama({ delayMs: 2000 });
    try {
      const brain = new OllamaBrain({ host: fake.host, numCtx: 8192, timeoutMs: 300, keepAlive: '30m', queue: new GpuQueue({ maxWaitMs: 60_000 }) });
      await expect(brain.call(request(s, { employee: emp(s, 'qa-local'), task: 'gate', schema: GateOutputSchema }))).rejects.toMatchObject({ failure: 'timeout' });
    } finally {
      await fake.close();
    }
  });
});

describe('GPU 대기열', () => {
  const job = (ms = 20) => () => new Promise<void>((r) => setTimeout(r, ms));

  it('지금 올라간 모델의 요청을 먼저 처리해 교체를 줄인다', async () => {
    const q = new GpuQueue({ maxWaitMs: 60_000 });
    const all = [q.enqueue('qwen3:14b', job()), q.enqueue('gemma4:12b', job()), q.enqueue('qwen3:14b', job()), q.enqueue('gemma4:12b', job()), q.enqueue('qwen3:14b', job())];
    await Promise.all(all);
    expect(q.history).toEqual(['qwen3:14b', 'qwen3:14b', 'qwen3:14b', 'gemma4:12b', 'gemma4:12b']);
  });

  it('오래 기다린 요청은 모델이 달라도 먼저 (굶지 않게)', async () => {
    let now = 0;
    let release!: () => void;
    const q = new GpuQueue({ maxWaitMs: 100, now: () => now });
    const first = q.enqueue('qwen3:14b', () => new Promise<void>((r) => (release = r)));
    const g = q.enqueue('gemma4:12b', job(1));
    const q2 = q.enqueue('qwen3:14b', job(1));
    now = 1000; // 첫 작업이 오래 걸리는 동안 gemma 요청이 오래 기다렸다
    release();
    await Promise.all([first, g, q2]);
    expect(q.history).toEqual(['qwen3:14b', 'gemma4:12b', 'qwen3:14b']);
  });

  it('한 번에 하나씩만 돈다', async () => {
    const q = new GpuQueue({ maxWaitMs: 60_000 });
    let running = 0;
    let peak = 0;
    const tracked = () => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
    };
    await Promise.all(Array.from({ length: 6 }, (_, i) => q.enqueue(i % 2 ? 'qwen3:14b' : 'gemma4:12b', tracked())));
    expect(peak).toBe(1);
  });

  it('대기 중에 /정지되면 실행하지 않고 빠진다', async () => {
    const q = new GpuQueue({ maxWaitMs: 60_000 });
    const ac = new AbortController();
    let ran = false;
    const blocker = q.enqueue('qwen3:14b', job(50));
    const queued = q.enqueue('gemma4:12b', async () => void (ran = true), ac.signal);
    ac.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await blocker;
    expect(ran).toBe(false);
  });
});

