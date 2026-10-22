import { describe, expect, it } from 'vitest';
import { planOutput } from '../src/brains/mock.ts';
import { setState } from '../src/context.ts';
import { Notifier } from '../src/discord/notifier.ts';
import { projectChannelsKey } from '../src/discord/project-channels.ts';
import { roleDiscordPort } from '../src/discord/role-port.ts';
import type { StaffBotPort } from '../src/discord/staff-bots.ts';
import { approvalLink } from '../src/reports.ts';
import { FakeDiscord } from './fakes/fake-discord.ts';
import { CEO, pendingPlanApproval, setup } from './helpers.ts';

describe('역할 AI가 프로젝트 채널에서 알림', () => {
  it('질문은 PM이 기획에 보내고, 계획서도 PM이 프로젝트 결재함에 보낸다', async () => {
    const s = setup({ handlers: { clarify: (_req, n) => ({ understanding: '예약 도구', questions: n === 1 ? ['사용자는 누구인가요?'] : [] }) } });
    setState(s.ctx, projectChannelsKey('demo'), { planning: 'demo-plan', approvals: 'demo-approvals' });
    const { order } = s.engine.submitOrder({ discordMessageId: '1300000000000040001', rawText: '예약 도구를 만들어줘', projectId: 'demo', channelId: 'demo-work' });
    const port = new FakeDiscord();
    const notifier = new Notifier(s.ctx, port);
    await s.engine.runUntilIdle();
    await notifier.tick();
    expect(port.sent[0]).toMatchObject({ employeeId: 'pm', channelId: 'demo-plan' });
    const { answerClarification } = await import('../src/core/clarifications.ts');
    answerClarification(s.ctx, order.id, 1, '예약 관리자가 써요', CEO);
    await s.engine.runUntilIdle();
    await notifier.tick();
    expect(port.in('approvals')[0]).toMatchObject({ employeeId: 'pm', channelId: 'demo-approvals' });
  });

  it('할일·완료는 담당자, 검토는 검토자가 말하고 다른 프로젝트에 새지 않는다', async () => {
    const s = setup({ handlers: { plan: () => planOutput({ tickets: [{ ...planOutput().tickets[0]!, assignee: 'dev-a', reviewer: 'developer' }] }) } });
    setState(s.ctx, projectChannelsKey('demo'), { todo: 'demo-todo', completed: 'demo-done', approvals: 'demo-approvals' });
    setState(s.ctx, projectChannelsKey('other'), { completed: 'other-done' });
    s.engine.submitOrder({ discordMessageId: '1300000000000040002', rawText: '로그인 기능 추가', projectId: 'demo' });
    await s.engine.runUntilIdle();
    const port = new FakeDiscord();
    const notifier = new Notifier(s.ctx, port);
    await notifier.tick();
    s.engine.decide({ approvalId: pendingPlanApproval(s)!.id, discordUserId: CEO, decision: 'approved' });
    await s.engine.runUntilIdle();
    await notifier.tick();
    expect(port.sent.find((m) => m.content.includes('넵! 제가 맡아서'))).toMatchObject({ employeeId: 'dev-a', channelId: 'demo-todo' });
    expect(port.sent.find((m) => m.content.includes('구현 내용과 테스트'))).toMatchObject({ employeeId: 'developer', channelId: 'demo-todo' });
    expect(port.sent.find((m) => m.content.includes('완료 ·'))).toMatchObject({ employeeId: 'dev-a', channelId: 'demo-done' });
    expect(port.sent.some((m) => m.channelId === 'other-done')).toBe(false);
  });

  it('실제 직원 봇으로 보내고 같은 봇·채널로 수정한다. 연결 실패 시 LINDA로 대체하지 않는다', async () => {
    const s = setup({ config: { discord: { guildId: 'guild' } } });
    const sent: string[] = [];
    const edits: string[] = [];
    const system = { send: async () => { throw new Error('LINDA로 보내면 안 됨'); }, edit: async () => { throw new Error('LINDA로 수정하면 안 됨'); } };
    const bots: StaffBotPort = {
      has: (id) => id === 'pm', post: async () => {}, userIdOf: () => null, setStatus: async () => {}, stop: async () => {},
      send: async (id, channelId) => { sent.push(`${id}:${channelId}`); return { messageId: 'role-message', url: 'url' }; },
      edit: async (id, channelId) => { edits.push(`${id}:${channelId}`); },
    };
    const port = roleDiscordPort(s.ctx, system, () => bots);
    await port.send({ channel: 'approvals', channelId: 'project-approval', employeeId: 'pm', content: '계획서' });
    // 새 포트도 DB에 저장한 발신자·위치를 복구한다.
    await roleDiscordPort(s.ctx, system, () => bots).edit('approvals', 'role-message', { content: '승인됨', buttons: [] });
    expect(sent).toEqual(['pm:project-approval']);
    expect(edits).toEqual(['pm:project-approval']);
    expect(approvalLink(s.ctx, 'role-message')).toBe('https://discord.com/channels/guild/project-approval/role-message');
    await expect(port.send({ channel: 'reports', employeeId: 'dev-a', content: '작업 완료' })).rejects.toThrow('직원 봇 연결 대기');
  });
});
