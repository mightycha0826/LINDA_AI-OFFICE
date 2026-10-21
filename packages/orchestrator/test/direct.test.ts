// 직원 직접 지시와 진행 중 수정 (9장, 2026-10-21 CEO 결정): 멘션은 제안만, 일은 버튼으로만
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { StaffChatOutput } from '@ai-office/shared';
import { applyRevision, DIRECT_PROPOSAL_TTL_MS, originOfOrder, proposeOrder, startDirectOrder } from '../src/core/direct.ts';
import { applyTicketEvent } from '../src/core/tickets.ts';
import { orders, plans, tickets } from '../src/db/schema.ts';
import { InteractionHandler } from '../src/discord/interactions.ts';
import { Mirror, type DirectChannelRoute } from '../src/discord/mirror.ts';
import { StaffChat, type StaffMention } from '../src/discord/staff-chat.ts';
import { setProjectChannel } from '../src/workspace/projects.ts';
import { FakeMirror } from './fakes/fake-discord.ts';
import { CEO, STRANGER, setup, type Setup } from './helpers.ts';

const WORK_CHANNEL = '410000000000000001';
const OTHER_CHANNEL = '420000000000000002';
let msgSeq = 0;

const mention = (s: Setup, content: string, channelId = WORK_CHANNEL): StaffMention => ({
  guildId: s.config.discord.guildId,
  channelId,
  messageId: `5100000000000${String(++msgSeq).padStart(5, '0')}`,
  authorId: CEO,
  authorIsBot: false,
  mentionsMe: true,
  content: `<@300000000000000003> ${content}`,
});

const ORDER: StaffChatOutput = { text: '네, 맡을게요. 버튼을 눌러 주시면 시작할게요', intent: 'order', title: '로그인 화면에 비밀번호 찾기 링크', criteria: ['링크 표시 테스트 통과', '링크를 누르면 찾기 화면으로 이동'] };

function withChat(out: StaffChatOutput) {
  const s = setup({ handlers: { chat: () => out } });
  setProjectChannel(s.ctx, 'demo', { categoryId: '400000000000000000', channelId: WORK_CHANNEL });
  return { s, chat: new StaffChat(s.ctx, (id, input) => s.engine.chatAs(id, input)) };
}

describe('멘션은 제안만 남긴다', () => {
  it('지시로 읽혀도 버튼 전에는 지시·계획·티켓이 생기지 않는다', async () => {
    const { s, chat } = withChat(ORDER);
    const r = await chat.answer('dev-a', mention(s, '로그인 화면에 비밀번호 찾기 링크 넣어줘'));
    expect(r?.proposal?.kind).toBe('order');
    expect(r?.text).toContain('버튼');
    expect(s.db.select().from(orders).all()).toHaveLength(0);
    expect(s.db.select().from(plans).all()).toHaveLength(0);
    expect(s.db.select().from(tickets).all()).toHaveLength(0);
  });

  it('코드 일은 프로젝트 #작업 채널에서만 맡는다 (다른 채널이면 제안 없이 이유)', async () => {
    const { s, chat } = withChat(ORDER);
    const r = await chat.answer('dev-a', mention(s, '링크 넣어줘', OTHER_CHANNEL));
    expect(r?.proposal).toBeNull();
    expect(r?.text).toContain('#작업 채널');
  });

  it('Git 고양이는 일을 맡지 않는다', async () => {
    const { s, chat } = withChat(ORDER);
    const r = await chat.answer('git-cat', mention(s, '이것 좀 만들어줘'));
    expect(r?.proposal).toBeNull();
    expect(r?.text).toContain('커밋·푸시만');
  });

  it('완료 조건이 없으면 제안하지 않는다', async () => {
    const { s, chat } = withChat({ ...ORDER, criteria: [] });
    const r = await chat.answer('marketing', mention(s, '문구 써줘'));
    expect(r?.proposal).toBeNull();
    expect(r?.text).toContain('완료 조건');
  });
});

describe('[맡기고 시작]이 결재 한 번', () => {
  it('그 직원이 담당, 다른 모델 검토자, 바로 진행 중. 지시의 출처 채널을 기억한다', async () => {
    const { s, chat } = withChat(ORDER);
    const p = (await chat.answer('dev-a', mention(s, '링크 넣어줘')))!.proposal!;
    const { orderId, ticketId } = startDirectOrder(s.ctx, p.id, CEO);
    const t = s.db.select().from(tickets).where(eq(tickets.id, ticketId)).get()!;
    expect(t.assigneeId).toBe('dev-a');
    expect(t.reviewerId).toBe('developer'); // GPT 개발자 코드는 개발팀장(Claude)이 본다
    expect(t.status).toBe('in_progress');
    expect(t.type).toBe('coding');
    expect(t.acceptanceCriteria).toEqual(ORDER.criteria);
    expect(s.db.select().from(orders).where(eq(orders.id, orderId)).get()!.projectId).toBe('demo');
    expect(s.db.select().from(plans).where(eq(plans.orderId, orderId)).get()!.status).toBe('approved');
    expect(originOfOrder(s.ctx, orderId)?.channelId).toBe(WORK_CHANNEL);
  });

  it('주인만, 한 번만, 30분 안에만', async () => {
    const { s, chat } = withChat({ ...ORDER, intent: 'order' });
    const p = (await chat.answer('marketing', mention(s, '랜딩 문구 써줘')))!.proposal!;
    expect(() => startDirectOrder(s.ctx, p.id, STRANGER)).toThrow(/CEO/);
    startDirectOrder(s.ctx, p.id, CEO);
    expect(() => startDirectOrder(s.ctx, p.id, CEO)).toThrow(/이미/);
    expect(s.db.select().from(tickets).all()).toHaveLength(1);

    const late = proposeOrder(s.ctx, { employeeId: 'strategy', channelId: OTHER_CHANNEL, messageId: '520000000000000001', rawText: '조사해줘', title: '조사', criteria: ['표 포함'] });
    s.clock.advance(DIRECT_PROPOSAL_TTL_MS + 1000);
    expect(() => startDirectOrder(s.ctx, late.id, CEO)).toThrow(/30분/);
  });

  it('버튼: CEO가 아니면 무시, [그냥 대화]는 아무것도 만들지 않는다', async () => {
    const { s, chat } = withChat(ORDER);
    const handler = new InteractionHandler(s.ctx, s.engine);
    const p = (await chat.answer('dev-b', mention(s, '링크 넣어줘')))!.proposal!;
    expect(await handler.handle({ type: 'button', userId: STRANGER, customId: `dp:${p.id}:start` })).toEqual({ kind: 'ignore' });
    const chatOnly = await handler.handle({ type: 'button', userId: CEO, customId: `dp:${p.id}:chat` });
    expect(chatOnly.kind).toBe('update');
    expect(s.db.select().from(tickets).all()).toHaveLength(0);
    const again = await handler.handle({ type: 'button', userId: CEO, customId: `dp:${p.id}:start` });
    expect(again).toMatchObject({ kind: 'reply', ephemeral: true });
    expect(s.db.select().from(tickets).all()).toHaveLength(0);
  });
});

