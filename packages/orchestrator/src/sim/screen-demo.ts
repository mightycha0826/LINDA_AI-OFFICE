// npm run demo:screen — 사무실 화면 미리보기용 가짜 회사 (API 비용 0, 메모리 DB).
// MockLLM에 지연을 넣어 직원들이 천천히 일하는 모습을 보여준다. 결재는 몇 초 뒤 자동으로 "CEO 승인"한다.
// 이 자동 승인은 미리보기 스크립트에만 있다. 실제 오케스트레이터에는 자동 승인이 없다(5장).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { Brain, BrainRequest } from '../brains/brain.ts';
import { failReview, MockLlm, passReview, planOutput, type TicketInput } from '../brains/mock.ts';
import { systemClock } from '../clock.ts';
import { makeConfig } from '../config.ts';
import { emit, inTx, type Ctx } from '../context.ts';
import { markCeoActive } from '../discord/presence.ts';
import { LOCAL_MODEL } from '@ai-office/shared';
import { pendingApprovals } from '../core/approvals.ts';
import { openDb } from '../db/client.ts';
import { orders, tickets } from '../db/schema.ts';
import { Engine } from '../engine.ts';
import { Connectivity } from '../connectivity.ts';
import { defaultScreenDirs, startScreenServer } from '../http/screen-server.ts';
import { seedStaff } from '../seed.ts';
import { MockWeb } from '../web/mock-web.ts';
import { MockWorkspace } from '../workspace/mock-workspace.ts';
import { registerProject } from '../workspace/projects.ts';

const CEO = '100000000000000001';
const port = Number(process.env.SCREEN_PORT ?? 8780);
const root = mkdtempSync(join(tmpdir(), 'ai-office-demo-'));
const paths = { wt: join(root, 'wt'), data: join(root, 'data'), repos: join(root, 'repos') };
const config = makeConfig({ ceoDiscordId: CEO, paths });
config.screen = { ...config.screen, port, companyName: 'AI 사무실 (미리보기)' };
const ctx: Ctx = { db: openDb(':memory:'), config, clock: systemClock };
seedStaff(ctx);
registerProject(ctx, { id: 'demo', repoUrl: 'https://github.com/owner/demo.git', localPath: join(paths.repos, 'demo'), testCommand: 'npm test' });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rawOf = (req: BrainRequest) => ctx.db.select().from(orders).where(eq(orders.id, req.orderId ?? '')).get()?.rawText ?? '';
const criteriaOf = (req: BrainRequest) => (req.input as TicketInput).ticket.acceptanceCriteria;

const mock = new MockLlm({
  plan: (req) => {
    const text = (req.input as { order: { rawText: string } }).order.rawText;
    const base = planOutput().tickets[0]!;
    const title = text.replace(/\[.*?\]\s*/, '').slice(0, 24);
    if (text.includes('[글]'))
      return planOutput({
        goal: title,
        tempStaff: [{ key: 'writer-1', kind: 'writer', reason: '긴 안내문이 필요함' }],
        tickets: [{ ...base, title, type: 'writing', assignee: 'temp:writer-1', reviewer: 'qa-local', acceptanceCriteria: ['요금 항목 포함', '해요체'] }],
      });
    if (text.includes('[조사]'))
      return planOutput({ goal: title, tickets: [{ ...base, title, type: 'research', assignee: 'strategy', reviewer: 'qa-local', acceptanceCriteria: ['출처 3개 이상', '요약 1쪽'] }] });
    return planOutput({ goal: title, tickets: [{ ...base, title }] });
  },
  review: (req, n) => {
    const text = rawOf(req);
    if (text.includes('[반려1]') && n === 1) return failReview(criteriaOf(req), 'test-failed', '테스트 2개 실패');
    if (text.includes('[회의]') && n <= 2) return failReview(criteriaOf(req), 'criteria-unmet', `${n}번째 지적: 오류 문구가 빠짐`);
    return passReview(criteriaOf(req));
  },
});
// 직원마다 2~5초 걸려서 일한다
const slow: Brain = {
  call: async (req) => {
    await sleep(2000 + Math.random() * 3000);
    return mock.call(req);
  },
};

const engine = new Engine({
  ctx,
  brainFor: () => slow,
  tests: { run: async () => ({ passed: true, summary: 'mock: 12 passed' }) },
  workspace: new MockWorkspace(root),
  connectivity: new Connectivity(ctx, async () => true),
  web: new MockWeb(),
});

const ORDERS = ['로그인 기능 추가', '[반려1] 비밀번호 찾기', '[글] 요금 안내문 작성', '[회의] 이메일 인증', '[조사] 경쟁 서비스 가격 조사', '알림 설정 화면', '[반려1] 프로필 사진 올리기', '[글] 첫 화면 소개 문구'];
let orderN = 0;
function nextOrder() {
  const text = ORDERS[orderN % ORDERS.length]!;
  orderN++;
  engine.submitOrder({ discordMessageId: String(1300000000000000000n + BigInt(orderN)), rawText: text });
}

function every(ms: number, fn: () => Promise<unknown> | unknown) {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      console.error(err);
    } finally {
      running = false;
    }
  }, ms);
}

const seenApproval = new Map<string, number>();
const pushed = new Set<string>();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const startedAt = new Date().toISOString();
await startScreenServer({ c: ctx, ...defaultScreenDirs(repoRoot), extras: () => ({ startedAt, gpu: { usedMB: 9_800 + Math.round(Math.random() * 600), totalMB: 16_384 } }), pollMs: 500 });

markCeoActive(ctx);
for (let i = 0; i < 3; i++) nextOrder();

every(1500, () => engine.step());
every(40_000, nextOrder);
every(1000, () => {
  // 결재 대기는 6초 동안 서류로 쌓여 있다가 "CEO 승인"
  for (const a of pendingApprovals(ctx)) {
    const first = seenApproval.get(a.id) ?? Date.now();
    seenApproval.set(a.id, first);
    if (Date.now() - first > 6000) engine.decide({ approvalId: a.id, discordUserId: CEO, decision: 'approved' });
  }
  // 끝난 개발 티켓은 고양이가 푸시하는 모습을 보여준다 (실제 푸시 없음)
  for (const t of ctx.db.select().from(tickets).where(eq(tickets.status, 'done')).all()) {
    if (t.type !== 'coding' || pushed.has(t.id)) continue;
    pushed.add(t.id);
    inTx(ctx, (c) => emit(c, 'git.commit', { ticketId: t.id, subject: `feat(app): ${t.title}` }));
    setTimeout(() => inTx(ctx, (c) => emit(c, 'git.push', { ticketId: t.id, ok: true, branch: `feature/${t.id.toLowerCase()}` })), 3000);
  }
});
// 7-2부터 로컬 모델은 하나라 교체가 없다. 쉬다가 다시 올라오는 모습만 (Ollama는 쉬면 모델을 내린다)
every(30_000, () => inTx(ctx, (c) => emit(c, 'model.loaded', { from: null, to: LOCAL_MODEL, loadMs: 8200 })));
every(75_000, () => inTx(ctx, (c) => emit(c, 'employee.move', { employeeId: 'chief-of-staff', to: 'ceo', slot: 'demo' })));

console.log(`사무실 화면 미리보기: http://127.0.0.1:${port}  (UI를 먼저 빌드: npm run build:screen)`);
console.log('개발 중에는 npm -w @ai-office/office-ui run dev 로 http://localhost:5173 을 열어도 돼요.');
