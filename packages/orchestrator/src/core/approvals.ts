// 결재 (DESIGN.md 7장, 9장 보안 규칙).
// - CEO 계정의 클릭만 인정한다.
// - pending에서 한 번만 결정된다: 조건부 UPDATE + DB 트리거.
// - 오래된 버튼(새 버전이 나온 계획서)은 거부한다.
// - 자동 승인은 없다. 시간이 지나 상태가 바뀌는 코드 경로가 아예 없다. expired는 새 버전이 나와 대체될 때만 생긴다.
import { and, eq } from 'drizzle-orm';
import type { ApprovalKind, Reversibility } from '@ai-office/shared';
import { emit, inTx, newId, nowIso, type Ctx } from '../context.ts';
import { approvals } from '../db/schema.ts';
import { AlreadyDecidedError, NotCeoError, NotFoundError, OfficeError, StaleApprovalError } from '../errors.ts';
import { applyCeoPlanDecision, getPlan, isLatestPlanVersion } from './plans.ts';
import { applyTicketEvent } from './tickets.ts';

export type ApprovalRow = typeof approvals.$inferSelect;
export type ApprovalDecision = 'approved' | 'rejected' | 'revision';

/** 티켓의 awaiting_approval을 푸는 결재 종류 */
const TICKET_APPROVAL_KINDS: readonly ApprovalKind[] = ['deploy', 'delete', 'external-send'];

export function requestApproval(
  c: Ctx,
  input: { kind: ApprovalKind; targetId: string; targetVersion?: number; reversible: Reversibility; summary: string },
): ApprovalRow {
  return inTx(c, (t) => {
    const row = t.db
      .insert(approvals)
      .values({
        id: newId(),
        kind: input.kind,
        targetId: input.targetId,
        targetVersion: input.targetVersion ?? null,
        reversible: input.reversible,
        summary: input.summary,
        createdAt: nowIso(t),
      })
      .returning()
      .get();
    emit(t, 'approval.requested', { approvalId: row.id, kind: row.kind, targetId: row.targetId, targetVersion: row.targetVersion });
    return row;
  });
}

/** 새 버전이 생겨 대체된 결재를 막는다. 사람의 결정이 아니므로 결정자는 없다. */
export function expirePendingApprovals(c: Ctx, kind: ApprovalKind, targetId: string): void {
  const pending = c.db.select().from(approvals).where(and(eq(approvals.kind, kind), eq(approvals.targetId, targetId), eq(approvals.status, 'pending'))).all();
  for (const a of pending) {
    c.db.update(approvals).set({ status: 'expired' }).where(and(eq(approvals.id, a.id), eq(approvals.status, 'pending'))).run();
    emit(c, 'approval.decided', { approvalId: a.id, kind: a.kind, targetId: a.targetId, status: 'expired' });
  }
}

export interface DecideInput {
  approvalId: string;
  /** 버튼을 누른 Discord 계정 */
  discordUserId: string;
  decision: ApprovalDecision;
  note?: string;
  choice?: string;
}

export function decideApproval(c: Ctx, input: DecideInput): ApprovalRow {
  // 계정 확인이 가장 먼저다. CEO가 아니면 아무것도 읽거나 쓰지 않는다.
  if (input.discordUserId !== c.config.ceoDiscordId) throw new NotCeoError();

  return inTx(c, (t) => {
    const a = t.db.select().from(approvals).where(eq(approvals.id, input.approvalId)).get();
    if (!a) throw new NotFoundError(`결재 ${input.approvalId}`);
    if (a.status === 'expired') throw new StaleApprovalError();
    if (a.status !== 'pending') throw new AlreadyDecidedError();
    if (a.kind === 'plan') {
      const plan = getPlan(t, a.targetId);
      if (a.targetVersion !== plan.version || !isLatestPlanVersion(t, plan)) throw new StaleApprovalError();
    }
    if (input.decision === 'revision' && a.kind !== 'plan' && a.kind !== 'rule') {
      throw new OfficeError('bad-decision', '수정 요청은 계획서와 규칙 결재에만 있어요');
    }

    const now = nowIso(t);
    const result = t.db
      .update(approvals)
      .set({ status: input.decision, decidedByDiscordId: input.discordUserId, decidedAt: now, note: input.note ?? null, choice: input.choice ?? null })
      .where(and(eq(approvals.id, a.id), eq(approvals.status, 'pending')))
      .run();
    if (result.changes !== 1) throw new AlreadyDecidedError();
    emit(t, 'approval.decided', { approvalId: a.id, kind: a.kind, targetId: a.targetId, status: input.decision });

    const ceo = { kind: 'approval-bot', discordUserId: input.discordUserId } as const;
    if (a.kind === 'plan') {
      applyCeoPlanDecision(t, a.targetId, input.decision, input.note ?? null, ceo);
    } else if (TICKET_APPROVAL_KINDS.includes(a.kind)) {
      applyTicketEvent(t, a.targetId, { type: input.decision === 'approved' ? 'approval.approved' : 'approval.rejected' }, ceo);
    }
    // push, main-merge, revert는 Git 고양이(4단계), budget·rule은 3·6단계에서 결정 결과를 실행한다.
    return t.db.select().from(approvals).where(eq(approvals.id, a.id)).get()!;
  });
}

export function pendingApprovals(c: Ctx): ApprovalRow[] {
  return c.db.select().from(approvals).where(eq(approvals.status, 'pending')).all();
}
