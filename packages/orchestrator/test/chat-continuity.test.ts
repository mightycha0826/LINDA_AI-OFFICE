import { describe, expect, it } from 'vitest';
import { StaffChat, type StaffMention } from '../src/discord/staff-chat.ts';
import { CHAT_MEMORY_CHARS, CHAT_MEMORY_MS, CHAT_MEMORY_TURNS, pruneStaffConversations, readStaffConversation, rememberStaffConversation } from '../src/discord/chat-memory.ts';
import { conversationPrompt } from '../src/staff/prompts.ts';
import { ollamaMessages } from '../src/brains/ollama.ts';
import { roleCard } from '../src/staff/role-cards.ts';
import { employees } from '../src/db/schema.ts';
import { StaffChatOutputSchema, DevOutputSchema } from '@ai-office/shared';
import { CEO, STRANGER, setup, type Setup } from './helpers.ts';
import { eq } from 'drizzle-orm';
import { bindProposalReply } from '../src/core/direct.ts';
import { tickets } from '../src/db/schema.ts';

let seq = 0;
const msg = (s: Setup, content: string, over: Partial<StaffMention> = {}): StaffMention => ({ guildId: s.config.discord.guildId, channelId: '410000000000000001', messageId: String(550000000000000000n + BigInt(++seq)), authorId: CEO, authorIsBot: false, mentionsMe: true, content, ...over });

