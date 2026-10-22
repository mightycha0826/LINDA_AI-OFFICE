import { describe, expect, it } from 'vitest';
import { ensureProjectChannels, PROJECT_CHANNELS, projectChannelsOf } from '../src/discord/project-channels.ts';
import { projectByChannel, setProjectChannel } from '../src/workspace/projects.ts';
import { setup } from './helpers.ts';

function fakeGuild() {
  const channels: { id: string; name: string; parentId: string | null; category: boolean }[] = [];
  let count = 0;
  return {
    channels,
    list: async () => [...channels],
    category: async (name: string) => {
      const id = `category-${++count}`;
      channels.push({ id, name, category: true, parentId: null });
      return id;
    },
    text: async (name: string, parentId: string) => {
      const id = `channel-${++count}`;
      channels.push({ id, name, parentId, category: false });
      return id;
    },
  };
}

describe('프로젝트별 채널 구성', () => {
  it('한 카테고리 안에 필요한 7개 채널을 만들고 재실행해도 중복되지 않는다', async () => {
    const guild = fakeGuild();
    const first = await ensureProjectChannels(guild, 'demo');
    const second = await ensureProjectChannels(guild, 'demo');
    expect(second).toEqual(first);
    expect(guild.channels).toHaveLength(8);
    expect(guild.channels.filter((ch) => !ch.category).map((ch) => ch.name)).toEqual(Object.values(PROJECT_CHANNELS).map((spec) => spec.name));
    expect(guild.channels.filter((ch) => !ch.category).every((ch) => ch.parentId === first.categoryId)).toBe(true);
    // 다른 프로젝트는 이름이 같아도 독립된 카테고리와 채널을 갖는다.
    const other = await ensureProjectChannels(guild, 'other');
    expect(other.categoryId).not.toBe(first.categoryId);
    expect(other.channels.approvals).not.toBe(first.channels.approvals);
  });

  it('기존 작업 채널과 변경된 카테고리 이름을 보존하고 없는 채널만 보충한다', async () => {
    const guild = fakeGuild();
    guild.channels.push({ id: 'existing-category', name: '내 프로젝트', parentId: null, category: true });
    guild.channels.push({ id: 'existing-work', name: '기존-작업', parentId: 'existing-category', category: false });
    const result = await ensureProjectChannels(guild, 'demo', { categoryId: 'existing-category', channelId: 'existing-work' });
    expect(result.channelId).toBe('existing-work');
    expect(guild.channels).toHaveLength(8);
    const deleted = result.channels.completed;
    guild.channels.splice(guild.channels.findIndex((ch) => ch.id === deleted), 1);
    const repaired = await ensureProjectChannels(guild, 'demo', { categoryId: result.categoryId, channelId: result.channelId });
    expect(repaired.channels.completed).not.toBe(deleted);
    expect(repaired.channels.approvals).toBe(result.channels.approvals);
    expect(guild.channels).toHaveLength(8);
  });

  it('모든 하위 채널의 지시는 해당 프로젝트로 고정된다', async () => {
    const s = setup();
    const result = await ensureProjectChannels(fakeGuild(), 'demo');
    setProjectChannel(s.ctx, 'demo', result);
    expect(projectChannelsOf(s.ctx, 'demo')).toEqual(result.channels);
    for (const channelId of Object.values(result.channels)) expect(projectByChannel(s.ctx, channelId)?.id).toBe('demo');
    expect(projectByChannel(s.ctx, 'unknown')).toBeNull();
  });
});
