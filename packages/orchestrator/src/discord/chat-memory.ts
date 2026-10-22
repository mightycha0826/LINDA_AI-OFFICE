import { eq, like } from 'drizzle-orm';
import { clearState, getState, setState, type Ctx } from '../context.ts';
import { systemState } from '../db/schema.ts';

export const CHAT_MEMORY_TURNS = 20;
export const CHAT_MEMORY_MS = 6 * 60 * 60_000;
export const CHAT_MEMORY_CHARS = 16_000;
const PREFIX = 'staff.chatMemory:';
const keyFor = (employeeId: string, channelId: string) => `${PREFIX}${employeeId}:${channelId}`;
export interface ChatTurn { at: number; owner: string; me: string; messageId?: string }

function bounded(c: Ctx, raw: unknown): ChatTurn[] {
  const cutoff = c.clock.now().getTime() - CHAT_MEMORY_MS;
  const turns = (Array.isArray(raw) ? raw : []).filter((x): x is ChatTurn => x && typeof x.at === 'number' && x.at >= cutoff && typeof x.owner === 'string' && typeof x.me === 'string').slice(-CHAT_MEMORY_TURNS);
  let chars = 0;
  const kept: ChatTurn[] = [];
  for (const turn of turns.reverse()) {
    const trimmed = { at: turn.at, owner: turn.owner.slice(0, 4000), me: turn.me.slice(0, 4000), ...(typeof turn.messageId === 'string' ? { messageId: turn.messageId } : {}) };
    const size = trimmed.owner.length + trimmed.me.length;
    if (chars + size > CHAT_MEMORY_CHARS) break;
    kept.unshift(trimmed);
    chars += size;
  }
  return kept;
}

export function readStaffConversation(c: Ctx, employeeId: string, channelId: string): ChatTurn[] {
  const key = keyFor(employeeId, channelId);
  const turns = bounded(c, getState(c, key, []));
  if (turns.length) setState(c, key, turns);
  else clearState(c, key);
  return turns;
}

export function rememberStaffConversation(c: Ctx, employeeId: string, channelId: string, turns: ChatTurn[]): void {
  setState(c, keyFor(employeeId, channelId), bounded(c, turns));
}

export function forgetStaffConversation(c: Ctx, employeeId: string, channelId: string): void {
  clearState(c, keyFor(employeeId, channelId));
}

/** 열지 않는 채널의 지난 대화도 주기적으로 지운다. 화면·이벤트·보고에는 기록하지 않는다. */
export function pruneStaffConversations(c: Ctx): void {
  for (const row of c.db.select().from(systemState).where(like(systemState.key, `${PREFIX}%`)).all()) {
    const turns = bounded(c, row.value);
    if (!turns.length) c.db.delete(systemState).where(eq(systemState.key, row.key)).run();
    else setState(c, row.key, turns);
  }
}
