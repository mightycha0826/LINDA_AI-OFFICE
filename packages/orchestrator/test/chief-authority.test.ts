import { describe, expect, it } from 'vitest';
import { chiefProjectChannelPort, parseChiefDiscordToken, type ManagementRest } from '../src/discord/chief-authority.ts';
import { ensureProjectChannels } from '../src/discord/project-channels.ts';

describe('채널 관리는 LINDA 대신 비서실장', () => {
  it('Hermes 환경에서 필요한 봇 인증만 읽고 주석·따옴표·재설정을 처리한다', () => {
    expect(parseChiefDiscordToken('OTHER_KEY=ignore\nDISCORD_BOT_TOKEN="chief-token"\nTOKEN=ignore')).toBe('chief-token');
    expect(parseChiefDiscordToken("export DISCORD_BOT_TOKEN='chief-token' # 설명")).toBe('chief-token');
    expect(parseChiefDiscordToken('DISCORD_BOT_TOKEN=old\r\nDISCORD_BOT_TOKEN=new')).toBe('new');
    expect(parseChiefDiscordToken('# DISCORD_BOT_TOKEN=comment\nOTHER_KEY=ignore')).toBeUndefined();
  });

  it('비서실장 관리 포트가 카테고리와 7개 채널을 만들고 두 번째에는 재사용한다', async () => {
    const channels: { id: string; name: string; type: number; parent_id?: string }[] = [];
    const requests: { route: string; body: Record<string, unknown> }[] = [];
    const manager: ManagementRest = {
      get: async () => channels,
      post: async (route, { body }) => {
        requests.push({ route, body });
        const channel = { id: String(1000 + channels.length), ...body } as (typeof channels)[number];
        channels.push(channel);
        return channel;
      },
    };
    const port = chiefProjectChannelPort('guild', undefined, manager);
    const first = await ensureProjectChannels(port, 'demo');
    expect(requests).toHaveLength(8);
    expect(requests.every((r) => r.route === '/guilds/guild/channels')).toBe(true);
    expect(channels.slice(1).every((ch) => ch.parent_id === first.categoryId)).toBe(true);
    expect(await ensureProjectChannels(port, 'demo')).toEqual(first);
    expect(requests).toHaveLength(8);
  });

  it('관리 인증이 없으면 LINDA로 우회해 생성하지 않는다', async () => {
    const port = chiefProjectChannelPort('guild');
    await expect(port.list()).rejects.toThrow('비서실장 채널 관리 연결');
    await expect(port.category('demo')).rejects.toThrow('비서실장 채널 관리 연결');
    await expect(port.text('작업', 'category', 'topic')).rejects.toThrow('비서실장 채널 관리 연결');
  });
});
