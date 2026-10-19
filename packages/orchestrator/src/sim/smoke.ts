// npm run smoke — 실제 두뇌(Ollama, Claude Code, Codex)로 연결을 확인한다. 0단계 #2·#4·#5·#6 통과 뒤에 돌린다.
//
//   npm run smoke -- [--config C:\ai-office\data\config.json] [--only ollama|claude|codex] [--flow]
//
// 기본: 두뇌마다 작은 구조화 호출 한 번씩 (Claude·GPT 한도를 조금 쓴다).
// --flow: 임시 저장소(repos\smoke-<시각>, worktree는 wt\_smoke\<시각>)를 만들어 지시 하나를 끝까지 돌린다. 계획서 결재는 이 스크립트가 CEO 대신 누른다(시험용).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createBrainRegistry } from '../brains/registry.ts';
import type { BrainRequest } from '../brains/brain.ts';
import { systemClock } from '../clock.ts';
import { DEFAULTS, loadConfig, type Config } from '../config.ts';
import { Connectivity } from '../connectivity.ts';
import { emit, type Ctx } from '../context.ts';
import { pendingApprovals } from '../core/approvals.ts';
import { openDb } from '../db/client.ts';
import { employees, tickets, usage } from '../db/schema.ts';
import { Engine } from '../engine.ts';
import { seedStaff } from '../seed.ts';
import { roleCard } from '../staff/role-cards.ts';
import { sandboxDir } from '../workspace/paths.ts';
import { registerProject } from '../workspace/projects.ts';
import { ProjectTestRunner } from '../workspace/test-runner.ts';
import { GitWorkspace } from '../workspace/worktrees.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const configPath = opt('config') ?? join(DEFAULTS.paths.data, 'config.json');
const only = opt('only');
const flow = args.includes('--flow');
const say = (s: string) => console.log(s);

if (!existsSync(configPath)) {
  say(`설정 파일이 없어요: ${configPath}`);
  say('docs/config.example.json을 복사해 ceoDiscordId만 채운 뒤 다시 실행해 주세요.');
  // process.exit()는 파이프 출력이 다 나가기 전에 끝낼 수 있어 throw로 멈춘다
  process.exitCode = 1;
  throw new Error('설정 파일 없음');
}
const loaded: Config = loadConfig(configPath);
// 시험 티켓(T-1…)의 worktree는 진짜 사무실과 겹치지 않게 <wt>\_smoke\<시각> 아래에 둔다
const runStamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const config: Config = { ...loaded, paths: { ...loaded.paths, wt: join(loaded.paths.wt, '_smoke', runStamp) } };
const ctx: Ctx = { db: openDb(':memory:'), config, clock: systemClock };
seedStaff(ctx);
const { brainFor, queue } = createBrainRegistry(config, { onModelSwitch: (from, to) => emit(ctx, 'model.loaded', { from, to }) });
const emp = (id: string) => ctx.db.select().from(employees).all().find((e) => e.id === id)!;

const PingSchema = z.object({ ok: z.boolean(), sum: z.number(), word: z.string() });

async function ping(label: string, employeeId: string, task: BrainRequest['task'], workdir?: string): Promise<boolean> {
  const e = emp(employeeId);
  const started = Date.now();
  try {
    const res = await brainFor(e, { lowPrecision: false }).call({
      employee: e,
      task,
      schema: PingSchema,
      input: {},
      prompt: { system: roleCard(ctx, e, task, PingSchema), user: '연결 확인이에요. ok는 true, sum은 2+3, word는 "사무실"로 답해 주세요.' },
      attempt: 1,
      signal: new AbortController().signal,
      ...(workdir ? { workdir } : {}),
    });
    const parsed = PingSchema.safeParse(res.output);
    const good = parsed.success && parsed.data.ok && parsed.data.sum === 5;
    say(`${good ? '[통과]' : '[실패]'} ${label}: ${((Date.now() - started) / 1000).toFixed(1)}초, 토큰 ${res.usage.inputTokens}+${res.usage.outputTokens}, 출력 ${JSON.stringify(res.output).slice(0, 120)}`);
    return good;
  } catch (err) {
    say(`[실패] ${label}: ${(err as Error).message}`);
    return false;
  }
}

async function pings(): Promise<boolean> {
  const results: boolean[] = [];
  const sandbox = sandboxDir(config.paths.wt, 'smoke');
  if (!only || only === 'ollama') {
    results.push(await ping('Ollama · Qwen3-14B (PM)', 'pm', 'gate'));
    results.push(await ping('Ollama · Gemma 4 12B (검토 담당)', 'qa-local', 'gate'));
    results.push(await ping('Ollama · 다시 Qwen (모델 교체)', 'pm', 'gate'));
    say(`  GPU 대기열 처리 순서: ${queue.history.join(' → ')}`);
  }
  if (!only || only === 'claude') results.push(await ping('Claude Code (읽기 전용, 샌드박스)', 'developer', 'meeting', sandbox));
  if (!only || only === 'codex') results.push(await ping('Codex (read-only, 샌드박스)', 'reviewer', 'gate', sandbox));
  return results.every(Boolean);
}

async function fullFlow(): Promise<boolean> {
  const id = `smoke-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  const repo = join(config.paths.repos, id);
  mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'smoke@localhost');
  git('config', 'user.name', 'smoke');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: id, private: true, scripts: { test: 'node --test' } }, null, 2));
  writeFileSync(join(repo, 'README.md'), '# smoke\n\n`add(a, b)`를 math.js에 만들고 math.test.js로 테스트한다.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  registerProject(ctx, { id, repoUrl: `https://github.com/smoke/${id}.git`, localPath: repo, testCommand: 'npm test' });

  const engine = new Engine({ ctx, brainFor, tests: new ProjectTestRunner(ctx), workspace: new GitWorkspace(ctx), connectivity: new Connectivity(ctx), log: (l) => say(`  · ${l}`) });
  engine.submitOrder({ discordMessageId: String(Date.now()).padEnd(19, '0'), rawText: `${id} 프로젝트에 add(a, b) 함수를 math.js로 만들고 node --test로 도는 테스트를 추가해줘` });
  say('계획 작성·관문 검사 중…');
  await engine.runUntilIdle();
  for (const a of pendingApprovals(ctx)) {
    say(`(시험용) CEO 대신 승인: ${a.summary}`);
    engine.decide({ approvalId: a.id, discordUserId: config.ceoDiscordId, decision: 'approved' });
  }
  say('작업·검토 중… (몇 분 걸릴 수 있어요)');
  await engine.runUntilIdle();
  const all = ctx.db.select().from(tickets).all();
  for (const t of all) say(`  ${t.id} ${t.title}: ${t.status}${t.pauseReason ? `(${t.pauseReason})` : ''} · 반려 ${t.reworkCount} · worktree ${t.worktreePath ?? '-'}`);
  for (const u of ctx.db.select().from(usage).all()) say(`  사용량 ${u.budget}: 토큰 ${u.inputTokens}+${u.outputTokens}, 5시간 ${u.estimatedPct}% · 주간 ${u.estimatedWeeklyPct}% (추정치)`);
  return all.length > 0 && all.every((t) => t.status === 'done');
}

const ok = (await pings()) && (!flow || (await fullFlow()));
say(ok ? '\n[통과] 스모크 테스트' : '\n[실패] 스모크 테스트 — 위 [실패] 줄을 RESULTS.md에 붙여 주세요');
process.exitCode = ok ? 0 : 1;
