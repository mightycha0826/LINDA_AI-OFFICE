import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { StaffChatOutput } from '@ai-office/shared';
import { bindProposalReply, DIRECT_PROPOSAL_TTL_MS, getProposal, startDirectOrder } from '../src/core/direct.ts';
import { orders, tickets } from '../src/db/schema.ts';
import { isWorkConsent, StaffChat, type StaffMention } from '../src/discord/staff-chat.ts';
import { proposalMessage } from '../src/discord/messages.ts';
import { Notifier } from '../src/discord/notifier.ts';
import { askClarification, clarificationOf } from '../src/core/clarifications.ts';
import { FakeDiscord } from './fakes/fake-discord.ts';
import { setProjectChannel } from '../src/workspace/projects.ts';
import { CEO, STRANGER, setup, type Setup } from './helpers.ts';

const CHANNEL = '410000000000000001';
let seq = 0;
const message = (s: Setup, content: string, over: Partial<StaffMention> = {}): StaffMention => ({
  guildId: s.config.discord.guildId, channelId: CHANNEL, messageId: String(510000000000000000n + BigInt(++seq)),
  authorId: CEO, authorIsBot: false, mentionsMe: true, content, ...over,
});
const agreed: StaffChatOutput = { text: '이메일 로그인으로 이해했어요.', intent: 'order', title: '이메일 로그인', request: '이메일과 비밀번호로 로그인하고 실패 시 안내 문구를 보여 준다.', criteria: ['로그인 성공 테스트 통과', '실패 안내 테스트 통과'] };

function office() {
  const s = setup();
  setProjectChannel(s.ctx, 'demo', { categoryId: '400000000000000000', channelId: CHANNEL });
  return s;
}

