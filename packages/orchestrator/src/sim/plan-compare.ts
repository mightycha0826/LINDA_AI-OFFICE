// PM 두뇌 비교 실험: 같은 지시를 메모리 DB에서 계획 단계(계획서 → GPT 관문 → CEO 결재 직전)까지만 돌린다.
// 운영 DB(office.db), 등록 저장소, 실제 worktree는 건드리지 않는다. 계획서 결재는 누르지 않는다.
//
//   node src/sim/plan-compare.ts [--pm claude|qwen] [--config C:\ai-office\data\config.json] [--text "지시 원문"]
//
// 실제 두뇌를 부르므로 Claude 리서치 몫·GPT 한도를 조금 쓴다(계획 1~6번, 관문 1~3번).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createBrainRegistry } from '../brains/registry.ts';
import type { BrainFor } from '../brains/registry.ts';
import { systemClock } from '../clock.ts';
import { DEFAULTS, loadConfig, type Config } from '../config.ts';
import { Connectivity } from '../connectivity.ts';
import { getState, type Ctx } from '../context.ts';
import { pendingApprovals } from '../core/approvals.ts';
import { openDb } from '../db/client.ts';
import { employees, plans, usage } from '../db/schema.ts';
import { Engine } from '../engine.ts';
import { seedStaff } from '../seed.ts';
import { registerProject } from '../workspace/projects.ts';
import { GitWorkspace } from '../workspace/worktrees.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const pmBrain = (opt('pm') ?? 'claude') as 'claude' | 'qwen';
const rawText = opt('text') ?? '나를 소개하는 포트폴리오 웹사이트를 제작해줘';
const loaded: Config = loadConfig(opt('config') ?? join(DEFAULTS.paths.data, 'config.json'));
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
// 시험 폴더: <wt>\_experiment\<시각> (샌드박스와 가짜 저장소 경로). 진짜 repos·wt는 쓰지 않는다
const root = join(loaded.paths.wt, '_experiment', `${pmBrain}-${stamp}`);
const config: Config = { ...loaded, paths: { ...loaded.paths, wt: root, repos: join(root, 'repos') } };
mkdirSync(config.paths.repos, { recursive: true });
const ctx: Ctx = { db: openDb(':memory:'), config, clock: systemClock };
seedStaff(ctx);
if (pmBrain === 'claude') {
  // PM을 Claude(리서치 몫)로 바꾼다. 실험용 메모리 DB에서만
  ctx.db.update(employees).set({ brain: { provider: 'claude-code', budget: 'research' } }).where(eq(employees.id, 'pm')).run();
}
// O-2와 같은 조건: jhwchn 프로젝트 채널에서 온 지시 (README만 있는 새 저장소, npm test)
registerProject(ctx, { id: 'jhwchn', repoUrl: 'https://github.com/owner/jhwchn.git', localPath: join(config.paths.repos, 'jhwchn'), testCommand: 'npm test' });

const say = (s: string) => console.log(s);
const workspace = new GitWorkspace(ctx);
const { brainFor: real } = createBrainRegistry(config);
const calls: { task: string; employee: string; attempt: number; seconds: number; input: number; output: number; error?: string }[] = [];
// 엔진은 PM 호출에 작업 폴더를 주지 않는다(로컬 PM 전제). 클라우드 PM이면 빈 샌드박스를 준다
const brainFor: BrainFor = (e, o) => {
  const brain = real(e, o);
  return {
    async call(req) {
      const started = Date.now();
      const workdir = req.workdir ?? (e.brain.provider === 'ollama' ? undefined : workspace.sandbox(`${req.task}-${e.id}`));
      try {
        const res = await brain.call({ ...req, ...(workdir ? { workdir } : {}) });
        calls.push({ task: req.task, employee: e.id, attempt: req.attempt, seconds: (Date.now() - started) / 1000, input: res.usage.inputTokens, output: res.usage.outputTokens });
        return res;
      } catch (err) {
        calls.push({ task: req.task, employee: e.id, attempt: req.attempt, seconds: (Date.now() - started) / 1000, input: 0, output: 0, error: (err as Error).message.slice(0, 200) });
        throw err;
      }
    },
  };
};

const engine = new Engine({ ctx, brainFor, tests: { run: async () => ({ passed: false, summary: '실험: 테스트 안 돌림' }) }, workspace, connectivity: new Connectivity(ctx), log: (l) => say(`  · ${l}`) });
const started = Date.now();
const { order } = engine.submitOrder({ discordMessageId: String(Date.now()).padEnd(19, '0'), rawText, projectId: 'jhwchn' });
say(`PM=${pmBrain} · 지시 "${rawText}" · 계획 단계까지 (${root})`);
await engine.runUntilIdle(30);

const all = ctx.db.select().from(plans).where(eq(plans.orderId, order.id)).orderBy(plans.version).all();
const blocked = getState<unknown>(ctx, `planBlocked:${order.id}`, null);
const lines: string[] = [`# PM 비교 실험 · ${pmBrain} · ${stamp}`, `지시: ${rawText}`, `걸린 시간: ${((Date.now() - started) / 1000).toFixed(0)}초`, ''];
for (const p of all) {
  lines.push(`## ${p.id} v${p.version} · ${p.status} · 관문 시도 ${p.gateAttempts}`);
  lines.push(`목표: ${p.goal}`);
  p.tickets.forEach((t, i) => lines.push(`${i + 1}. [${t.type}] ${t.title} · 담당 ${t.assignee} · 검토 ${t.reviewer} · 예상 토큰 ${t.estimatedTokens}\n   완료 조건: ${t.acceptanceCriteria.join(' / ')}`));
  lines.push(`질문: ${p.questions.join(' / ') || '없음'}`, `예상: ${JSON.stringify(p.estimate)}`, `검토자 자동 변경: ${p.reviewerChanges.join(' / ') || '없음'}`);
  lines.push(`관문: ${p.gateResult ? (p.gateResult.passed ? '통과' : `반려 — ${p.gateResult.issues.join(' / ')}${p.gateResult.objection ? ` · 반대 의견: ${p.gateResult.objection}` : ''}`) : '-'}`, '');
}
if (blocked) lines.push(`계획 작성 멈춤: ${JSON.stringify(blocked)}`, '');
lines.push(`결재 대기: ${pendingApprovals(ctx).map((a) => a.summary).join(' / ') || '없음'}`, '', '## 호출');
for (const c of calls) lines.push(`- ${c.task} · ${c.employee} · ${c.attempt}회차 · ${c.seconds.toFixed(1)}초 · 토큰 ${c.input}+${c.output}${c.error ? ` · 실패: ${c.error}` : ''}`);
lines.push('', '## 몫별 사용량 (추정)');
for (const u of ctx.db.select().from(usage).all()) lines.push(`- ${u.budget}: 토큰 ${u.inputTokens}+${u.outputTokens} · 5시간 ${u.estimatedPct}% · 주간 ${u.estimatedWeeklyPct}%`);
const report = lines.join('\n');
say(report);
// 운영 데이터 폴더가 아니라 실험 폴더에 남긴다
const out = join(root, 'report.md');
writeFileSync(out, report, 'utf8');
say(`\n저장: ${out}`);
