import { and, eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connectivity } from '../src/connectivity.ts';
import { MockWeb } from '../src/web/mock-web.ts';
import { registerProject } from '../src/workspace/projects.ts';
import { MockWorkspace } from '../src/workspace/mock-workspace.ts';
import type { OfficeEventType } from '@ai-office/shared';
import type { TestRunner } from '../src/brains/brain.ts';
import { MockLlm, type MockHandler, type MockOptions } from '../src/brains/mock.ts';
import { FakeClock } from '../src/clock.ts';
import { makeConfig } from '../src/config.ts';
import type { Ctx } from '../src/context.ts';
import { openDb } from '../src/db/client.ts';
import { approvals, events, tickets } from '../src/db/schema.ts';
import { Engine } from '../src/engine.ts';
import { seedStaff } from '../src/seed.ts';
import type { BrainTask } from '../src/brains/brain.ts';

export const CEO = '100000000000000001';
export const STRANGER = '200000000000000002';
export const ceoActor = { kind: 'approval-bot', discordUserId: CEO } as const;
export const orchestrator = { kind: 'orchestrator' } as const;

type ConfigOver = Omit<Parameters<typeof makeConfig>[0], 'ceoDiscordId'>;

/** 테스트마다 따로 쓰는 임시 작업 공간 (C:\ai-office는 건드리지 않는다) */
export function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ai-office-test-'));
}

export function setup(
  opts: { handlers?: Partial<Record<BrainTask, MockHandler>>; mock?: MockOptions; config?: ConfigOver; tests?: TestRunner; probe?: () => Promise<boolean>; web?: MockWeb } = {},
) {
  const db = openDb(':memory:');
  const clock = new FakeClock();
  const root = tempRoot();
  const config = makeConfig({
    ceoDiscordId: CEO,
    ...opts.config,
    paths: { wt: join(root, 'wt'), data: join(root, 'data'), repos: join(root, 'repos'), ...opts.config?.paths },
  });
  const ctx: Ctx = { db, config, clock };
  seedStaff(ctx);
  registerProject(ctx, { id: 'demo', repoUrl: 'https://github.com/owner/demo.git', localPath: join(root, 'repos', 'demo'), testCommand: 'npm test' });
  const mock = new MockLlm(opts.handlers, opts.mock);
  const tests: TestRunner = opts.tests ?? { run: async () => ({ passed: true, summary: 'mock: 12 passed' }) };
  const workspace = new MockWorkspace(root);
  const connectivity = new Connectivity(ctx, opts.probe ?? (async () => true));
  const web = opts.web ?? new MockWeb();
  const engine = new Engine({ ctx, brainFor: () => mock, tests, workspace, connectivity, web });
  return { db, clock, config, ctx, mock, engine, workspace, root, web };
}
export type Setup = ReturnType<typeof setup>;

let msgSeq = 0;
/** 지시를 넣고 계획서가 CEO 결재 대기에 올라갈 때까지 돌린다. */
export async function orderUntilPlanApproval(s: Setup, rawText = '로그인 기능 추가해줘') {
  const { order } = s.engine.submitOrder({ discordMessageId: `13000000000000${String(++msgSeq).padStart(5, '0')}`, rawText });
  await s.engine.runUntilIdle();
  return { order, approval: pendingPlanApproval(s) };
}

export function pendingPlanApproval(s: Setup) {
  return s.db.select().from(approvals).where(and(eq(approvals.kind, 'plan'), eq(approvals.status, 'pending'))).get();
}

/** 지시 → 계획 → CEO 승인까지. 티켓은 in_progress에서 멈춰 있다(엔진을 더 돌리지 않음). */
export async function approvedTickets(s: Setup, rawText?: string) {
  const { order, approval } = await orderUntilPlanApproval(s, rawText);
  if (!approval) throw new Error('계획서 결재가 올라오지 않았어요');
  s.engine.decide({ approvalId: approval.id, discordUserId: CEO, decision: 'approved' });
  return { order, tickets: s.db.select().from(tickets).where(eq(tickets.orderId, order.id)).all() };
}

export function ticket(s: Setup, id: string) {
  return s.db.select().from(tickets).where(eq(tickets.id, id)).get()!;
}

export function eventsOf(s: Setup, type?: OfficeEventType) {
  const all = s.db.select().from(events).orderBy(events.seq).all();
  return type ? all.filter((e) => e.type === type) : all;
}

/** 티켓의 상태 전환 기록 (from → to) */
export function statusTrail(s: Setup, ticketId: string): string[] {
  return eventsOf(s, 'ticket.status')
    .map((e) => e.payload as { ticketId: string; from: string | null; to: string; event: string })
    .filter((p) => p.ticketId === ticketId && p.from !== p.to)
    .map((p) => p.to);
}