describe('직원과 대화한 뒤 작업 확정', () => {
  it('PM 질문에는 답장으로 답하고, 이전 질문과 다른 사용자의 답변은 거부한다', async () => {
    const s = office();
    const { order } = s.engine.submitOrder({ discordMessageId: '530000000000000001', rawText: '예약 기능', projectId: 'demo', channelId: CHANNEL });
    askClarification(s.ctx, order.id, ['누가 사용하나요?']);
    const port = new FakeDiscord();
    await new Notifier(s.ctx, port).tick();
    const question = port.sent.find((m) => m.content.includes('누가 사용하나요?'))!;
    expect(question).toBeDefined();
    const chat = new StaffChat(s.ctx, async () => { throw new Error('답변 접수는 별도 대화 모델을 부르지 않음'); });
    const reply = { mentionsMe: false, repliesToMe: true, replyToMessageId: question.id };
    await chat.answer('pm', message(s, '관리자가 써요', { ...reply, authorId: STRANGER }));
    expect(clarificationOf(s.ctx, order.id).rounds[0]!.answer).toBeNull();
    const answer = await chat.answer('pm', message(s, '1. 관리자\n2. 직원도 사용해요', reply));
    expect(answer?.text).toContain('계획서로 정리');
    expect(clarificationOf(s.ctx, order.id).rounds[0]!.answer).toBe('1. 관리자\n2. 직원도 사용해요');
    expect((await chat.answer('pm', message(s, '이전 답변 변경', reply)))?.text).toContain('이미 답했거나');
  });

  it('추가 질문 → 답변을 반영한 제안 → 다음 동의 때만 작업을 만든다', async () => {
    const s = office();
    let calls = 0;
    const chat = new StaffChat(s.ctx, async (_id, input) => {
      if (++calls === 1) return { text: '어떤 방식으로 로그인하면 좋을까요?', intent: 'chat' };
      expect(input.recent[0]!.주인).toBe('로그인 만들어 줘');
      return agreed;
    });
    expect((await chat.answer('dev-a', message(s, '로그인 만들어 줘')))?.proposal).toBeNull();
    const answer = await chat.answer('dev-a', message(s, '이메일과 비밀번호로. 실패하면 안내해줘'));
    expect(answer?.proposal?.kind).toBe('order');
    expect(proposalMessage(answer!.proposal!, '한주아').content).toContain('진행할까요?');
    expect(s.db.select().from(tickets).all()).toHaveLength(0);
    bindProposalReply(s.ctx, answer!.proposal!.messageId, answer!.proposal!.id);
    const result = await chat.answer('dev-a', message(s, '응, 그 내용으로 진행해'));
    expect(result?.text).toContain('진행할게요');
    expect(calls).toBe(2); // 동의는 모델 추측이 아니라 코드가 처리한다.
    expect(s.db.select().from(tickets).all()).toHaveLength(1);
    expect(s.db.select().from(orders).get()!.rawText).toBe(agreed.request);
    expect(s.db.select().from(tickets).get()!.assigneeId).toBe('dev-a');
  });

  it('재시작 뒤에도 같은 직원·채널의 동의를 이어 받고 중복 시작하지 않는다', async () => {
    const s = office();
    const first = new StaffChat(s.ctx, async () => agreed);
    const p = (await first.answer('dev-a', message(s, '로그인 구현해줘')))!.proposal!;
    bindProposalReply(s.ctx, p.messageId, p.id);
    const restarted = new StaffChat(s.ctx, async () => ({ text: '네, 듣고 있어요.', intent: 'chat' }));
    const yes = message(s, '진행해 주세요');
    await restarted.answer('dev-a', yes);
    await restarted.answer('dev-a', yes);
    expect(s.db.select().from(tickets).all()).toHaveLength(1);
  });

  it('직원 답장에 이어서 답할 수 있지만 다른 사용자·채널·직원의 동의는 사용할 수 없다', async () => {
    const s = office();
    let calls = 0;
    const chat = new StaffChat(s.ctx, async () => ++calls === 1 ? agreed : { text: '말씀해 주세요.', intent: 'chat' });
    const p = (await chat.answer('dev-a', message(s, '만들어줘')))!.proposal!;
    bindProposalReply(s.ctx, p.messageId, p.id);
    await chat.answer('dev-a', message(s, '응', { authorId: STRANGER }));
    await chat.answer('dev-b', message(s, '응'));
    await chat.answer('dev-a', message(s, '응', { channelId: '410000000000000002' }));
    expect(s.db.select().from(tickets).all()).toHaveLength(0);
    await chat.answer('dev-a', message(s, '응', { mentionsMe: false, repliesToMe: true }));
    expect(s.db.select().from(tickets).all()).toHaveLength(1);
  });

  it.each(['아니 아직 하지 마', '그 전에 질문 있어', '응, 하지만 로그인은 빼줘', '좋아 보이네'])('추가 대화나 수정은 동의로 쓰지 않는다: %s', async (reply) => {
    const s = office();
    let calls = 0;
    const chat = new StaffChat(s.ctx, async (_id, input) => {
      if (++calls === 1) return agreed;
      expect(input.previousProposal?.kind).toBe('order');
      return { text: '알겠어요. 더 이야기해 볼게요.', intent: 'chat' };
    });
    const p = (await chat.answer('dev-a', message(s, '만들어줘')))!.proposal!;
    await chat.answer('dev-a', message(s, reply));
    expect(s.db.select().from(tickets).all()).toHaveLength(0);
    expect(() => startDirectOrder(s.ctx, p.id, CEO)).toThrow('이미 처리');
  });

  it('수정한 새 제안이 생기면 이전 버튼은 무효가 된다', async () => {
    const s = office();
    let calls = 0;
    const chat = new StaffChat(s.ctx, async () => ++calls === 1 ? agreed : { ...agreed, title: '로그인과 로그아웃', criteria: ['로그아웃 테스트 통과'] });
    const old = (await chat.answer('dev-a', message(s, '만들어줘')))!.proposal!;
    const current = (await chat.answer('dev-a', message(s, '로그아웃도 포함해줘')))!.proposal!;
    expect(getProposal(s.ctx, old.id)?.used).toBe(true);
    expect(getProposal(s.ctx, current.id)?.used).toBe(false);
    bindProposalReply(s.ctx, current.messageId, current.id);
    await chat.answer('dev-a', message(s, '응'));
    expect(s.db.select().from(tickets).get()!.title).toBe('로그인과 로그아웃');
  });

  it('동일 메시지와 만료된 제안은 동의로 쓸 수 없다', async () => {
    const s = office();
    const chat = new StaffChat(s.ctx, async () => agreed);
    const source = message(s, '만들어줘');
    const p = (await chat.answer('dev-a', source))!.proposal!;
    expect(await chat.answer('dev-a', { ...source, content: '응' })).toBeNull();
    s.clock.advance(DIRECT_PROPOSAL_TTL_MS + 1);
    const later = new StaffChat(s.ctx, async () => ({ text: '어떤 내용을 진행할까요?', intent: 'chat' }));
    await later.answer('dev-a', message(s, '응'));
    expect(s.db.select().from(tickets).all()).toHaveLength(0);
    expect(() => startDirectOrder(s.ctx, p.id, CEO)).toThrow('30분');
  });

  it('예전 확인 질문에 답한 동의를 최신 범위의 동의로 오해하지 않는다', async () => {
    const s = office();
    const chat = new StaffChat(s.ctx, async () => agreed);
    const old = (await chat.answer('dev-a', message(s, '로그인 만들어줘')))!.proposal!;
    bindProposalReply(s.ctx, '600000000000000001', old.id);
    const current = (await chat.answer('dev-a', message(s, '로그아웃도 넣어줘')))!.proposal!;
    bindProposalReply(s.ctx, '600000000000000002', current.id);
    const stale = await chat.answer('dev-a', message(s, '응', { replyToMessageId: '600000000000000001', messageId: '600000000000000003' }));
    expect(stale?.text).toContain('최신 확인 질문');
    expect(s.db.select().from(tickets).all()).toHaveLength(0);
    await chat.answer('dev-a', message(s, '응', { replyToMessageId: '600000000000000002', messageId: '600000000000000004' }));
    expect(s.db.select().from(tickets).all()).toHaveLength(1);
  });

  it('진행 중 수정도 다음 동의를 받은 뒤 반영한다', async () => {
    const s = office();
    const p = (await new StaffChat(s.ctx, async () => agreed).answer('dev-a', message(s, '만들어줘')))!.proposal!;
    const { ticketId } = startDirectOrder(s.ctx, p.id, CEO);
    const chat = new StaffChat(s.ctx, async () => ({ text: '안내 문구를 바꾸는 거군요.', intent: 'revise', note: '실패 안내를 한국어로 표시' }));
    const revision = (await chat.answer('dev-a', message(s, '실패 안내 한국어로 바꿔줘')))!.proposal!;
    bindProposalReply(s.ctx, revision.messageId, revision.id);
    expect(s.db.select().from(tickets).where(eq(tickets.id, ticketId)).get()!.acceptanceCriteria).not.toContain('CEO 수정 요청: 실패 안내를 한국어로 표시');
    await chat.answer('dev-a', message(s, '응, 반영해'));
    expect(s.db.select().from(tickets).where(eq(tickets.id, ticketId)).get()!.acceptanceCriteria).toContain('CEO 수정 요청: 실패 안내를 한국어로 표시');
  });

  it('응답 본문에 잘못 중첩된 내부 JSON은 사용자에게 내보내지 않는다', async () => {
    const s = office();
    const chat = new StaffChat(s.ctx, async () => ({ text: '```json\n{"text":"넵! 어떤 화면이면 좋을까요?","intent":"chat"}\n```', intent: 'chat' }));
    expect((await chat.answer('dev-a', message(s, '안녕')))?.text).toBe('넵! 어떤 화면이면 좋을까요?');
  });

  it('독립적인 동의만 인정하고 조건·부정·인용은 받지 않는다', () => {
    for (const yes of ['응', '네!', '응, 진행해', '그 내용으로 진행해 주세요', '좋아 그대로 시작해줘', '응, 반영해', '그렇게 해줘', '그래 그렇게 해', '네, 그대로 해주세요']) {
      expect(isWorkConsent(yes), yes).toBe(true);
    }
    for (const no of ['아니 진행하지 마', '응, 근데 범위는 바꾸자', '진행해도 돼?', '"응"이라고 하면 시작하는 거야?', '진행해 주세요라는 말은 하지 않았어']) expect(isWorkConsent(no), no).toBe(false);
  });
});
