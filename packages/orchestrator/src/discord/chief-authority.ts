import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChannelType, REST, Routes } from 'discord.js';

/** Hermes가 이미 사용하는 봇 인증만 읽는다. 다른 환경 값은 전달·출력하지 않는다. */
export function parseChiefDiscordToken(env: string): string | undefined {
  for (const line of env.split(/\r?\n/).reverse()) {
    const match = /^\s*(?:export\s+)?DISCORD_BOT_TOKEN\s*=\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    const value = match?.[1] ?? match?.[2] ?? match?.[3];
    if (value) return value;
  }
  return undefined;
}

export function loadChiefDiscordToken(homeDir: string): string | undefined {
  if (!homeDir) return undefined;
  const path = join(homeDir, '.env');
  return existsSync(path) ? parseChiefDiscordToken(readFileSync(path, 'utf8')) : undefined;
}

interface ChannelData { id: string; name: string; parent_id?: string | null; type: number }
export interface ManagementRest {
  get(route: `/${string}`): Promise<unknown>;
  post(route: `/${string}`, options: { body: Record<string, unknown>; reason: string }): Promise<unknown>;
}

/** 채널 생성은 비서실장 인증으로만 한다. LINDA의 권한에 기대는 경로를 두지 않는다. */
export function chiefProjectChannelPort(guildId: string, token?: string, provided?: ManagementRest) {
  const rest = provided ?? (token ? new REST({ version: '10' }).setToken(token) : null);
  const manager = (): ManagementRest => {
    if (!rest) throw new Error('비서실장 채널 관리 연결이 필요해요. Hermes 봇 설정을 확인해 주세요.');
    return rest;
  };
  return {
    async list() {
      const channels = await manager().get(Routes.guildChannels(guildId)) as ChannelData[];
      return channels.filter((ch) => ch.type === ChannelType.GuildCategory || ch.type === ChannelType.GuildText)
        .map((ch) => ({ id: ch.id, name: ch.name, parentId: ch.parent_id ?? null, category: ch.type === ChannelType.GuildCategory }));
    },
    async category(name: string): Promise<string> {
      return (await manager().post(Routes.guildChannels(guildId), { body: { name, type: ChannelType.GuildCategory }, reason: '비서실장: 승인된 프로젝트의 작업 공간 구성' }) as ChannelData).id;
    },
    async text(name: string, categoryId: string, topic: string): Promise<string> {
      return (await manager().post(Routes.guildChannels(guildId), { body: { name, parent_id: categoryId, topic, type: ChannelType.GuildText }, reason: '비서실장: 프로젝트 역할별 작업 채널 구성' }) as ChannelData).id;
    },
  };
}
