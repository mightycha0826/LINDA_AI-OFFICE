// 실제 어댑터 + 가짜 claude·codex CLI + 가짜 Ollama + 실제 git으로 지시 하나를 끝까지 돌린다.
// 0단계 뒤 `npm run smoke`가 같은 흐름을 진짜 두뇌로 돈다.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { planOutput } from '../src/brains/mock.ts';
import { createBrainRegistry } from '../src/brains/registry.ts';
import { FakeClock } from '../src/clock.ts';
import { makeConfig } from '../src/config.ts';
import { Connectivity } from '../src/connectivity.ts';
import type { Ctx } from '../src/context.ts';
import { openDb } from '../src/db/client.ts';
import { tickets, usage } from '../src/db/schema.ts';
import { Engine } from '../src/engine.ts';
import { seedStaff } from '../src/seed.ts';
import { registerProject } from '../src/workspace/projects.ts';
import { ProjectTestRunner } from '../src/workspace/test-runner.ts';
import { GitWorkspace } from '../src/workspace/worktrees.ts';
import { outputFor } from './fakes/fake-common.mjs';
import { startFakeOllama } from './fakes/fake-ollama.ts';
import { CEO, pendingPlanApproval, tempRoot } from './helpers.ts';

const FAKES = fileURLToPath(new URL('./fakes/', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('가짜 CLI로 끝까지', () => {
  it('지시 → 기획실장(Claude, 샌드박스) → 관문(Codex) → CEO 승인 → 개발자(Claude, worktree) → 테스트 → 리뷰(Codex) → 완료', async () => {
    const root = tempRoot();
    const repo = join(root, 'repos', 'demo');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@localhost');
    git(repo, 'config', 'user.name', 'test');
    git(repo, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(repo, 'check.js'), "process.exit(require('fs').existsSync('feature.txt') ? 0 : 1);\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');

    const fakeOllama = await startFakeOllama({
      reply: (body) => {
        const format = body.format as { properties?: Record<string, unknown> };
        if (format.properties?.goal) return planOutput({ goal: '기능 파일 추가', tickets: [{ ...planOutput().tickets[0]!, title: 'feature file', acceptanceCriteria: ['check.js 테스트 통과'] }] });
        const user = (body.messages as { role: string; content: string }[]).find((m) => m.role === 'user')!.content;
        return outputFor(format, user);
      },
    });
    try {
      const logFile = join(root, 'fake-log.jsonl');
      const config = makeConfig({
        ceoDiscordId: CEO,
        paths: { wt: join(root, 'wt'), data: join(root, 'data'), repos: join(root, 'repos') },
        ollama: { host: fakeOllama.host },
        claude: { bin: process.execPath, binArgs: [join(FAKES, 'fake-claude.mjs')] },
        // 진짜 회사 CODEX_HOME(C:\ai-office\data\codex-home)을 건드리지 않게 임시 폴더를 쓴다
        codex: { bin: process.execPath, binArgs: [join(FAKES, 'fake-codex.mjs')], home: join(root, 'codex-home') },
      });
      const ctx: Ctx = { db: openDb(':memory:'), config, clock: new FakeClock() };
      seedStaff(ctx);
      registerProject(ctx, { id: 'demo', repoUrl: 'https://github.com/owner/demo.git', localPath: repo, testCommand: 'node check.js' });
      const { brainFor, queue } = createBrainRegistry(config, { extraEnv: { FAKE_LOG: logFile } });
      const engine = new Engine({ ctx, brainFor, tests: new ProjectTestRunner(ctx), workspace: new GitWorkspace(ctx), connectivity: new Connectivity(ctx, async () => true) });

      engine.submitOrder({ discordMessageId: '1300000000000000001', rawText: '기능 파일을 하나 추가해줘' });
      await engine.runUntilIdle();
      const approval = pendingPlanApproval({ db: ctx.db } as never)!;
      expect(approval).toBeDefined();
      engine.decide({ approvalId: approval.id, discordUserId: CEO, decision: 'approved' });
      await engine.runUntilIdle();

      const [tk] = ctx.db.select().from(tickets).all();
      expect(tk).toMatchObject({ status: 'done', branch: 'feature/T1-feature-file' });
      const wt = join(config.paths.wt, 'T-1');
      expect(existsSync(join(wt, 'feature.txt'))).toBe(true);

      const runs = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { bin: string; argv: string[]; cwd: string });
      const claudeRuns = runs.filter((r) => r.bin === 'claude');
      expect(claudeRuns).toHaveLength(2); // 계획 1 + 구현 1
      expect(claudeRuns[0]!.cwd.toLowerCase()).toContain('_sandbox'); // 계획은 빈 샌드박스에서 읽기 전용
      expect(claudeRuns[0]!.argv).toContain('Read,Glob,Grep');
      const claudeRun = claudeRuns[1]!;
      const codexRuns = runs.filter((r) => r.bin === 'codex');
      expect(claudeRun.cwd.toLowerCase()).toBe(wt.toLowerCase());
      expect(codexRuns).toHaveLength(2); // 관문 1 + 리뷰 1
      expect(codexRuns[0]!.cwd.toLowerCase()).toContain('_sandbox');
      expect(codexRuns[1]!.cwd.toLowerCase()).toBe(wt.toLowerCase());
      expect(codexRuns.every((r) => r.argv.includes('read-only'))).toBe(true);

      // 사용량: Claude·GPT는 토큰으로 추정한 %, 로컬은 0
      const rows = ctx.db.select().from(usage).all();
      expect(rows.find((r) => r.budget === 'dev')!.estimatedPct).toBeGreaterThan(0);
      expect(rows.find((r) => r.budget === 'review')!.estimatedPct).toBeGreaterThan(0);
      expect(rows.filter((r) => r.budget === 'local').every((r) => r.estimatedPct === 0)).toBe(true);
      expect(rows.find((r) => r.budget === 'research')!.estimatedPct).toBeGreaterThan(0); // 기획 몫
      expect(queue.history).toEqual([]); // 로컬 모델은 이 흐름에서 쓰지 않는다
    } finally {
      await fakeOllama.close();
    }
  }, 60_000);
});
