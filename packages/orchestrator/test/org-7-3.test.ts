// 7-3 GPT 개발자 (7장 "GPT 개발자의 쓰기 권한", 8장 동시 실행, 11장).
// Codex 쓰기는 개발자의 티켓 작업이 그 티켓 worktree에서 돌 때만. 네트워크는 끔. 나머지는 모두 읽기 전용.
// GPT 개발자의 코드는 개발팀장(Claude)이, 개발팀장의 코드는 리뷰어(GPT)가 본다. 로컬은 코드를 판정하지 않는다.
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { DevOutputSchema, GateOutputSchema, ReviewOutputSchema } from '@ai-office/shared';
import type { BrainRequest } from '../src/brains/brain.ts';
import { CODEX_NETWORK_OFF, CodexBrain, codexSandboxFor } from '../src/brains/codex.ts';
import { Lanes } from '../src/brains/lanes.ts';
import { planOutput } from '../src/brains/mock.ts';
import { DEFAULTS } from '../src/config.ts';
import { checkPlanRules, fixReviewers } from '../src/core/plans.ts';
import { employees } from '../src/db/schema.ts';
import { setup } from './helpers.ts';

const FAKES = fileURLToPath(new URL('./fakes/', import.meta.url));
const emp = (s: ReturnType<typeof setup>, id: string) => s.db.select().from(employees).where(eq(employees.id, id)).get()!;
const req = (s: ReturnType<typeof setup>, over: Partial<BrainRequest>): BrainRequest => ({
  employee: emp(s, 'dev-a'),
  task: 'work',
  schema: DevOutputSchema,
  input: {},
  prompt: { system: '# 역할 카드', user: '작업' },
  attempt: 1,
  signal: new AbortController().signal,
  ticketId: 'T-1',
  ...over,
});

