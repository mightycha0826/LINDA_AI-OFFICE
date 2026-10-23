// #비서실 대화를 PM에게 (6장, 2026-10-23 CEO 결정): 비서실장과 정리해 등록한 지시면, PM이 그 직전 대화를 읽고 시작한다.
// 시스템 봇은 메시지 내용 권한이 없다. 그래서 #비서실을 원래 읽는 헤르메스(백서진) 봇 인증으로 Discord REST에서
// 지시 직전 2시간, 최근 30개만 읽는다. 읽은 대화는 지시마다 한 번 저장하고 다시 읽지 않는다.
import { REST, Routes, type APIMessage } from 'discord.js';
import type { Ctx } from '../context.ts';

export interface ChatLine {
  at: string;
  from: string;
  text: string;
}
/** 지시 시각(Discord ID)을 주면 그 앞 #비서실 대화를 오래된 순으로 */
export type SecretaryChatReader = (beforeId: string) => Promise<ChatLine[]>;

export const SECRETARY_CHAT_WINDOW_MS = 2 * 3_600_000;
const MAX_LINES = 30;
const MAX_LINE_CHARS = 1000;
const DISCORD_EPOCH = 1_420_070_400_000n;

/** 시각 → 그 시각의 Discord ID (REST before 인자용) */
export const snowflakeAt = (iso: string): string => ((BigInt(new Date(iso).getTime()) - DISCORD_EPOCH) << 22n).toString();
const timeOf = (id: string): number => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

/** REST 응답(최신 순) → 주인과 봇의 말만, 창 안의 것만, 오래된 순 */
export function chatLines(c: Ctx, raw: Pick<APIMessage, 'id' | 'content' | 'author'>[], beforeId: string): ChatLine[] {
  const since = timeOf(beforeId) - SECRETARY_CHAT_WINDOW_MS;
  return raw
    .filter((m) => m.content.trim() && timeOf(m.id) >= since && (m.author.id === c.config.ceoDiscordId || m.author.bot))
    .slice(0, MAX_LINES)
    .reverse()
    .map((m) => ({
      at: new Date(timeOf(m.id)).toISOString(),
      from: m.author.id === c.config.ceoDiscordId ? '사장님' : (m.author.global_name ?? m.author.username),
      text: m.content.slice(0, MAX_LINE_CHARS),
    }));
}

export function secretaryChatReader(c: Ctx, chiefToken: string): SecretaryChatReader {
  const rest = new REST().setToken(chiefToken);
  return async (beforeId) => {
    const channel = c.config.discord.channels.secretary;
    if (!channel) return [];
    const raw = (await rest.get(Routes.channelMessages(channel), { query: new URLSearchParams({ before: beforeId, limit: '50' }) })) as APIMessage[];
    return chatLines(c, raw, beforeId);
  };
}
