// 로컬 두뇌 비교 실험 (16장 7-2): Qwen3-14B가 하던 일을 Gemma 4 12B(64K 태그)에 똑같이 시켜 본다.
// 운영 DB는 건드리지 않는다(메모리 DB). 로컬 모델만 부르므로 Claude·GPT 한도는 쓰지 않는다.
//
//   node src/sim/local-compare.ts [--reps 2] [--config C:\ai-office\data\config.json]
//
// 일: 커밋 메시지 초안(Git 고양이), 문서 원고(마케팅), 검색어(마케팅), 디자인 조합 고르기(디자인 시스템 담당)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { DesignComboOutputSchema, DocOutputSchema, SearchQueriesSchema, type Brain } from '@ai-office/shared';
import { createBrainRegistry } from '../brains/registry.ts';
import { systemClock } from '../clock.ts';
import { DEFAULTS, loadConfig, type Config } from '../config.ts';
import { Connectivity } from '../connectivity.ts';
import type { Ctx } from '../context.ts';
import { openDb } from '../db/client.ts';
import { employees } from '../db/schema.ts';
import { Engine } from '../engine.ts';
import { CommitDraftSchema } from '../gitcat/commit-message.ts';
import { seedStaff } from '../seed.ts';
import { designComboTable } from '../staff/design-combos.ts';
import { GitWorkspace } from '../workspace/worktrees.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const reps = Number(opt('reps') ?? 2);
const loaded: Config = loadConfig(opt('config') ?? join(DEFAULTS.paths.data, 'config.json'));
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const root = join(loaded.paths.wt, '_experiment', `local-${stamp}`);
mkdirSync(root, { recursive: true });
const say = (s: string) => console.log(s);

/** 비교할 두뇌. 문맥 크기를 모델 태그와 맞춰 Ollama가 다시 올리지 않게 한다 */
const MODELS = [
  { model: 'qwen3:14b', numCtx: 16_384 },
  { model: 'gemma4:12b-64k', numCtx: 65_536 },
];

const DOC_CRITERIA = ['소개·경력·프로젝트·연락처 4개 섹션 원고가 포함되어 있다', '한 줄 소개(40자 이내) 후보 3개가 포함되어 있다', '정보가 없는 항목은 [자리표시]로 표시되어 있다'];
interface Job {
  name: string;
  employee: string;
  task: 'commit' | 'work' | 'search' | 'design';
  schema: z.ZodType;
  input: unknown;
  /** 코드로 볼 수 있는 품질 기준. 문제 목록 */
  judge: (out: never) => string[];
}
const JOBS: Job[] = [
  {
    name: '커밋 메시지 초안',
    employee: 'git-cat',
    task: 'commit',
    schema: CommitDraftSchema,
    input: {
      ticket: { id: 'T-3', title: '포트폴리오 4개 섹션 구현', type: 'coding', acceptanceCriteria: ['npm test 통과', '4개 섹션 존재 테스트 통과'] },
      diffStat: ' index.html            | 120 +++++\n styles.css            |  80 +++\n content.json          |  40 ++\n test/sections.test.js |  35 ++\n 4 files changed, 275 insertions(+)',
    },
    judge: (o: { type: string; subject: string }) => [...(o.type === 'feat' ? [] : [`종류가 feat가 아님(${o.type})`]), ...(/T-\d/.test(o.subject) ? ['요약에 티켓 번호'] : [])],
  },
  {
    name: '문서 원고 (마케팅)',
    employee: 'marketing',
    task: 'work',
    schema: DocOutputSchema,
    input: { ticket: { id: 'T-2', title: '포트폴리오 소개 원고 작성', type: 'writing', acceptanceCriteria: DOC_CRITERIA }, feedback: [] },
    judge: (o: { document: string }) => {
      const d = o.document;
      const missing = ['소개', '경력', '프로젝트', '연락처'].filter((s) => !d.includes(s)).map((s) => `섹션 없음: ${s}`);
      return [...missing, ...(d.includes('자리표시') ? [] : ['[자리표시] 표시 없음']), ...(d.length < 300 ? [`너무 짧음(${d.length}자)`] : [])];
    },
  },
  {
    name: '검색어 정하기',
    employee: 'marketing',
    task: 'search',
    schema: SearchQueriesSchema,
    input: { ticket: { id: 'T-4', title: '개인 포트폴리오 웹사이트 구성 사례 조사', type: 'research', acceptanceCriteria: ['참고 사이트 3곳 이상과 링크 포함'] } },
    judge: (o: { queries: string[] }) => (o.queries.some((q) => q.length > 60) ? ['검색어가 너무 김'] : []),
  },
  {
    name: '디자인 조합 고르기',
    employee: 'marketing',
    task: 'design',
    schema: DesignComboOutputSchema,
    input: {
      order: { rawText: '나를 소개하는 포트폴리오 웹사이트를 제작해줘' },
      plan: { goal: '개인 포트폴리오 정적 웹사이트', tickets: [{ title: '포트폴리오 구현', type: 'coding' }] },
      combos: designComboTable(),
    },
    judge: (o: { reason: string }) => (o.reason.length < 10 ? ['이유가 너무 짧음'] : []),
  },
];

