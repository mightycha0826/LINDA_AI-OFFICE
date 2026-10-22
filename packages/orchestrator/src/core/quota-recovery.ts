// CEO policy (2026-10-22): check every 30 minutes; refill a capped ticket once its quota window recovers.
import { and, desc, eq, sql } from 'drizzle-orm';
import { getState, inTx, isStopped, nowIso, setState, type Ctx } from '../context.ts';
import { employees, events, tickets, usage } from '../db/schema.ts';
import { enforceBudgets, type EmployeeRow } from './budget.ts';
import { enforceGuests } from './guests.ts';
import { raiseCaps } from './guards.ts';
import { quotaResetAt, rememberQuotaResets, reportedQuotaAvailable, type ReportedAccount } from './quota-window.ts';

export const QUOTA_CHECK_MS = 30 * 60_000;
export const ESTIMATED_QUOTA_WINDOW_MS = 5 * 3_600_000;
export interface QuotaRecoveryResult { checked: boolean; resumed: string[] }

export function recoverQuotaPaused(c: Ctx, canSpend: (employee: EmployeeRow) => boolean): QuotaRecoveryResult {
  return inTx(c,t => {
    if (isStopped(t)) return {checked:false,resumed:[]};
    const now = t.clock.now().getTime();
    const previous = getState<string | null>(t,'quotaRecovery.lastCheckAt',null);
    if (previous && now-Date.parse(previous) < QUOTA_CHECK_MS) return {checked:false,resumed:[]};
    setState(t,'quotaRecovery.lastCheckAt',nowIso(t));
    rememberQuotaResets(t);
    const resumed = new Set([...enforceBudgets(t).resumed,...enforceGuests(t).resumed]);
    const waiting = t.db.select().from(tickets).where(and(eq(tickets.status,'paused'),eq(tickets.pauseReason,'cap'))).all();
    for (const tk of waiting) {
      if (!tk.pausedFrom) continue;
      const id = tk.pausedFrom === 'in_review' ? tk.reviewerId : tk.assigneeId;
      const employee = t.db.select().from(employees).where(eq(employees.id,id)).get();
      if (!employee || employee.leftAt || !canSpend(employee)) continue;
      const provider = employee.brain.provider === 'claude-code' ? 'claude' : employee.brain.provider === 'codex' ? 'gpt' : null;
      // Local safety caps have no external token reset to wait for.
      if (!provider) continue;
      const accountKey = employee.brain.provider !== 'none' && 'account' in employee.brain && employee.brain.account
        ? `account.guest.${employee.brain.account}` : `account.${provider}`;
      const account = getState<ReportedAccount | null>(t,accountKey,null);
      if (!reportedQuotaAvailable(account,now)) continue;
      const pause = t.db.select({at:events.createdAt}).from(events).where(and(
        eq(events.type,'ticket.status'),sql`json_extract(${events.payload}, '$.ticketId') = ${tk.id}`,
        sql`json_extract(${events.payload}, '$.event') = 'system.pause'`,sql`json_extract(${events.payload}, '$.reason') = 'cap'`,
      )).orderBy(desc(events.seq)).get();
      const key = `quotaRecovery.pause:${tk.id}`;
      const seen = getState<{version:number;at:string} | null>(t,key,null);
      const pausedAt = pause?.at ?? (seen?.version === tk.version ? seen.at : nowIso(t));
      if (!pause && seen?.version !== tk.version) setState(t,key,{version:tk.version,at:pausedAt});
      const since = Date.parse(pausedAt);
      if (!Number.isFinite(since)) continue;
      const reset = accountKey.startsWith('account.guest.') ? Date.parse(account?.fiveHourResetsAt ?? '') : quotaResetAt(t,provider,'fiveHour');
      const knownFutureReset = Date.parse(account?.fiveHourResetsAt ?? '');
      const originalWindow = account && Date.parse(account.at) <= since && knownFutureReset > since;
      const recovered = reset > since && reset <= now || (!originalWindow && now-since >= ESTIMATED_QUOTA_WINDOW_MS);
      if (!recovered) continue;
      // Keep lifetime counters. Grant one normal allowance after this pause's window recovered.
      const caps=t.config.ticketCaps;
      const lastCall=t.db.select({input:usage.inputTokens,output:usage.outputTokens}).from(usage).where(eq(usage.ticketId,tk.id)).orderBy(desc(usage.createdAt),sql`rowid DESC`).get();
      // A single real CLI call can exceed its planning estimate (including cache reads).
      // Leave room for another comparable work/review pair instead of re-capping every successful response.
      const tokenAllowance=Math.max(caps.minTokens,Math.ceil(tk.estimatedTokens*caps.tokenMultiplier),((lastCall?.input ?? 0)+(lastCall?.output ?? 0))*2);
      raiseCaps(t,tk.id,{
        tokenCap:Math.max(tk.tokenCap,tk.tokensUsed+tokenAllowance),
        turnCap:Math.max(tk.turnCap,tk.turnsUsed+caps.maxTurns),
      });
      resumed.add(tk.id);
    }
    const result={checked:true,resumed:[...resumed]};
    setState(t,'quotaRecovery.lastResult',{at:nowIso(t),...result});
    return result;
  });
}
