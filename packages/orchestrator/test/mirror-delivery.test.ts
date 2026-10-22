import { describe, expect, it } from 'vitest';
import { resilientMirror } from '../src/discord/mirror-delivery.ts';
import { FakeMirror } from './fakes/fake-discord.ts';

describe('거울 전송 복구', () => {
  it('웹훅이 실패하면 같은 메시지와 다음 메시지를 시스템 봇으로 전송한다', async () => {
    const primary = new FakeMirror();
    const fallback = new FakeMirror();
    const logs: string[] = [];
    let attempts = 0;
    primary.post = async () => { attempts++; throw new Error('Invalid Webhook Token'); };
    const route = resilientMirror(primary, fallback, (line) => logs.push(line));
    const thread = await route.ensureThread('T-1', '예약 기능');
    await route.post(thread, { username: '회사 시스템', content: '첫 기록' });
    await route.post(thread, { username: '회의록', content: '다음 기록' });
    expect(fallback.posts.map((p) => p.content)).toEqual(['첫 기록', '다음 기록']);
    expect(attempts).toBe(1);
    expect(logs).toHaveLength(1);
  });

  it('웹훅이 없을 때도 전송하고, 시스템 봇마저 실패하면 재시도할 수 있게 오류를 유지한다', async () => {
    const fallback = new FakeMirror();
    const route = resilientMirror(null, fallback);
    await route.post('thread', { username: '시스템', content: '기록' });
    expect(fallback.posts).toHaveLength(1);
    fallback.post = async () => { throw new Error('Discord unavailable'); };
    await expect(route.post('thread', { username: '시스템', content: '기록' })).rejects.toThrow('Discord unavailable');
  });
});
