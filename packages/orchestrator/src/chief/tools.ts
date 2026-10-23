// 비서실장 도구 구현 (6장). 권한은 읽기와 지시 등록, 확인 버튼 요청, 보고 제출, 비상 정지(멈춤만)뿐이다.
// 결재 처리, PM 질문 답변, /재개, 푸시, 티켓 상태 변경은 할 수 없다. 이 파일에 그런 길이 없다(2026-10-22 CEO 결정: 사장님이 직접 한다).
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { isStopped } from '../context.ts';
import { pendingApprovals, requestApproval } from '../core/approvals.ts';
import { budgetStatus } from '../core/budget.ts';
import { allNotes, memoryFor } from '../core/memory.ts';
import { approvals, messages, tickets } from '../db/schema.ts';
import { isCeoPresent } from '../discord/presence.ts';
import { nextCheckTime } from '../discord/schedule.ts';
import type { Engine } from '../engine.ts';
import { OfficeError } from '../errors.ts';
import { approvalLink, buildReportData } from '../reports.ts';
import type { ReportService } from './report-service.ts';
import type { GitCatPort } from '../discord/interactions.ts';
import { pendingChiefProposal, proposeChiefOrder, respondChiefOrder } from './order-proposals.ts';
import { readableDiscordText } from '../discord/format.ts';
import { orderInfo, projectList, staffList, ticketLog } from './reads.ts';
import { requestChiefAction, type ChiefRequestInput } from './requests.ts';
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
          pendingOrderProposal: pendingChiefProposal(c),
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
          recent: recent.map((m) => ({ from: m.fromId, kind: m.kind, summary: readableDiscordText(m.content).slice(0, 200) })),
        };
      }
      case 'get_pending_approvals':
        return pendingApprovals(c).map((a) => ({ kind: a.kind, summary: a.summary, link: approvalLink(c, a.discordMessageId) }));
      case 'get_report_data':
        return buildReportData(c, new Date(args.since!).toISOString());
      case 'get_usage':
        return (['dev', 'research', 'review'] as const).map((b) => ({ ...budgetStatus(c, b), estimated: true }));
      case 'get_ticket_log':
        return ticketLog(c, args.ticketId!, Number(args.limit ?? 20));
      case 'get_order':
        return orderInfo(c, args.orderId);
      case 'get_staff':
        return staffList(c);
      case 'get_projects':
        return projectList(c);
      case 'get_memory':
        return args.projectId ? memoryFor(c, args.projectId) : allNotes(c).map((n) => ({ id: n.id, scope: n.scope, text: n.text, at: n.at }));
      case 'request_action':
        return requestChiefAction(c, parsed.data as ChiefRequestInput);
      case 'emergency_stop': {
        const { alreadyStopped } = this.engine.haltByChief(args.reason!);
        return alreadyStopped
          ? { stopped: true, note: '이미 회사가 멈춰 있어요. 다시 시작은 사장님이 /재개로 해요' }
          : { stopped: true, note: '모든 직원을 멈추고 진행 중인 AI 호출을 끊었어요. 사장님께 알림이 갔어요. 다시 시작은 사장님이 /재개로만 할 수 있어요' };
      }
      case 'create_order': {
        return proposeChiefOrder(c, { rawText: args.rawText!, ...(args.discordMessageId ? { discordMessageId: args.discordMessageId } : {}), ...(args.projectId ? { projectId: args.projectId } : {}) });
      }
      case 'respond_order_proposal':
        return respondChiefOrder(c, args.proposalId!, args.decision as 'register' | 'chat');
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
