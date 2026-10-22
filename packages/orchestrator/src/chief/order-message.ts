// 지시 등록의 Discord 메시지 ID (6장 create_order, 9장 서버 규칙).
// 헤르메스는 메시지 ID를 모델에게 보여 주지 않는다. 그래서 시스템 봇이 #비서실에 주인이 쓴
// 마지막 메시지의 ID와 시각만 기록하고, 비서실장이 ID를 넣지 못하면 그것을 쓴다. 내용은 받지 않는다.
import { getState, setState, type Ctx } from '../context.ts';
import { OfficeError } from '../errors.ts';
import { markCeoActive } from '../discord/presence.ts';

const KEY = 'chief.lastCeoMessage';
/** 이보다 오래된 메시지 ID는 지시 등록에 쓰지 않는다 */
export const ORDER_MESSAGE_MAX_AGE_MS = 10 * 60_000;

export interface LastMessage {
  id: string;
  at: string;
}

export function lastCeoMessage(c: Ctx): LastMessage | null {
  return getState<LastMessage | null>(c, KEY, null);
}

export interface IncomingMessage {
  guildId: string | null;
  channelId: string;
  authorId: string;
  messageId: string;
}

/** 시스템 봇이 받은 메시지. 주인 메시지면 접속 중으로 표시하고, #비서실이면 ID를 기록한다. */
export function onDiscordMessage(c: Ctx, m: IncomingMessage): void {
  if (m.guildId !== c.config.discord.guildId || m.authorId !== c.config.ceoDiscordId) return;
  markCeoActive(c);
  const secretary = c.config.discord.channels.secretary;
  if (secretary && m.channelId === secretary) {
    setState(c, KEY, { id: m.messageId, at: c.clock.now().toISOString() } satisfies LastMessage);
  }
}

/** create_order에 쓸 메시지 ID. 넣은 ID가 있으면 그것, 없으면 #비서실 주인 마지막 메시지(10분 이내). */
export function resolveOrderMessageId(c: Ctx, provided: string | undefined): { id: string; source: 'provided' | 'last-ceo-message' } {
  if (provided) return { id: provided, source: 'provided' };
  const last = lastCeoMessage(c);
  if (!last) throw new OfficeError('no-message-id', '#비서실에서 주인 메시지를 찾지 못해 지시를 등록하지 않았어요. 주인에게 다시 말해 달라고 하거나 /지시를 안내하세요');
  if (c.clock.now().getTime() - new Date(last.at).getTime() > ORDER_MESSAGE_MAX_AGE_MS) {
    throw new OfficeError('stale-message-id', '#비서실의 주인 마지막 메시지가 10분보다 오래돼 지시를 등록하지 않았어요. 주인에게 다시 말해 달라고 하거나 /지시를 안내하세요');
  }
  return { id: last.id, source: 'last-ceo-message' };
}
