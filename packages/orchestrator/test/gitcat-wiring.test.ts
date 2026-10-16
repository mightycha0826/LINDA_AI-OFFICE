// Git 고양이와 결재 봇·비서실장·알림의 연결 (11장, 9장 ③).
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ChiefTools } from '../src/chief/tools.ts';
import { emit } from '../src/context.ts';
import { tickets } from '../src/db/schema.ts';
import { InteractionHandler, type GitCatPort } from '../src/discord/interactions.ts';
import { Notifier } from '../src/discord/notifier.ts';
import { FakeDiscord } from './fakes/fake-discord.ts';
import { CEO, approvedTickets, setup } from './helpers.ts';

class FakeCat implements GitCatPort {
  readonly calls: string[] = [];
  async preparePush(ticketId: string, kind: 'push' | 'revert', origin: string) {
    this.calls.push(`${kind}:${ticketId}:${origin}`);
    return { ok: true, message: 'ok' };
  }
  async registerAndClone(p: { id: string }) {
    this.calls.push(`register:${p.id}`);
    return 'ok';
  }
}

describe('결재 봇 → Git 고양이', () => {
  it('/push는 바로 답하고 Git 고양이가 뒤에서 검사한다 (Discord 3초 응답 제한)', async () => {
    const s = setup();
    await approvedTickets(s);
    s.db.update(tickets).set({ branch: 'feature/T1-x' }).where(eq(tickets.id, 'T-1')).run();
    const cat = new FakeCat();
    const h = new InteractionHandler(s.ctx, s.engine, () => {}, cat);
    const r = await h.handle({ type: 'command', userId: CEO, name: 'push', options: { 티켓: 'T-1' } });
    expect(r).toMatchObject({ kind: 'reply', content: expect.stringContaining('푸시 전 검사를 시작했어요') });
    await new Promise((x) => setTimeout(x, 0));
    expect(cat.calls).toEqual(['push:T-1:CEO /push']);
  });

  it('/프로젝트는 CEO만, Git 고양이가 받아 와서 등록한다', async () => {
    const s = setup();
    const cat = new FakeCat();
    const h = new InteractionHandler(s.ctx, s.engine, () => {}, cat);
    expect(await h.handle({ type: 'command', userId: '999999999999999999', name: '프로젝트', options: { 아이디: 'x', 주소: 'https://github.com/a/b', 테스트: 'npm test' } })).toEqual({ kind: 'ignore' });
    await h.handle({ type: 'command', userId: CEO, name: '프로젝트', options: { 아이디: 'todo', 주소: 'https://github.com/a/todo', 테스트: 'npm test' } });
    await new Promise((x) => setTimeout(x, 0));
    expect(cat.calls).toEqual(['register:todo']);
  });

  it('비서실장의 확인 요청도 Git 고양이 검사를 거친다', async () => {
    const s = setup();
    await approvedTickets(s);
    const cat = new FakeCat();
    const tools = new ChiefTools(s.ctx, s.engine, null, cat);
    expect(await tools.call('request_confirmation', { kind: 'push', targetId: 'T-1', reason: 'push해' })).toMatchObject({ requested: true });
    await new Promise((x) => setTimeout(x, 0));
    expect(cat.calls[0]).toMatch(/^push:T-1:비서실장 전달/);
  });
});

describe('알림 ← Git 고양이', () => {
  it('푸시 성공은 #보고에 조용히, 실패는 #막힘에', async () => {
    const s = setup();
    const discord = new FakeDiscord();
    emit(s.ctx, 'git.push', { ticketId: 'T-1', ok: true, target: 'main', sha: 'abc1234', backup: 'backup/main-1', test: 'passed' });
    emit(s.ctx, 'git.push', { ticketId: 'T-2', ok: false, stage: 'checks', reason: '⛔ 비밀 정보 검사: 비밀 정보로 보이는 내용이 있어 푸시하지 않아요' });
    await new Notifier(s.ctx, discord).tick();
    expect(discord.in('reports').find((m) => m.content.includes('T-1 → main 푸시 완료 (abc1234)'))).toMatchObject({ silent: true });
    expect(discord.in('blocked')[0]!.content).toContain('T-2 checks 실패');
    expect(discord.in('blocked')[0]!.content).toContain('비밀 정보');
  });
});
