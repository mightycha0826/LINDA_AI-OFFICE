import { describe, expect, it } from 'vitest';
import { ChiefTools } from '../src/chief/tools.ts';
import { onDiscordMessage } from '../src/chief/order-message.ts';
import { CHIEF_PROPOSAL_TTL_MS, pendingChiefProposal } from '../src/chief/order-proposals.ts';
import { orders, plans, tickets } from '../src/db/schema.ts';
import { CEO, STRANGER, setup } from './helpers.ts';

function office() {
  const s = setup({ config: { discord: { guildId: 'guild', channels: { secretary: 'secretary' } } } });
  const tools = new ChiefTools(s.ctx, s.engine, null);
  const message = (id: string, userId = CEO, channelId = 'secretary') => onDiscordMessage(s.ctx, { guildId: 'guild', authorId: userId, channelId, messageId: id });
  const propose = (rawText = '대화에서 합의한 로그인 기능') => tools.call('create_order', { rawText, projectId: 'demo' }) as Promise<{ proposalId: string; created: boolean; status: string; question: string }>;
  const respond = (proposalId: string, decision = 'register') => tools.call('respond_order_proposal', { proposalId, decision }) as Promise<{ created: boolean; orderId?: string; status: string }>;
  return { ...s, tools, message, propose, respond };
}

describe('백서진과 대화 후 지시 등록', () => {
  it('업무 제안만으로 지시·계획·티켓을 만들지 않고 같은 차례의 자동 등록도 막는다', async () => {
    const s = office();
    s.message('1300000000000001001');
    const proposal = await s.propose();
    expect(proposal).toMatchObject({ created: false, status: 'awaiting-user-confirmation', question: expect.stringContaining('지시를 추가할까요?') });
    await expect(s.respond(proposal.proposalId)).rejects.toThrow('후속 답변');
    await s.engine.runUntilIdle();
    expect(s.mock.calls).toHaveLength(0);
    expect(s.db.select().from(orders).all()).toHaveLength(0);
    expect(s.db.select().from(plans).all()).toHaveLength(0);
    expect(s.db.select().from(tickets).all()).toHaveLength(0);
  });

  it('사장님의 다음 답변 뒤 등록하고 중복 응답·재시작에도 지시는 한 번만 만든다', async () => {
    const s = office();
    s.message('1300000000000001001');
    const proposal = await s.propose();
    s.message('1300000000000001002'); // "응, 그 내용으로 등록해줘"라는 다음 사용자 답변
    const first = await s.respond(proposal.proposalId);
    const again = await new ChiefTools(s.ctx, s.engine, null).call('respond_order_proposal', { proposalId: proposal.proposalId, decision: 'register' });
    expect(first).toMatchObject({ created: true, status: 'registered' });
    expect(again).toMatchObject({ created: false, orderId: first.orderId });
    expect(s.db.select().from(orders).all()).toHaveLength(1);
    expect(s.db.select().from(orders).get()).toMatchObject({ rawText: '대화에서 합의한 로그인 기능', projectId: 'demo', status: 'planning' });
    expect(s.db.select().from(plans).all()).toHaveLength(0);
    expect(pendingChiefProposal(s.ctx)).toBeNull();
  });

  it('등록을 원하지 않으면 제안을 닫고 대화를 이어간다', async () => {
    const s = office();
    s.message('1300000000000001001');
    const proposal = await s.propose();
    s.message('1300000000000001002');
    expect(await s.respond(proposal.proposalId, 'chat')).toMatchObject({ created: false, status: 'chat' });
    await expect(s.respond(proposal.proposalId)).rejects.toThrow('이미 닫혔거나');
    expect(s.db.select().from(orders).all()).toHaveLength(0);
  });

  it('수정된 제안은 다시 동의를 받아야 하고 이전 제안에는 동의할 수 없다', async () => {
    const s = office();
    s.message('1300000000000001001');
    const first = await s.propose();
    s.message('1300000000000001002');
    const revised = await s.propose('로그인 기능에서 이메일 알림은 제외');
    await expect(s.respond(first.proposalId)).rejects.toThrow('내용이 바뀐');
    await expect(s.respond(revised.proposalId)).rejects.toThrow('후속 답변');
    s.message('1300000000000001003');
    await s.respond(revised.proposalId);
    expect(s.db.select().from(orders).get()!.rawText).toBe('로그인 기능에서 이메일 알림은 제외');
  });

  it('다른 사람·다른 채널의 말과 모델이 만든 인자는 사용자 동의가 되지 않는다', async () => {
    const s = office();
    s.message('1300000000000001001');
    const proposal = await s.propose();
    s.message('1300000000000001002', STRANGER);
    s.message('1300000000000001003', CEO, 'other-channel');
    await expect(s.tools.call('respond_order_proposal', { proposalId: proposal.proposalId, decision: 'register', discordMessageId: '1300000000000001004', confirmed: true })).rejects.toThrow('후속 답변');
    expect(s.db.select().from(orders).all()).toHaveLength(0);
  });

  it('예전 사용자 메시지를 제공해도 제안 시점에 이미 있던 답변으로 등록하지 않는다', async () => {
    const s = office();
    s.message('1300000000000001002');
    const proposal = await s.tools.call('create_order', { rawText: '기능 추가', discordMessageId: '1300000000000001001' }) as { proposalId: string };
    await expect(s.respond(proposal.proposalId)).rejects.toThrow('후속 답변');
  });

  it('만료된 제안과 존재하지 않는 프로젝트는 등록하지 않는다', async () => {
    const s = office();
    s.message('1300000000000001001');
    await expect(s.tools.call('create_order', { rawText: '기능 추가', projectId: 'unknown' })).rejects.toThrow('프로젝트');
    const proposal = await s.propose();
    s.clock.advance(CHIEF_PROPOSAL_TTL_MS);
    s.message('1300000000000001002');
    await expect(s.respond(proposal.proposalId)).rejects.toThrow('만료');
    expect(s.db.select().from(orders).all()).toHaveLength(0);
  });
});
