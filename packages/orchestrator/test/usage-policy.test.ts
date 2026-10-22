import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockBudget, budgetStatus, enforceBudgets, recordUsage } from '../src/core/budget.ts';
import { blockGuest, guestEmployeeId, guestExhausted, recordGuestUsage, setGuestOn } from '../src/core/guests.ts';
import { isOverCap, recordTurn, resumeUncappedTickets } from '../src/core/guards.ts';
import { applyTicketEvent } from '../src/core/tickets.ts';
import { createBrainRegistry } from '../src/brains/registry.ts';
import { ClaudeCodeBrain } from '../src/brains/claude-code.ts';
import { planOutput } from '../src/brains/mock.ts';
import { employees } from '../src/db/schema.ts';
import { CEO, approvedTickets, asClaudeResearcher, setup, ticket } from './helpers.ts';

const unlimited={enforceEstimates:false,enforceTicketCaps:false};
const spend=(s:ReturnType<typeof setup>,budget:'dev'|'research'|'review')=>recordUsage(s.ctx,{budget,inputTokens:50_000_000,outputTokens:1_000_000,estimatedPct:5000,estimatedWeeklyPct:5000,source:'estimated'});

describe('CEO unlimited cloud usage policy',()=>{
  it('keeps all estimated usage as reference data with no company quota',()=>{
    const s=setup({config:{usagePolicy:unlimited}});
    for(const budget of ['dev','research','review'] as const){spend(s,budget);expect(budgetStatus(s.ctx,budget)).toMatchObject({exhausted:false,fiveHour:{used:5000,limit:null},weekly:{used:5000,limit:null}});}
  });
  it('finishes Claude work and Codex review even when each call exceeds token and turn caps',async()=>{
    const s=setup({config:{usagePolicy:unlimited,ticketCaps:{maxTurns:1}},mock:{tokensPerCall:20_000_000}});
    const {tickets:[tk]}=await approvedTickets(s);
    spend(s,'dev');spend(s,'review');await s.engine.runUntilIdle();
    expect(ticket(s,tk!.id).status).toBe('done');expect(ticket(s,tk!.id).tokensUsed).toBeGreaterThan(ticket(s,tk!.id).tokenCap);expect(isOverCap(s.ctx,tk!.id)).toBe(false);
  });
  it('also removes caps for a Codex assignee and a Claude reviewer',async()=>{
    const s=setup({config:{usagePolicy:unlimited,ticketCaps:{maxTurns:1}},mock:{tokensPerCall:20_000_000},handlers:{plan:()=>planOutput({tickets:[{...planOutput().tickets[0]!,assignee:'dev-b',reviewer:'developer'}]})}});
    const {tickets:[tk]}=await approvedTickets(s);spend(s,'review');spend(s,'dev');await s.engine.runUntilIdle();expect(ticket(s,tk!.id).status).toBe('done');
  });
  it('releases old cap and estimate-budget pauses immediately without waiting for another quota window',async()=>{
    for(const reason of ['cap','budget'] as const){
      const s=setup();const {tickets:[tk]}=await approvedTickets(s);
      if(reason==='cap')recordTurn(s.ctx,tk!.id,1_000_000);else{spend(s,'dev');enforceBudgets(s.ctx);}
      expect(ticket(s,tk!.id).pauseReason).toBe(reason);s.config.usagePolicy={...unlimited};await s.engine.runUntilIdle();expect(ticket(s,tk!.id).status).toBe('done');
    }
  });
  it('only an actual provider block stops Claude or Codex and work resumes after the block expires',async()=>{
    for(const stage of ['work','review'] as const){
      const s=setup({config:{usagePolicy:unlimited}});const {tickets:[tk]}=await approvedTickets(s);
      if(stage==='review')applyTicketEvent(s.ctx,tk!.id,{type:'ticket.submitted'},{kind:'employee',id:'developer'});
      const until=new Date(s.clock.now().getTime()+30*60_000).toISOString();blockBudget(s.ctx,stage==='work'?'dev':'review',until);
      await s.engine.runUntilIdle();expect(ticket(s,tk!.id)).toMatchObject({status:'paused',pauseReason:'budget'});
      s.clock.advance(30*60_000);await s.engine.runUntilIdle();expect(ticket(s,tk!.id).status).toBe('done');
    }
  });
  it('does not fall back to a local model because of an inflated research estimate',async()=>{
    const s=setup({config:{usagePolicy:unlimited},handlers:{plan:()=>planOutput({tickets:[{...planOutput().tickets[0]!,type:'research',assignee:'strategy',reviewer:'qa-local'}]})}});
    asClaudeResearcher(s);const {tickets:[tk]}=await approvedTickets(s);spend(s,'research');await s.engine.runUntilIdle();expect(ticket(s,tk!.id)).toMatchObject({status:'done',lowPrecision:false});
  });
  it('does not override a CEO stop or local-only safety caps',async()=>{
    const s=setup();const {tickets:[tk]}=await approvedTickets(s);recordTurn(s.ctx,tk!.id,1_000_000);s.config.usagePolicy={...unlimited};s.engine.stop(CEO);
    expect(resumeUncappedTickets(s.ctx)).toEqual([]);expect(await s.engine.step()).toBe(0);expect(ticket(s,tk!.id).status).toBe('paused');
    const local=setup({config:{usagePolicy:unlimited}});const {tickets:[lt]}=await approvedTickets(local);
    for(const id of ['developer','reviewer'])local.db.update(employees).set({brain:{provider:'ollama',model:'gemma4:12b'}}).where(eq(employees.id,id)).run();
    expect(recordTurn(local.ctx,lt!.id,1_000_000).capped).toBe(true);
  });
  it('ignores guest percentage caps while preserving actual provider blocks',()=>{
    const s=setup({config:{usagePolicy:unlimited}});mkdirSync(s.config.paths.data,{recursive:true});writeFileSync(join(s.config.paths.data,'guests.json'),JSON.stringify({guests:[{id:'friend',name:'친구',provider:'claude'}]}));
    setGuestOn(s.ctx,'friend',true,CEO);const e=s.db.select().from(employees).where(eq(employees.id,guestEmployeeId('friend'))).get()!;
    recordGuestUsage(s.ctx,e,{account:{fiveHourPct:99,weeklyPct:99},pct:99,weeklyPct:99});expect(guestExhausted(s.ctx,e)).toBe(false);blockGuest(s.ctx,e);expect(guestExhausted(s.ctx,e)).toBe(true);
  });
  it('omits the Claude CLI max-turns option in unlimited mode',()=>{
    const s=setup({config:{usagePolicy:unlimited}});const registry=createBrainRegistry(s.config);const e=s.db.select().from(employees).where(eq(employees.id,'developer')).get()!;
    const brain=registry.brainFor(e,{lowPrecision:false}) as ClaudeCodeBrain;
    expect(brain.buildArgs('readonly',{settings:'settings.json',systemPrompt:'prompt.md'},{})).not.toContain('--max-turns');
  });
});