interface Row {
  model: string;
  job: string;
  rep: number;
  seconds: number;
  ok: boolean;
  formatErrors: number;
  problems: string[];
  output: string;
}
const rows: Row[] = [];

for (const m of MODELS) {
  const config: Config = { ...loaded, ollama: { ...loaded.ollama, numCtx: m.numCtx }, paths: { ...loaded.paths, wt: root, repos: join(root, 'repos') } };
  const ctx: Ctx = { db: openDb(':memory:'), config, clock: systemClock };
  seedStaff(ctx);
  const brain = { provider: 'ollama', model: m.model } as Brain;
  for (const id of ['marketing', 'git-cat']) ctx.db.update(employees).set({ brain }).where(eq(employees.id, id)).run();
  const logs: string[] = [];
  const { brainFor, queue } = createBrainRegistry(config);
  const engine = new Engine({ ctx, brainFor, tests: { run: async () => ({ passed: false, summary: '' }) }, workspace: new GitWorkspace(ctx), connectivity: new Connectivity(ctx, async () => true), log: (l) => logs.push(l) });
  say(`\n== ${m.model} (num_ctx ${m.numCtx}) ==`);
  for (const job of JOBS) {
    for (let rep = 1; rep <= reps; rep++) {
      const before = logs.length;
      const started = Date.now();
      const out = await engine.callAs(job.employee, job.task, job.schema, job.input);
      const seconds = (Date.now() - started) / 1000;
      const formatErrors = logs.slice(before).filter((l) => l.includes('형식 오류')).length;
      const problems = out ? job.judge(out as never) : ['출력 없음(형식 오류 2회 또는 호출 실패)'];
      rows.push({ model: m.model, job: job.name, rep, seconds, ok: !!out, formatErrors, problems, output: JSON.stringify(out) });
      say(`- ${job.name} #${rep}: ${seconds.toFixed(1)}초 · ${out ? '성공' : '실패'} · 형식 오류 ${formatErrors} · ${problems.join(', ') || '문제 없음'}`);
    }
  }
  say(`  GPU 대기열: ${queue.history.join(' → ')}`);
}

const lines = [`# 로컬 두뇌 비교 · ${stamp} · 반복 ${reps}회`, '', '| 모델 | 일 | 성공 | 형식 오류(재시도) | 코드 기준 문제 | 평균 초 |', '| --- | --- | --- | --- | --- | --- |'];
for (const m of MODELS) {
  for (const job of JOBS) {
    const r = rows.filter((x) => x.model === m.model && x.job === job.name);
    lines.push(`| ${m.model} | ${job.name} | ${r.filter((x) => x.ok).length}/${r.length} | ${r.reduce((a, x) => a + x.formatErrors, 0)} | ${r.reduce((a, x) => a + x.problems.length, 0)} | ${(r.reduce((a, x) => a + x.seconds, 0) / r.length).toFixed(1)} |`);
  }
}
lines.push('', '## 출력');
for (const r of rows) lines.push(`### ${r.model} · ${r.job} #${r.rep} (${r.seconds.toFixed(1)}초)`, r.problems.length ? `문제: ${r.problems.join(', ')}` : '문제 없음', '```json', r.output.slice(0, 3000), '```');
const out = join(root, 'report.md');
writeFileSync(out, lines.join('\n'), 'utf8');
say(`\n저장: ${out}`);
