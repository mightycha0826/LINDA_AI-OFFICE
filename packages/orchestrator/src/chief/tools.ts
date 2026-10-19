// 비서실장 도구 구현 (6장). 권한은 읽기와 지시 등록, 확인 버튼 요청, 보고 제출뿐이다.
// 상태 변경, 결재 처리, 푸시는 할 수 없다. 이 파일에 그런 길이 없다.
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { isStopped } from '../context.ts';
import { pendingApprovals, requestApproval } from '../core/approvals.ts';
import { budgetStatus } from '../core/budget.ts';
import { approvals, messages, tickets } from '../db/schema.ts';
import { isCeoPresent } from '../discord/presence.ts';
import { nextCheckTime } from '../discord/schedule.ts';
import type { Engine } from '../engine.ts';
import { OfficeError } from '../errors.ts';
import { approvalLink, buildReportData } from '../reports.ts';
import type { ReportService } from './report-service.ts';
import type { GitCatPort } from '../discord/interactions.ts';
import { resolveOrderMessageId } from './order-message.ts';
import { TOOL_DEFS, type ToolName } from './tool-defs.ts';

export class ChiefTools {
  private readonly c: Ctx;
  private readonly engine: Engine;
  private readonly reports: ReportService | null;
  private readonly gitcat: GitCatPort | null;

  constructor(c: Ctx, engine: Engine, reports: ReportService | null, gitcat: GitCatPort | null = null) {
    this.c = c;
    this.engine = engine;
    this.reports = reports;
    this.gitcat = gitcat;
  }

  async call(name: string, rawArgs: unknown): Promise<unknown> {
    if (!(name in TOOL_DEFS)) throw new OfficeError('tool', `없는 도구예요: ${name}`);
    const def = TOOL_DEFS[name as ToolName];
    const parsed = def.input.safeParse(rawArgs ?? {});
    if (!parsed.success) throw new OfficeError('tool-args', `인자를 확인해 주세요: ${z.prettifyError(parsed.error)}`);
    const args = parsed.data as Record<string, string>;
    const c = this.c;

    switch (name as ToolName) {
      case 'get_status': {
        const active = c.db.select().from(tickets).where(inArray(tickets.status, ['in_progress', 'in_review', 'rework', 'meeting', 'awaiting_approval'])).all();
        const blocked = c.db.select().from(tickets).where(inArray(tickets.status, ['blocked', 'paused'])).all();
        return {
          inProgress: active.map((t) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assigneeId })),
          blocked: blocked.map((t) => ({ id: t.id, title: t.title, status: t.status, reason: t.pauseReason })),
          pendingApprovals: pendingApprovals(c).length,
          ceoPresence: isCeoPresent(c) ? 'online' : 'away',
          stopped: isStopped(c),
          nextCheck: nextCheckTime(c.config, c.clock.now()),
        };
      }
      case 'get_ticket': {
        const t = c.db.select().from(tickets).where(eq(tickets.id, args.ticketId!)).get();
        if (!t) return { error: `${args.ticketId} 티켓이 없어요` };
        const recent = c.db.select().from(messages).where(eq(messages.ticketId, t.id)).all().slice(-5);
        return {
          id: t.id,
          title: t.title,
          status: t.status,
          pauseReason: t.pauseReason,
          assignee: t.assigneeId,
          reviewer: t.reviewerId,
          reworkCount: t.reworkCount,
          acceptanceCriteria: t.acceptanceCriteria,
          recent: recent.map((m) => ({ from: m.fromId, kind: m.kind, summary: m.content.slice(0, 200) })),
        };
      }
      case 'get_pending_approvals':
        return pendingApprovals(c).map((a) => ({ kind: a.kind, summary: a.summary, link: approvalLink(c, a.discordMessageId) }));
      case 'get_report_data':
        return buildReportData(c, new Date(args.since!).toISOString());
      case 'get_usage':
        return (['dev', 'research', 'review'] as const).map((b) => ({ ...budgetStatus(c, b), estimated: true }));
      case 'create_order': {
        const messageId = resolveOrderMessageId(c, args.discordMessageId);
        const { order, created } = this.engine.submitOrder({ discordMessageId: messageId.id, rawText: args.rawText! });
        return { orderId: order.id, created, status: order.status, discordMessageId: messageId.id, messageIdSource: messageId.source };
      }
      case 'request_confirmation': {
        const t = c.db.select().from(tickets).where(eq(tickets.id, args.targetId!)).get();
        if (!t) return { requested: false, note: `${args.targetId} 티켓이 없어요` };
        const kind = args.kind === 'revert' ? 'revert' : 'push';
        const existing = c.db.select().from(approvals).where(and(eq(approvals.kind, kind), eq(approvals.targetId, t.id), eq(approvals.status, 'pending'))).get();
        if (existing) return { requested: true, note: '이미 결재함에 확인 버튼이 있어요' };
        if (this.gitcat) {
          // Git 고양이가 푸시 전 검사를 돌린 뒤 결재함에 버튼을 올린다 (4단계)
          void this.gitcat.preparePush(t.id, kind, `비서실장 전달: ${args.reason ?? ''}`).catch(() => undefined);
          return { requested: true, note: 'Git 고양이가 푸시 전 검사를 시작했어요. 끝나면 결재함에 확인 버튼이 올라가요. 버튼을 눌러야 실행돼요' };
        }
        requestApproval(c, {
          kind,
          targetId: t.id,
          reversible: kind === 'push' ? 'partial' : 'reversible',
          summary: `${t.id} ${t.title} ${kind === 'push' ? (args.kind === 'main-merge' ? 'main 병합' : '푸시') : '되돌리기'} — 비서실장 전달: ${args.reason ?? ''}`.trim(),
        });
        return { requested: true, note: '결재함에 확인 버튼을 띄웠어요. 버튼을 눌러야 실행돼요' };
      }
      case 'submit_report': {
        if (!this.reports) return { posted: false, note: 'Discord가 연결되지 않아 보고를 올릴 수 없어요' };
        return this.reports.submit(args.text!);
      }
    }
  }
}