describe('7-3 Codex 쓰기 권한은 코드가 정한다', () => {
  it('개발자 A의 T-1 작업이 wt\\T-1에서 돌 때만 쓰기, 나머지는 모두 읽기 전용', () => {
    const s = setup();
    const wt = s.config.paths.wt;
    const t1 = join(wt, 'T-1');
    expect(codexSandboxFor(req(s, { workdir: t1 }), wt)).toBe('workspace-write');
    // 일 종류가 작업이 아니면 읽기 전용
    for (const task of ['review', 'gate', 'meeting', 'retro', 'plan'] as const) expect(codexSandboxFor(req(s, { task, workdir: t1 }), wt)).toBe('read-only');
    // 개발자가 아니면 읽기 전용 (리뷰어가 work를 받아도)
    expect(codexSandboxFor(req(s, { employee: emp(s, 'reviewer'), workdir: t1 }), wt)).toBe('read-only');
    // 그 티켓의 worktree가 아니면 읽기 전용: 다른 티켓, 샌드박스, 실험 폴더, 작업 공간 루트, 상위 경로 장난
    expect(codexSandboxFor(req(s, { workdir: join(wt, 'T-2') }), wt)).toBe('read-only');
    expect(codexSandboxFor(req(s, { workdir: join(wt, '_sandbox', 'T-1') }), wt)).toBe('read-only');
    expect(codexSandboxFor(req(s, { workdir: join(wt, '_experiment', 'T-1') }), wt)).toBe('read-only');
    expect(codexSandboxFor(req(s, { workdir: wt }), wt)).toBe('read-only');
    expect(codexSandboxFor(req(s, { workdir: join(wt, 'T-1', '..', 'T-1', 'src') }), wt)).toBe('read-only');
    const { ticketId: _t, ...noTicket } = req(s, { workdir: t1 });
    expect(codexSandboxFor(noTicket, wt)).toBe('read-only');
    const { workdir: _w, ...noDir } = req(s, { workdir: t1 });
    expect(codexSandboxFor(noDir, wt)).toBe('read-only');
  });

  it('쓰기 모드에도 네트워크를 끄고, 쓰기 폴더 추가·샌드박스 끄기 옵션은 어디에도 없다', () => {
    const s = setup();
    const brain = new CodexBrain({ bin: 'codex', binArgs: [], timeoutMs: 1000, promptVia: 'stdin', wtRoot: s.config.paths.wt, dataDir: s.config.paths.data });
    const files = { schema: 's.json', lastMessage: 'l.json' };
    const write = brain.buildArgs('workspace-write', join(s.config.paths.wt, 'T-1'), files, 'p');
    expect(write.slice(write.indexOf('exec'), write.indexOf('exec') + 3)).toEqual(['exec', '--sandbox', 'workspace-write']);
    expect(write).toContain(CODEX_NETWORK_OFF);
    expect(CODEX_NETWORK_OFF).toBe('sandbox_workspace_write.network_access=false');
    const read = brain.buildArgs('read-only', join(s.config.paths.wt, '_sandbox', 'gate'), files, 'p');
    expect(read.slice(read.indexOf('exec'), read.indexOf('exec') + 3)).toEqual(['exec', '--sandbox', 'read-only']);
    for (const args of [write, read]) {
      expect(args).not.toContain('--add-dir');
      expect(args).not.toContain('danger-full-access');
      expect(args.join(' ')).not.toMatch(/dangerously|bypass/);
    }
    // 소스에도 그런 옵션이 없다
    const src = readFileSync(fileURLToPath(new URL('../src/brains/codex.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/--add-dir|danger-full-access|dangerously-bypass/);
  });

  it('가짜 Codex CLI로: 개발자 작업은 worktree에 파일을 쓰고, 리뷰·관문은 읽기 전용으로 돈다', async () => {
    const s = setup();
    const t1 = join(s.config.paths.wt, 'T-1');
    mkdirSync(t1, { recursive: true });
    const logFile = join(s.root, 'codex-log.jsonl');
    const brain = new CodexBrain({ bin: process.execPath, binArgs: [join(FAKES, 'fake-codex.mjs')], timeoutMs: 20_000, promptVia: 'stdin', wtRoot: s.config.paths.wt, dataDir: s.config.paths.data, extraEnv: { FAKE_LOG: logFile } });
    await brain.call(req(s, { workdir: t1 }));
    expect(existsSync(join(t1, 'feature.txt'))).toBe(true);
    await brain.call(req(s, { employee: emp(s, 'reviewer'), task: 'review', schema: ReviewOutputSchema, workdir: t1 }));
    const gateDir = join(s.config.paths.wt, '_sandbox', 'g');
    mkdirSync(gateDir, { recursive: true });
    await brain.call(req(s, { employee: emp(s, 'reviewer'), task: 'gate', schema: GateOutputSchema, workdir: gateDir }));
    const runs = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[] });
    expect(runs.map((r) => r.argv[r.argv.indexOf('--sandbox') + 1])).toEqual(['workspace-write', 'read-only', 'read-only']);
    expect(runs[0]!.argv).toContain(CODEX_NETWORK_OFF);
  });
});

describe('7-3 개발팀 구성과 검토 짝', () => {
  it('개발자 A·B는 Codex 개발자, 개발팀장은 Claude', () => {
    const s = setup();
    for (const id of ['dev-a', 'dev-b']) expect(emp(s, id)).toMatchObject({ role: 'developer', brain: { provider: 'codex' }, department: '개발팀', canSearchWeb: false });
    expect(emp(s, 'developer')).toMatchObject({ displayName: '개발팀장', brain: { provider: 'claude-code', budget: 'dev' } });
  });

  it('GPT 개발자의 코드는 개발팀장(Claude)이, 개발팀장의 코드는 리뷰어(GPT)가 본다', () => {
    const s = setup();
    const coding = (assignee: string, reviewer: string) => planOutput({ tickets: [{ ...planOutput().tickets[0]!, assignee, reviewer }] });
    expect(fixReviewers(s.ctx, coding('dev-a', 'reviewer')).out.tickets[0]!.reviewer).toBe('developer');
    expect(fixReviewers(s.ctx, coding('dev-b', 'dev-a')).out.tickets[0]!.reviewer).toBe('developer');
    expect(fixReviewers(s.ctx, coding('developer', 'strategy')).out.tickets[0]!.reviewer).toBe('reviewer');
    expect(checkPlanRules(s.ctx, coding('dev-a', 'developer'))).toEqual([]);
  });

  it('로컬 모델은 코드를 판정하지 않는다: 코딩 티켓의 로컬 검토자는 코드가 클라우드로 바꾸고, 그대로 오면 규칙 위반', () => {
    const s = setup();
    const coding = planOutput({ tickets: [{ ...planOutput().tickets[0]!, assignee: 'dev-a', reviewer: 'qa-local' }] });
    const fixed = fixReviewers(s.ctx, coding);
    expect(fixed.out.tickets[0]!.reviewer).toBe('developer');
    expect(fixed.changes[0]).toContain('로컬 모델은 코드를 검토하지 않음');
    expect(checkPlanRules(s.ctx, coding)).toEqual([expect.stringContaining('코드는 로컬 모델이 검토하지 않음')]);
  });
});

describe('7-3 동시 실행', () => {
  it('Codex는 두 작업까지 함께, Claude는 하나씩', async () => {
    expect(DEFAULTS.codex.concurrency).toBe(2);
    const lanes = new Lanes({ codex: 2 });
    const wait = () => new Promise((r) => setTimeout(r, 30));
    await Promise.all([1, 2, 3].map(() => lanes.run('codex', wait)));
    await Promise.all([1, 2].map(() => lanes.run('claude', wait)));
    expect(lanes.peak.get('codex')).toBe(2);
    expect(lanes.peak.get('claude')).toBe(1);
  });
});