describe('로컬 직원의 이어지는 대화', () => {
  it('먼저 보낸 응답이 대기열에서 확인 질문의 동의로 바뀌지 않는다', async () => {
    const s = setup();
    let release!: (out: { text: string; intent: 'order'; title: string; criteria: string[] }) => void;
    let started!: () => void;
    const ready = new Promise<void>((r) => { started = r; });
    const chat = new StaffChat(s.ctx, async () => { started(); return new Promise((r) => { release = r; }); });
    const first = chat.answer('marketing', msg(s, '홍보 문구 써줘'));
    await ready;
    const earlyMessage = msg(s, '응');
    const early = chat.answer('marketing', earlyMessage);
    release({ text: '범위를 정리했어요.', intent: 'order', title: '홍보 문구', criteria: ['제목과 설명 포함'] });
    const proposal = (await first)!.proposal!;
    expect((await early)?.text).toContain('동의로 처리하지 않았어요');
    expect(s.db.select().from(tickets).all()).toHaveLength(0);
    const shownId = String(BigInt(earlyMessage.messageId) + 1n);
    bindProposalReply(s.ctx, shownId, proposal.id);
    // 실제 전송 전의 동의를 재생해도 실행하지 않는다.
    await chat.answer('marketing', earlyMessage);
    expect(s.db.select().from(tickets).all()).toHaveLength(0);
    await chat.answer('marketing', msg(s, '응', { messageId: String(BigInt(shownId) + 1n) }));
    expect(s.db.select().from(tickets).all()).toHaveLength(1);
  });
  it('실제 모델 입력에 사용자의 말과 직원의 답을 번갈아 넣고 최신 발언은 마지막에 둔다', () => {
    const prompt = conversationPrompt('회사 규칙', { recent: [{ 주인: '색은 파랑', 나: '파랑으로 생각 중이시군요.' }, { 주인: '아니 청록', 나: '청록으로 정정했어요.' }], message: '그 색으로 계속 얘기하자' });
    const messages = ollamaMessages(prompt);
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: '색은 파랑' }, { role: 'assistant', content: '파랑으로 생각 중이시군요.' },
      { role: 'user', content: '아니 청록' }, { role: 'assistant', content: '청록으로 정정했어요.' },
      { role: 'user', content: '그 색으로 계속 얘기하자' },
    ]);
    expect(prompt.system).not.toContain('색은 파랑');
    expect(prompt.system).not.toContain('그 색으로 계속 얘기하자');
    expect(prompt.system).toContain('정정한 내용은 이전 내용보다 우선');
  });

  it('대화에는 업무 실행 카드 대신 대화 지침을 주고 작업 호출은 기존 카드로 유지한다', () => {
    const s = setup();
    const employee = s.db.select().from(employees).where(eq(employees.id, 'dev-a')).get()!;
    const chat = roleCard(s.ctx, employee, 'chat', StaffChatOutputSchema);
    expect(chat).toContain('앞선 사용자·직원 대화를 이어');
    expect(chat).not.toContain('티켓 worktree 안에서만 코드를 구현');
    expect(roleCard(s.ctx, employee, 'work', DevOutputSchema)).toContain('티켓 worktree 안에서만 코드를 구현');
  });

  it('직원 대화가 서비스 인스턴스 재시작 뒤에도 이어지고 같은 메시지는 두 번 처리하지 않는다', async () => {
    const s = setup();
    const first = msg(s, '오늘은 질문 없이 짧게 말해 줘');
    await new StaffChat(s.ctx, async () => ({ text: '네, 짧게 이야기할게요.', intent: 'chat' })).answer('dev-b', first);
    let calls = 0;
    const restarted = new StaffChat(s.ctx, async (_id, input) => {
      calls++;
      expect(input.recent).toEqual([{ 주인: first.content, 나: '네, 짧게 이야기할게요.' }]);
      return { text: '회의가 길어 더 지치셨겠어요.', intent: 'chat' };
    });
    expect(await restarted.answer('dev-b', first)).toBeNull();
    await restarted.answer('dev-b', msg(s, '회의가 너무 길었어'));
    expect(calls).toBe(1);
  });

  it('대화 초기화는 해당 직원·채널의 기억만 지우고 다른 사용자는 실행할 수 없다', async () => {
    const s = setup();
    const chat = new StaffChat(s.ctx, async () => ({ text: '알겠어요.', intent: 'chat' }));
    await chat.answer('dev-a', msg(s, '짧게 말해줘'));
    await chat.answer('dev-b', msg(s, '차분하게 말해줘'));
    await chat.answer('dev-a', msg(s, '대화 초기화', { authorId: STRANGER }));
    expect(readStaffConversation(s.ctx, 'dev-a', '410000000000000001')).toHaveLength(1);
    expect((await chat.answer('dev-a', msg(s, '대화 초기화')))?.text).toContain('기억을 지웠어요');
    expect(readStaffConversation(s.ctx, 'dev-a', '410000000000000001')).toHaveLength(0);
    expect(readStaffConversation(s.ctx, 'dev-b', '410000000000000001')).toHaveLength(1);
  });

  it('기억은 횟수·글자 수·보관 시간을 제한하고 사용하지 않는 채널의 만료 기록도 정리한다', () => {
    const s = setup();
    const now = s.clock.now().getTime();
    rememberStaffConversation(s.ctx, 'dev-a', 'c1', Array.from({ length: 50 }, (_, n) => ({ at: now, owner: `말${n}`, me: '짧은 답' })));
    expect(readStaffConversation(s.ctx, 'dev-a', 'c1')).toHaveLength(CHAT_MEMORY_TURNS);
    rememberStaffConversation(s.ctx, 'dev-b', 'c2', Array.from({ length: 20 }, () => ({ at: now, owner: '가'.repeat(4000), me: '나'.repeat(4000) })));
    expect(readStaffConversation(s.ctx, 'dev-b', 'c2').reduce((n, t) => n + t.owner.length + t.me.length, 0)).toBeLessThanOrEqual(CHAT_MEMORY_CHARS);
    s.clock.advance(CHAT_MEMORY_MS + 1);
    pruneStaffConversations(s.ctx);
    expect(readStaffConversation(s.ctx, 'dev-a', 'c1')).toEqual([]);
    expect(readStaffConversation(s.ctx, 'dev-b', 'c2')).toEqual([]);
  });
});
