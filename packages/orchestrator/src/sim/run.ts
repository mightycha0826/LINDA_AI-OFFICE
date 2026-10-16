// npm run sim — MockLLM으로 회사 하루를 돌려 본다 (16장 1단계). API 비용 0, 메모리 DB.
// 시나리오: ① 바로 통과 ② 반려 1회 ③ 반려 2회 → 회의 → 합의 ④ CEO 결재가 필요한 문서 ⑤ /정지·/재개
import { eq } from 'drizzle-orm';
import type { ReasonCategory } from '@ai-office/shared';
import { failReview, MockLlm, passReview, planOutput, type TicketInput } from '../brains/mock.ts';
import type { BrainRequest } from '../brains/brain.ts';
import { FakeClock } from '../clock.ts';
import { makeConfig } from '../config.ts';
import type { Ctx } from '../context.ts';
import { pendingApprovals } from '../core/approvals.ts';
import { budgetStatus } from '../core/budget.ts';
import { openDb } from '../db/client.ts';
import { events, meetingMinutes, orders, tickets } from '../db/schema.ts';
import { Engine } from '../engine.ts';
import { seedStaff } from '../seed.ts';
import { Connectivity } from '../connectivity.ts';
import { MockWorkspace } from '../workspace/mock-workspace.ts';
import { MockWeb } from '../web/mock-web.ts';
import { registerProject } from '../workspace/projects.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CEO = '100000000000000001';
const db = openDb(':memory:');
const clock = new FakeClock('2026-10-15T08:00:00+09:00');
// 시뮬레이션은 임시 폴더만 쓴다 (C:\ai-office는 건드리지 않음)
const root = mkdtempSync(join(tmpdir(), 'ai-office-sim-'));
const paths = { wt: join(root, 'wt'), data: join(root, 'data'), repos: join(root, 'repos') };
const ctx: Ctx = { db, config: makeConfig({ ceoDiscordId: CEO, paths }), clock };
seedStaff(ctx);
registerProject(ctx, { id: 'demo', repoUrl: 'https://github.com/owner/demo.git', localPath: join(paths.repos, 'demo'), testCommand: 'npm test' });

// 지시 원문에 들어 있는 표시로 시나리오를 고른다
const scenarioOf = (req: BrainRequest) => {
  const order = db.select().from(orders).where(eq(orders.id, req.orderId ?? '')).get();
  return order?.rawText ?? '';
};
const criteriaOf = (req: BrainRequest) => (req.input as TicketInput).ticket.acceptanceCriteria;
const fail = (req: BrainRequest, n: number, cat: ReasonCategory) => failReview(criteriaOf(req), cat, `${n}번째 지적`);

const mock = new MockLlm({
  plan: (req) => {
    const text = (req.input as { order: { rawText: string } }).order.rawText;
    const base = planOutput().tickets[0]!;
    if (text.includes('[문서]')) {
      return planOutput({
        goal: '랜딩 페이지 소개 문구',
        tickets: [{ ...base, title: '소개 문구 초안', type: 'marketing', assignee: 'marketing', reviewer: 'qa-local', acceptanceCriteria: ['요금 항목 포함', '근거 링크 표시'], needsCeoApproval: true }],
      });
    }
    return planOutput({ goal: text, tickets: [{ ...base, title: text.replace(/\[.*?\]\s*/, '').slice(0, 20) }] });
  },
  review: (req, n) => {
    const text = scenarioOf(req);
    if (text.includes('[반려1]') && n === 1) return fail(req, n, 'test-failed');
    if (text.includes('[회의]') && n <= 2) return fail(req, n, 'criteria-unmet');
    return passReview(criteriaOf(req));
  },
});

const engine = new Engine({
  ctx,
  brainFor: () => mock,
  tests: { run: async () => ({ passed: true, summary: 'mock: 12 passed' }) },
  workspace: new MockWorkspace(root),
  connectivity: new Connectivity(ctx, async () => true),
  web: new MockWeb(),
});