describe('진행 중 수정 [수정 반영]', () => {
  async function started(out: StaffChatOutput = ORDER) {
    const { s, chat } = withChat(out);
    const p = (await chat.answer('dev-a', mention(s, '링크 넣어줘')))!.proposal!;
    const { ticketId } = startDirectOrder(s.ctx, p.id, CEO);
    return { s, chat, ticketId };
  }

  it('검토 중이면 완료 조건에 한 줄 붙이고 다시 작업으로', async () => {
    const { s, ticketId } = await started();
    applyTicketEvent(s.ctx, ticketId, { type: 'ticket.submitted' }, { kind: 'employee', id: 'dev-a' });
    const chat = new StaffChat(s.ctx, async () => ({ text: '네, 고칠게요', intent: 'revise', note: '링크 글자는 "비밀번호를 잊으셨나요?"로' }));
    const p = (await chat.answer('dev-a', mention(s, '링크 문구 바꿔줘')))!.proposal!;
    expect(p.kind).toBe('revise');
    expect(s.db.select().from(tickets).where(eq(tickets.id, ticketId)).get()!.status).toBe('in_review'); // 버튼 전에는 그대로
    const r = applyRevision(s.ctx, p.id, CEO);
    expect(r.status).toBe('rework');
    const t = s.db.select().from(tickets).where(eq(tickets.id, ticketId)).get()!;
    expect(t.acceptanceCriteria.at(-1)).toBe('CEO 수정 요청: 링크 글자는 "비밀번호를 잊으셨나요?"로');
    expect(t.reworkCount).toBe(0); // 주인의 수정은 반려 횟수에 넣지 않는다
  });

  it('작업 중이면 상태는 그대로, 조건만 붙는다. 맡은 일이 없으면 제안하지 않는다', async () => {
    const { s, ticketId } = await started();
    const chat = new StaffChat(s.ctx, async () => ({ text: '네', intent: 'revise', note: '버튼은 파란색' }));
    const p = (await chat.answer('dev-a', mention(s, '버튼 파랗게')))!.proposal!;
    expect(applyRevision(s.ctx, p.id, CEO).status).toBe('in_progress');
    expect(s.db.select().from(tickets).where(eq(tickets.id, ticketId)).get()!.acceptanceCriteria).toContain('CEO 수정 요청: 버튼은 파란색');
    const none = await chat.answer('dev-b', mention(s, '버튼 파랗게'));
    expect(none?.proposal).toBeNull();
    expect(none?.text).toContain('진행 중인 일이 없어요');
  });
});

describe('직원끼리 대화는 주인이 말한 채널 바로 아래에', () => {
  class FakeRoute implements DirectChannelRoute {
    readonly posts: { channelId: string; username: string; content: string; employeeId?: string }[] = [];
    async post(channelId: string, m: { username: string; content: string; employeeId?: string }) {
      this.posts.push({ channelId, ...m });
    }
    mentionOf(id: string) {
      return `<@bot-${id}>`;
    }
  }

  it('직접 지시 티켓의 대화·상태는 그 채널로(받는 직원 태그), 다른 티켓은 스레드로', async () => {
    const { s, chat } = withChat(ORDER);
    const p = (await chat.answer('dev-a', mention(s, '링크 넣어줘')))!.proposal!;
    const { ticketId } = startDirectOrder(s.ctx, p.id, CEO);
    await s.engine.runUntilIdle();
    const route = new FakeRoute();
    const threads = new FakeMirror();
    const mirror = new Mirror(s.ctx, threads, { direct: route, maxPerFlush: 100 });
    while ((await mirror.flush()) > 0);
    expect(route.posts.length).toBeGreaterThan(0);
    expect(route.posts.every((x) => x.channelId === WORK_CHANNEL)).toBe(true);
    expect(route.posts.some((x) => x.employeeId === 'dev-a' && x.content.startsWith('<@bot-developer>'))).toBe(true);
    expect(route.posts.some((x) => x.username === '회사 시스템' && x.content.includes(ticketId))).toBe(true);
    expect(threads.threads.filter((x) => x.ticketId === ticketId)).toHaveLength(0);
  });
});
