// 7-5 보조 직원 품질 확인: 진짜 Gemma(gemma4:12b-64k)에게 실제와 비슷한 입력을 주고 출력을 본다.
// 메모리 DB, 로컬 모델만 부른다(Claude·GPT 한도 안 씀). 운영은 건드리지 않는다.
//
//   node src/sim/helper-check.ts
import { join } from 'node:path';
import { DiffSummarySchema, ExplainOutputSchema, InterpretOutputSchema, ReportDraftSchema } from '@ai-office/shared';
import { createBrainRegistry } from '../brains/registry.ts';
import { systemClock } from '../clock.ts';
import { DEFAULTS, loadConfig, type Config } from '../config.ts';
import { Connectivity } from '../connectivity.ts';
import type { Ctx } from '../context.ts';
import { openDb } from '../db/client.ts';
import { Engine } from '../engine.ts';
import { seedStaff } from '../seed.ts';
import { GitWorkspace } from '../workspace/worktrees.ts';

const loaded: Config = loadConfig(join(DEFAULTS.paths.data, 'config.json'));
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const config: Config = { ...loaded, paths: { ...loaded.paths, wt: join(loaded.paths.wt, '_experiment', `helpers-${stamp}`) } };
const ctx: Ctx = { db: openDb(':memory:'), config, clock: systemClock };
seedStaff(ctx);
const logs: string[] = [];
const { brainFor } = createBrainRegistry(config);
const engine = new Engine({ ctx, brainFor, tests: { run: async () => ({ passed: false, summary: '' }) }, workspace: new GitWorkspace(ctx), connectivity: new Connectivity(ctx, async () => true), log: (l) => logs.push(l) });

const NOTICE = [
  '**계획 작성 멈춤 · [jhwchn] O-2**',
  '> 나를 소개하는 포트폴리오 웹사이트를 제작해줘',
  'PM이 규칙에 맞는 계획서를 두 번 쓰지 못했어요:',
  '- 티켓 1(포트폴리오 웹사이트의 콘텐츠 결정): 담당자(marketing)와 검토자(pm)가 같은 모델(qwen3:14b)임',
  '버튼: [다시 시도] [취소]',
].join('\n');
const DIFF = `diff --git a/index.html b/index.html
new file mode 100644
--- /dev/null
+++ b/index.html
@@ -0,0 +1,20 @@
+<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>포트폴리오</title><link rel="stylesheet" href="styles.css"></head>
+<body><section id="intro"><h1>[자리표시] 이름</h1></section><section id="career"></section><section id="projects"></section>
+<section id="contact"><a href="mailto:[자리표시]">이메일</a></section><script src="main.js"></script></body></html>
diff --git a/test/sections.test.js b/test/sections.test.js
new file mode 100644
+const { test } = require('node:test'); const assert = require('node:assert'); const fs = require('node:fs');
+test('4개 섹션', () => { const h = fs.readFileSync('index.html', 'utf8'); for (const id of ['intro','career','projects','contact']) assert.ok(h.includes('id="' + id + '"')); });
diff --git a/package.json b/package.json
-  "scripts": {}
+  "scripts": { "test": "node --test" }`;
const HANDOFF = JSON.stringify({ summary: '포트폴리오 4개 섹션과 섹션 존재 테스트를 추가함', changedFiles: ['index.html', 'styles.css', 'test/sections.test.js', 'package.json'] });
const REVIEW = JSON.stringify({ verdict: 'fail', reasonCategory: 'criteria-unmet', criteria: [{ criterion: '연락처 링크(mailto) 렌더링 테스트 통과', pass: false, reason: 'mailto 링크를 확인하는 테스트가 없음' }, { criterion: 'npm test 통과', pass: true }], fixRequests: ['mailto 링크 존재를 확인하는 테스트를 추가'] });
const DATA = ['진행 중: T-3 포트폴리오 4개 섹션 구현 (개발자 A, in_review)', '완료: T-1 기본 구조와 테스트', '막힘: 없음', '결재 대기: 1건 (T-1 푸시)', 'Claude 개발 몫 5시간 12% · GPT 몫 5시간 8% (추정)'].join('\n');

const cases = [
  { who: 'explainer', task: 'explain' as const, schema: ExplainOutputSchema, input: { notice: NOTICE } },
  { who: 'diff-summarizer', task: 'summarize' as const, schema: DiffSummarySchema, input: { ticket: { id: 'T-3', title: '포트폴리오 4개 섹션 구현', type: 'coding', acceptanceCriteria: ['4개 섹션 존재 테스트 통과'] }, diff: DIFF } },
  { who: 'interpreter', task: 'interpret' as const, schema: InterpretOutputSchema, input: { from: '개발자 A', content: HANDOFF } },
  { who: 'interpreter', task: 'interpret' as const, schema: InterpretOutputSchema, input: { from: '개발팀장', content: REVIEW } },
  { who: 'briefer', task: 'report' as const, schema: ReportDraftSchema, input: { data: DATA } },
];
for (const k of cases) {
  const started = Date.now();
  const out = await engine.callAs(k.who, k.task, k.schema, k.input);
  console.log(`\n=== ${k.who} · ${k.task} (${((Date.now() - started) / 1000).toFixed(1)}초) ${out ? '' : '실패'}`);
  console.log(JSON.stringify(out, null, 2));
}
if (logs.length) console.log('\n로그:\n' + logs.join('\n'));
