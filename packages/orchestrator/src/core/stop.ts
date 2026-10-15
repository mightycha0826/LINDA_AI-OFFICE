// 비상 정지 (DESIGN.md 7장). /정지와 /재개는 CEO 계정만 쓸 수 있다.
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { emit, inTx, isStopped, setState, type Ctx } from '../context.ts';
import { tickets } from '../db/schema.ts';
import { NotCeoError } from '../errors.ts';
import { applyTicketEvent } from './tickets.ts';

export { isStopped };

/** 진행 중인 AI 호출을 끊는 쪽(엔진)에 알리기 위한 훅. */
export type AbortHook = () => void;

export function stopAll(c: Ctx, discordUserId: string, abortInFlight?: AbortHook): string[] {
  if (discordUserId !== c.config.ceoDiscordId) throw new NotCeoError();
  abortInFlight?.();
  return inTx(c, (t) => {
    setState(t, 'stopped', true);
    const ceo = { kind: 'approval-bot', discordUserId } as const;
    const active = t.db
      .select()
      .from(tickets)
      .where(notInArray(tickets.status, ['done', 'cancelled', 'paused']))
      .all();
    for (const tk of active) applyTicketEvent(t, tk.id, { type: 'system.pause', reason: 'ceo-stop' }, ceo);
    emit(t, 'system.paused', { by: 'ceo', tickets: active.map((tk) => tk.id) });
    return active.map((tk) => tk.id);
  });
}

/**
 * /재개: 정지를 풀고 /재개로 풀리는 이유(CEO 정지, 상한, 시스템 이상)로 멈춘 티켓을 이어간다.
 * 한도 소진으로 멈춘 티켓은 그대로 둔다. 한도가 다시 차야 풀린다.
 */
export function resumeAll(c: Ctx, discordUserId: string): string[] {
  if (discordUserId !== c.config.ceoDiscordId) throw new NotCeoError();
  return inTx(c, (t) => {
    const wasStopped = isStopped(t);
    setState(t, 'stopped', false);
    const ceo = { kind: 'approval-bot', discordUserId } as const;
    const paused = t.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.status, 'paused'), inArray(tickets.pauseReason, ['ceo-stop', 'cap', 'system-error'])))
      .all();
    const caps = t.config.ticketCaps;
    for (const tk of paused) {
      if (tk.pauseReason === 'cap') {
        // 상한을 그대로 두고 풀면 다음 호출에서 바로 다시 멈춘다. /재개는 처음 몫만큼 한 번 더 준다.
        t.db
          .update(tickets)
          .set({
            tokenCap: tk.tokenCap + Math.max(caps.minTokens, Math.ceil(tk.estimatedTokens * caps.tokenMultiplier)),
            turnCap: tk.turnCap + caps.maxTurns,
          })
          .where(eq(tickets.id, tk.id))
          .run();
      }
      applyTicketEvent(t, tk.id, { type: 'system.resume', cause: 'ceo-resume' }, ceo);
    }
    emit(t, 'system.resumed', { by: 'ceo', wasStopped, tickets: paused.map((tk) => tk.id) });
    return paused.map((tk) => tk.id);
  });
}
