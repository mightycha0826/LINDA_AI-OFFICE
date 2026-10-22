import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { clearState, getState, setState } from '../src/context.ts';
import { blockBudget, budgetStatus, recordUsage } from '../src/core/budget.ts';
import { recordTurn } from '../src/core/guards.ts';
import { QUOTA_CHECK_MS } from '../src/core/quota-recovery.ts';
import { rememberQuotaResets, type ReportedAccount } from '../src/core/quota-window.ts';
import { applyTicketEvent } from '../src/core/tickets.ts';
import { tickets } from '../src/db/schema.ts';
import { approvedTickets, CEO, setup, ticket } from './helpers.ts';

async function capped() {
  const s=setup(); const {tickets:[tk]}=await approvedTickets(s);
  recordTurn(s.ctx,tk!.id,75_000);
  return {...s,id:tk!.id};
}
const account = (s: ReturnType<typeof setup>, patch: Partial<ReportedAccount> = {}): ReportedAccount => ({
  provider:'claude',fiveHourPct:100,weeklyPct:20,fiveHourResetsAt:new Date(s.clock.now().getTime()+2*3_600_000).toISOString(),weeklyResetsAt:null,status:'rejected',at:s.clock.now().toISOString(),...patch,
});

describe('30-minute automatic quota recovery', () => {
  it('checks every 30m across repeated calls and refills only after the estimated 5h window', async () => {
    const s=await capped(); const before=ticket(s,s.id);
    expect(s.engine.recoverQuotas()).toEqual({checked:true,resumed:[]});
    s.clock.advance(QUOTA_CHECK_MS-1);
    expect(s.engine.recoverQuotas().checked).toBe(false);
    s.clock.advance(1);
    expect(s.engine.recoverQuotas()).toEqual({checked:true,resumed:[]});
    s.clock.advanceHours(4.5);
    expect(s.engine.recoverQuotas().resumed).toEqual([s.id]);
    const after=ticket(s,s.id);
    expect(after).toMatchObject({status:'in_progress',tokensUsed:before.tokensUsed,turnsUsed:before.turnsUsed});
    expect(after.tokenCap-after.tokensUsed).toBe(60_000);
    expect(after.turnCap-after.turnsUsed).toBe(s.config.ticketCaps.maxTurns);
    expect(s.engine.recoverQuotas().checked).toBe(false);
    recordTurn(s.ctx,s.id,after.tokenCap);
    s.clock.advance(QUOTA_CHECK_MS);
    expect(s.engine.recoverQuotas().resumed).toEqual([]);
    expect(ticket(s,s.id).status).toBe('paused');
  });
  it('uses a known provider reset before 5h, with no premature retry', async () => {
    const s=await capped(); setState(s.ctx,'account.claude',account(s));
    s.engine.recoverQuotas(); s.clock.advanceHours(1);
    expect(s.engine.recoverQuotas().resumed).toEqual([]);
    s.clock.advanceHours(1);
    expect(s.engine.recoverQuotas().resumed).toEqual([s.id]);
    expect(getState(s.ctx,'quotaRecovery.lastResult',null)).toMatchObject({resumed:[s.id]});
  });
  it('does not release weekly exhaustion, explicit blocks, offline state or a CEO stop', async () => {
    const s=await capped();
    setState(s.ctx,'account.claude',account(s,{weeklyPct:100,weeklyResetsAt:new Date(s.clock.now().getTime()+7*24*3_600_000).toISOString()}));
    s.clock.advanceHours(6);
    expect(s.engine.recoverQuotas().resumed).toEqual([]);
    clearState(s.ctx,'account.claude'); blockBudget(s.ctx,'dev',new Date(s.clock.now().getTime()+3_600_000).toISOString());
    s.clock.advance(QUOTA_CHECK_MS);
    expect(s.engine.recoverQuotas().resumed).toEqual([]);
    s.clock.advanceHours(1); setState(s.ctx,'online',false);
    expect(s.engine.recoverQuotas().checked).toBe(false);
    setState(s.ctx,'online',true); s.engine.stop(CEO);
    expect(s.engine.recoverQuotas().checked).toBe(false);
    expect(ticket(s,s.id).status).toBe('paused');
  });
  it('starts the preserved work on the next engine step after recovery', async () => {
    const s=await capped(); s.clock.advanceHours(5);
    expect(s.engine.recoverQuotas().resumed).toEqual([s.id]);
    await s.engine.step();
    expect(ticket(s,s.id).status).toBe('in_review');
    expect(ticket(s,s.id).tokensUsed).toBeGreaterThan(75_000);
  });
  it('allows another real work/review pair when a previous CLI call exceeded the planning estimate', async () => {
    const s=await capped();
    recordUsage(s.ctx,{budget:'dev',ticketId:s.id,inputTokens:900_000,outputTokens:10_000,estimatedPct:5,estimatedWeeklyPct:1,source:'estimated'});
    s.clock.advanceHours(5);
    expect(s.engine.recoverQuotas().resumed).toEqual([s.id]);
    expect(ticket(s,s.id).tokenCap-ticket(s,s.id).tokensUsed).toBe(1_820_000);
  });
  it('checks the interrupted reviewer account, not the developer account', async () => {
    const s=setup(); const {tickets:[tk]}=await approvedTickets(s);
    applyTicketEvent(s.ctx,tk!.id,{type:'ticket.submitted'},{kind:'employee',id:'developer'});
    recordTurn(s.ctx,tk!.id,75_000); s.clock.advanceHours(5);
    setState(s.ctx,'account.gpt',account(s,{provider:'gpt'}));
    expect(s.engine.recoverQuotas().resumed).toEqual([]);
    s.clock.advanceHours(2);
    expect(s.engine.recoverQuotas().resumed).toEqual([tk!.id]);
    expect(ticket(s,tk!.id).status).toBe('in_review');
  });
  it('keeps completed, cancelled and manually/error paused work out of recovery', async () => {
    for(const reason of ['ceo-stop','system-error','offline'] as const) {
      const s=setup(); const {tickets:[tk]}=await approvedTickets(s);
      applyTicketEvent(s.ctx,tk!.id,{type:'system.pause',reason},reason==='ceo-stop'?{kind:'approval-bot',discordUserId:CEO}:{kind:'orchestrator'});
      s.clock.advanceHours(24);
      expect(s.engine.recoverQuotas().resumed).toEqual([]);
      expect(ticket(s,tk!.id).pauseReason).toBe(reason);
    }
  });
  it('a real provider reset clears only the matching estimate window and is preserved across new reports', async () => {
    const s=setup();
    recordUsage(s.ctx,{budget:'dev',inputTokens:100,outputTokens:100,estimatedPct:60,estimatedWeeklyPct:12,source:'estimated'});
    expect(budgetStatus(s.ctx,'dev').exhausted).toBe(true);
    const reset=new Date(s.clock.now().getTime()+3_600_000).toISOString();
    setState(s.ctx,'account.claude',account(s,{fiveHourResetsAt:reset}));
    s.clock.advanceHours(1);
    expect(budgetStatus(s.ctx,'dev').fiveHour.used).toBe(0);
    expect(budgetStatus(s.ctx,'dev').weekly.used).toBe(12);
    rememberQuotaResets(s.ctx);
    setState(s.ctx,'account.claude',account(s,{fiveHourPct:1}));
    expect(budgetStatus(s.ctx,'dev').fiveHour.used).toBe(0);
    expect(budgetStatus(s.ctx,'dev').weekly.used).toBe(12);
  });
  it('unknown pause history starts a wait instead of granting fresh caps on each restart', async () => {
    const s=setup(); const {tickets:[tk]}=await approvedTickets(s);
    s.db.update(tickets).set({status:'paused',pauseReason:'cap',pausedFrom:'in_progress',tokensUsed:75_000}).where(eq(tickets.id,tk!.id)).run();
    expect(s.engine.recoverQuotas().resumed).toEqual([]);
    s.clock.advance(QUOTA_CHECK_MS);
    expect(s.engine.recoverQuotas().resumed).toEqual([]);
    s.clock.advanceHours(5);
    expect(s.engine.recoverQuotas().resumed).toEqual([tk!.id]);
  });
});