const say = (s: string) => console.log(s);
let lastSeq = 0;
function flushEvents(): void {
  const rows = db.select().from(events).all().filter((e) => e.seq > lastSeq);
  for (const e of rows) {
    lastSeq = e.seq;
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'ticket.status' && p.from !== p.to) say(`  #${e.seq} ${p.ticketId}: ${p.from ?? '-'} → ${p.to}  (${p.event}, ${p.actor ?? ''})`);
    else if (e.type === 'plan.status') say(`  #${e.seq} 계획서 ${p.planId ?? ''} v${p.version ?? '?'}: ${p.status}`);
    else if (e.type === 'approval.requested') say(`  #${e.seq} 결재 요청: ${p.kind} ${p.targetId}`);
    else if (e.type === 'approval.decided') say(`  #${e.seq} 결재 결정: ${p.kind} ${p.targetId} → ${p.status}`);
    else if (e.type === 'meeting.minutes') say(`  #${e.seq} 회의록: ${p.kind} ${p.outcome}`);
    else if (e.type === 'system.paused' || e.type === 'system.resumed') say(`  #${e.seq} ${e.type}`);
  }
}

async function approveAllPending(): Promise<void> {
  for (const a of pendingApprovals(ctx)) {
    say(`CEO: [승인] ${a.summary}`);
    engine.decide({ approvalId: a.id, discordUserId: CEO, decision: 'approved' });
  }
}

async function main(): Promise<void> {
  say('== 08:00 지시 4건 ==');
  engine.submitOrder({ discordMessageId: '1300000000000000001', rawText: '로그인 기능 추가' });
  engine.submitOrder({ discordMessageId: '1300000000000000002', rawText: '[반려1] 비밀번호 찾기' });
  engine.submitOrder({ discordMessageId: '1300000000000000003', rawText: '[회의] 이메일 인증' });
  engine.submitOrder({ discordMessageId: '1300000000000000004', rawText: '[문서] 랜딩 페이지 문구' });
  // 같은 Discord 메시지가 다시 와도 지시는 하나
  engine.submitOrder({ discordMessageId: '1300000000000000001', rawText: '로그인 기능 추가' });
  await engine.runUntilIdle();
  flushEvents();

  say('\n== CEO가 계획서를 승인 ==');
  await approveAllPending();
  flushEvents();

  say('\n== 작업 진행 (도중에 /정지 → /재개) ==');
  await engine.step();
  engine.stop(CEO);
  say('CEO: /정지');
  say(`  정지 중 한 바퀴: 한 일 ${await engine.step()}건`);
  engine.resume(CEO);
  say('CEO: /재개');
  clock.advanceHours(1);
  await engine.runUntilIdle();
  flushEvents();

  say('\n== CEO 결재가 필요한 문서 ==');
  await approveAllPending();
  await engine.runUntilIdle();
  flushEvents();

  say('\n== 결과 ==');
  for (const t of db.select().from(tickets).all()) {
    say(`  ${t.id} ${t.title.padEnd(12)} ${t.status.padEnd(10)} 반려 ${t.reworkCount} · 턴 ${t.turnsUsed} · 토큰 ${t.tokensUsed}`);
  }
  for (const o of db.select().from(orders).all()) say(`  ${o.id} ${o.status.padEnd(10)} ${o.rawText}`);
  const minutes = db.select().from(meetingMinutes).all();
  say(`  회의록 ${minutes.length}건: ${minutes.map((m) => `${m.kind}/${m.outcome}`).join(', ') || '없음'}`);
  for (const b of ['dev', 'research', 'review', 'local'] as const) {
    const st = budgetStatus(ctx, b);
    say(`  한도 ${b.padEnd(8)} 5시간 ${st.fiveHour.used.toFixed(1)}%/${st.fiveHour.limit ?? '∞'} · 주간 ${st.weekly.used.toFixed(1)}%/${st.weekly.limit ?? '∞'} (추정치)`);
  }
  say(`  AI 호출 ${mock.calls.length}회 (MockLLM, 비용 0) · 이벤트 ${lastSeq}개`);

  const unfinished = db.select().from(tickets).all().filter((t) => t.status !== 'done');
  if (unfinished.length) {
    console.error(`\n끝나지 않은 티켓: ${unfinished.map((t) => `${t.id}(${t.status})`).join(', ')}`);
    process.exit(1);
  }
}

await main();
