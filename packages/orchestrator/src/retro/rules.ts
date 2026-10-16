// 회사 규칙 (14장 3~6). 제안 → GPT 관문 → CEO 승인 → 적용. AI가 스스로 규칙을 바꾸지 못한다(DB 트리거로도 막음).
// - 권한을 늘리거나 결재·검토를 건너뛰는 문장은 관문 전에 코드가 먼저 거른다.
// - 적용 횟수: 규칙이 역할 카드에 붙어 일한 대상(티켓, 계획 단계면 지시)마다 한 번.
// - 재발 횟수: 규칙이 적용된 대상에서 같은 분류 반려가 다시 나온 횟수.
// - 10번 적용했는데 재발 비율이 승인 전보다 줄지 않으면 "효과 없음" 삭제 제안. 역할당 10개를 넘으면 정리 제안.
import { and, desc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import type { EmployeeRole, ReasonCategory, RuleCandidate, TicketType } from '@ai-office/shared';
import { inTx, newId, nowIso, type Ctx } from '../context.ts';
import { requestApproval } from '../core/approvals.ts';
import { approvals, messages, ruleApplications, rules, tickets } from '../db/schema.ts';
import { OfficeError } from '../errors.ts';

export type RuleRow = typeof rules.$inferSelect;

export const MAX_RULES_PER_ROLE = 10;
/** 효과를 판단하기 전에 쌓을 적용 횟수 */
export const EFFECT_MIN_APPLIED = 10;
const BASELINE_DAYS = 30;

/**
 * 규칙 문장 사전 검사 (14장 4: 권한을 늘리거나 결재를 건너뛰는 내용은 무조건 반려).
 * 관문(GPT)도 같은 기준으로 보지만, AI 판단에만 맡기지 않고 코드가 먼저 거른다.
 */
export function ruleViolations(text: string): string[] {
  const t = text.replace(/\s+/g, ' ');
  const out: string[] = [];
  if (/(권한|permission|허가|접근).{0,24}(늘|추가|부여|확대|허용|풀|열어|얻)/i.test(t)) out.push('권한을 늘리는 내용');
  if (/(결재|승인|검토|리뷰|관문|테스트|검사|확인|CEO|review|approval|test).{0,24}(건너|생략|없이|빼고|skip|우회|생략|자동\s*(으로)?\s*(승인|통과)|안\s*(받|거치))/i.test(t)) out.push('결재·검토를 건너뛰는 내용');
  if (/(--force|강제\s*푸시|force\s*push|main.{0,10}직접|sudo|관리자\s*권한)/i.test(t)) out.push('위험한 명령');
  if (/(토큰|비밀\s*번호|비밀번호|비밀\s*키|\.env|secret|password|api\s*key).{0,24}(읽|출력|보내|사용|복사|적)/i.test(t)) out.push('비밀 정보를 다루는 내용');
  if (/(상한|한도|limit|cap).{0,24}(무시|넘|늘|해제|풀)/i.test(t)) out.push('한도를 무시하는 내용');
  return out;
}

export function scopeLabel(scope: RuleRow['scope']): string {
  return [scope.role ?? '모든 역할', scope.ticketType ?? '모든 종류'].join(' · ');
}

/** 관문을 통과한 후보를 proposed 규칙으로 넣고 #결재함에 "규칙 추가 제안"을 올린다 */
export function proposeRule(c: Ctx, cand: RuleCandidate, source: 'auto' | 'weekly' | 'revision'): RuleRow {
  const scope: RuleRow['scope'] = { ...(cand.scope.role ? { role: cand.scope.role } : {}), ...(cand.scope.ticketType ? { ticketType: cand.scope.ticketType } : {}) };
  return inTx(c, (t) => {
    const dup = t.db
      .select()
      .from(rules)
      .where(and(eq(rules.text, cand.rule), inArray(rules.status, ['proposed', 'active'])))
      .get();
    if (dup) throw new OfficeError('rule-duplicate', `같은 규칙이 이미 있어요(${dup.id})`);
    const row = t.db
      .insert(rules)
      .values({ id: newId(), scope, text: cand.rule, evidence: cand.evidence, reasonCategory: cand.reasonCategory, source, createdAt: nowIso(t) })
      .returning()
      .get();
    requestApproval(t, {
      kind: 'rule',
      targetId: row.id,
      reversible: 'reversible',
      summary: `규칙 추가 제안 — [${scopeLabel(scope)}] ${cand.rule} (근거 ${cand.evidence.join(', ')} · ${cand.reasonCategory})`,
    });
    return row;
  });
}

/** 쓰던 규칙을 내리자는 제안 (효과 없음, 10개 초과 정리). 이미 결재 대기 중이면 다시 올리지 않는다 */
export function proposeRetire(c: Ctx, ruleId: string, reason: string): boolean {
  return inTx(c, (t) => {
    const r = t.db.select().from(rules).where(eq(rules.id, ruleId)).get();
    if (!r || r.status !== 'active') return false;
    const pending = t.db.select().from(approvals).where(and(eq(approvals.kind, 'rule'), eq(approvals.targetId, ruleId), eq(approvals.status, 'pending'))).get();
    if (pending) return false;
    requestApproval(t, { kind: 'rule', targetId: ruleId, reversible: 'reversible', summary: `규칙 삭제 제안 — ${reason}: [${scopeLabel(r.scope)}] ${r.text} (적용 ${r.appliedCount} · 재발 ${r.recurrenceCount})` });
    return true;
  });
}

/** 같은 분류 반려 비율: 그 기간에 검토받은 티켓 중 이 분류로 반려된 티켓의 비율 */
function failRate(c: Ctx, category: ReasonCategory, from: string, to: string): number {
  const reviewed = c.db
    .select({ n: sql<number>`count(distinct ${messages.ticketId})` })
    .from(messages)
    .where(and(eq(messages.kind, 'review'), gte(messages.createdAt, from), lt(messages.createdAt, to)))
    .get()?.n ?? 0;
  if (!reviewed) return 0;
  const failed = c.db
    .select({ n: sql<number>`count(distinct ${messages.ticketId})` })
    .from(messages)
    .where(and(eq(messages.kind, 'review'), eq(messages.reviewVerdict, 'fail'), eq(messages.reasonCategory, category), gte(messages.createdAt, from), lt(messages.createdAt, to)))
    .get()?.n ?? 0;
  return failed / reviewed;
}

/**
 * CEO의 규칙 결재 결과를 반영한다 (decideApproval 안, 같은 트랜잭션).
 * - 후보(proposed): 승인 → active, 반려 → retired, 수정 요청 → retired + 메모를 남겨 PM이 새 후보로 다시 쓴다
 * - 쓰던 규칙(active)의 삭제 제안: 승인 → retired, 그 밖 → 그대로 active
 */
export function applyRuleDecision(c: Ctx, ruleId: string, decision: 'approved' | 'rejected' | 'revision', note: string | null): void {
  const r = c.db.select().from(rules).where(eq(rules.id, ruleId)).get();
  if (!r) throw new OfficeError('not-found', `규칙 ${ruleId}`);
  const now = nowIso(c);
  if (r.status === 'proposed') {
    if (decision === 'approved') {
      const from = new Date(new Date(now).getTime() - BASELINE_DAYS * 24 * 3_600_000).toISOString();
      c.db.update(rules).set({ status: 'active', activatedAt: now, baselineRate: failRate(c, r.reasonCategory, from, now) }).where(eq(rules.id, ruleId)).run();
    } else {
      c.db
        .update(rules)
        .set({ status: 'retired', retiredReason: decision === 'revision' ? `수정 요청: ${note ?? ''}` : `CEO 반려${note ? `: ${note}` : ''}` })
        .where(eq(rules.id, ruleId))
        .run();
    }
  } else if (r.status === 'active' && decision === 'approved') {
    c.db.update(rules).set({ status: 'retired', retiredReason: 'CEO 승인으로 삭제' }).where(eq(rules.id, ruleId)).run();
  }
}

/** 범위가 맞는 active 규칙. 최신 것부터 역할당 최대 10개 (14장 5) */
export function activeRuleRows(c: Ctx, role: EmployeeRole, ticketType?: TicketType): RuleRow[] {
  return c.db
    .select()
    .from(rules)
    .where(eq(rules.status, 'active'))
    .orderBy(desc(rules.activatedAt), desc(rules.createdAt))
    .all()
    .filter((r) => (!r.scope.role || r.scope.role === role) && (!r.scope.ticketType || r.scope.ticketType === ticketType))
    .slice(0, MAX_RULES_PER_ROLE);
}

/** 규칙이 역할 카드에 붙어 일한 대상을 기록한다. 같은 대상은 한 번만 센다 */
export function recordRuleApplications(c: Ctx, ruleIds: string[], targetId: string): void {
  if (ruleIds.length === 0) return;
  inTx(c, (t) => {
    for (const ruleId of ruleIds) {
      const r = t.db.insert(ruleApplications).values({ ruleId, targetId, createdAt: nowIso(t) }).onConflictDoNothing().run();
      if (r.changes === 1) t.db.update(rules).set({ appliedCount: sql`${rules.appliedCount} + 1` }).where(eq(rules.id, ruleId)).run();
    }
  });
}

/**
 * 반려 기록을 훑어 재발을 센다. 규칙이 적용된 티켓(또는 그 티켓의 지시)에서
 * 같은 분류 반려가 규칙 활성화 뒤에 나오면 recurrenceCount + 1. 처리한 위치(rowid)를 돌려준다.
 */
export function countRecurrences(c: Ctx, afterRowid: number): number {
  const fails = c.db
    .select({ rowid: sql<number>`${messages}.rowid`, ticketId: messages.ticketId, category: messages.reasonCategory, at: messages.createdAt })
    .from(messages)
    .where(and(gt(sql`${messages}.rowid`, afterRowid), eq(messages.kind, 'review'), eq(messages.reviewVerdict, 'fail')))
    .orderBy(sql`${messages}.rowid`)
    .all();
  let last = afterRowid;
  inTx(c, (t) => {
    for (const f of fails) {
      last = f.rowid;
      if (!f.ticketId || !f.category) continue;
      const tk = t.db.select().from(tickets).where(eq(tickets.id, f.ticketId)).get();
      const targets = [f.ticketId, ...(tk ? [tk.orderId] : [])];
      const applied = t.db
        .select({ ruleId: ruleApplications.ruleId })
        .from(ruleApplications)
        .where(inArray(ruleApplications.targetId, targets))
        .all()
        .map((x) => x.ruleId);
      if (applied.length === 0) continue;
      const hit = t.db
        .select()
        .from(rules)
        .where(and(inArray(rules.id, [...new Set(applied)]), eq(rules.status, 'active'), eq(rules.reasonCategory, f.category)))
        .all()
        .filter((r) => r.activatedAt && r.activatedAt <= f.at);
      for (const r of hit) t.db.update(rules).set({ recurrenceCount: sql`${rules.recurrenceCount} + 1` }).where(eq(rules.id, r.id)).run();
    }
  });
  return last;
}

/** 효과 없음: 10번 이상 적용했는데 재발 비율이 승인 전 비율보다 낮아지지 않음 */
export function isIneffective(r: RuleRow): boolean {
  if (r.status !== 'active' || r.appliedCount < EFFECT_MIN_APPLIED) return false;
  const rate = r.recurrenceCount / r.appliedCount;
  const base = r.baselineRate ?? 0;
  return base === 0 ? r.recurrenceCount > 0 : rate >= base;
}

/**
 * 역할마다 active 규칙이 10개를 넘으면, 넘는 수만큼 정리 후보를 고른다.
 * 효과 없는 것 → 재발 비율이 높은 것 → 오래된 것 순.
 */
export function cleanupCandidates(c: Ctx): RuleRow[] {
  const active = c.db.select().from(rules).where(eq(rules.status, 'active')).all();
  const roles = new Set<string>(active.map((r) => r.scope.role ?? '*'));
  const picked = new Map<string, RuleRow>();
  for (const role of roles) {
    const mine = active.filter((r) => !r.scope.role || role === '*' || r.scope.role === role);
    if (mine.length <= MAX_RULES_PER_ROLE) continue;
    const ranked = [...mine].sort((a, b) => {
      const ia = Number(isIneffective(a));
      const ib = Number(isIneffective(b));
      if (ia !== ib) return ib - ia;
      const ra = a.appliedCount ? a.recurrenceCount / a.appliedCount : 0;
      const rb = b.appliedCount ? b.recurrenceCount / b.appliedCount : 0;
      if (ra !== rb) return rb - ra;
      return (a.activatedAt ?? a.createdAt) < (b.activatedAt ?? b.createdAt) ? -1 : 1;
    });
    for (const r of ranked.slice(0, mine.length - MAX_RULES_PER_ROLE)) picked.set(r.id, r);
  }
  return [...picked.values()];
}
