// 지시 등록의 Discord 메시지 ID (6장 create_order, 9장): 헤르메스가 ID를 모르면
// 시스템 봇이 기록한 #비서실 주인 마지막 메시지 ID를 쓴다. 다른 채널·다른 사람·오래된 메시지는 쓰지 않는다.
import { describe, expect, it } from 'vitest';
import { ChiefTools } from '../src/chief/tools.ts';
import { onDiscordMessage, ORDER_MESSAGE_MAX_AGE_MS } from '../src/chief/order-message.ts';
import { isCeoPresent } from '../src/discord/presence.ts';
import { orders } from '../src/db/schema.ts';
import { OfficeError } from '../src/errors.ts';
import { CEO, setup, STRANGER } from './helpers.ts';

const GUILD = '300000000000000003';
const SECRETARY = '400000000000000004';
const APPROVALS = '500000000000000005';

function office() {
  const s = setup({ config: { discord: { guildId: GUILD, channels: { secretary: SECRETARY, approvals: APPROVALS } } } });
  const tools = new ChiefTools(s.ctx, s.engine, null);
  const msg = (messageId: string, over: { channelId?: string; authorId?: string; guildId?: string | null } = {}) =>
    onDiscordMessage(s.ctx, { guildId: GUILD, channelId: SECRETARY, authorId: CEO, messageId, ...over });
  const order = (args: Record<string, unknown>) => tools.call('create_order', args) as Promise<{ proposalId: string; created: boolean; status: string; discordMessageId: string; messageIdSource: string }>;
  return { ...s, msg, order };
}

describe('create_order 메시지 ID', () => {
  it('ID가 없으면 #비서실 주인 마지막 메시지 ID를 쓴다', async () => {
    const s = office();
    s.msg('1300000000000000101');
    const r = await s.order({ rawText: '로그인 페이지에 비밀번호 찾기 기능 추가해줘' });
    expect(r).toMatchObject({ created: false, status: 'awaiting-user-confirmation', discordMessageId: '1300000000000000101', messageIdSource: 'last-ceo-message' });
    expect(s.db.select().from(orders).all()).toHaveLength(0);
  });

  it('같은 메시지로 두 번 불러도 지시는 하나 (헤르메스 재시도)', async () => {
    const s = office();
    s.msg('1300000000000000101');
    const first = await s.order({ rawText: '비밀번호 찾기 추가해줘' });
    const again = await s.order({ rawText: '비밀번호 찾기 추가해줘' });
    expect([first.created, again.created]).toEqual([false, false]);
    expect(again.proposalId).toBe(first.proposalId);
    expect(s.db.select().from(orders).all()).toHaveLength(0);
  });

  it('새 메시지가 오면 그 ID로 새 지시가 생긴다', async () => {
    const s = office();
    s.msg('1300000000000000101');
    await s.order({ rawText: '첫 지시' });
    s.msg('1300000000000000102');
    const second = await s.order({ rawText: '둘째 지시' });
    expect(second).toMatchObject({ created: false, status: 'awaiting-user-confirmation', discordMessageId: '1300000000000000102' });
    expect(s.db.select().from(orders).all()).toHaveLength(0);
  });

  it('기록이 없으면 지시를 만들지 않는다', async () => {
    const s = office();
    await expect(s.order({ rawText: '지시' })).rejects.toThrow(OfficeError);
    expect(s.db.select().from(orders).all()).toHaveLength(0);
  });

  it('10분보다 오래된 메시지 ID는 쓰지 않는다', async () => {
    const s = office();
    s.msg('1300000000000000101');
    s.clock.advance(ORDER_MESSAGE_MAX_AGE_MS + 1);
    await expect(s.order({ rawText: '지시' })).rejects.toThrow(/10분/);
    expect(s.db.select().from(orders).all()).toHaveLength(0);
  });

  it('다른 채널, 다른 사람, 다른 서버의 메시지는 기록하지 않는다', async () => {
    const s = office();
    s.msg('1000000000000000001', { channelId: APPROVALS });
    s.msg('1000000000000000002', { authorId: STRANGER });
    s.msg('1000000000000000003', { guildId: '999999999999999999' });
    s.msg('1000000000000000004', { guildId: null }); // DM
    await expect(s.order({ rawText: '지시' })).rejects.toThrow(OfficeError);
  });

  it('주인이 아닌 사람의 #비서실 메시지는 주인 마지막 메시지를 덮지 않는다', async () => {
    const s = office();
    s.msg('1300000000000000101');
    s.msg('1000000000000000002', { authorId: STRANGER });
    expect((await s.order({ rawText: '지시' })).discordMessageId).toBe('1300000000000000101');
  });

  it('비서실장이 ID를 넣으면 그대로 쓰고, 지어낸 값은 거부한다', async () => {
    const s = office();
    s.msg('1300000000000000101');
    const r = await s.order({ rawText: '지시', discordMessageId: '1300000000000000042' });
    expect(r).toMatchObject({ discordMessageId: '1300000000000000042', messageIdSource: 'provided' });
    await expect(s.order({ rawText: '지시', discordMessageId: 'current_message_id' })).rejects.toThrow(/인자/);
    expect(s.db.select().from(orders).all()).toHaveLength(0);
  });

  it('주인 메시지는 어느 채널이든 접속 중 표시를 켠다 (기존 동작)', () => {
    const s = office();
    expect(isCeoPresent(s.ctx)).toBe(false);
    s.msg('1000000000000000001', { channelId: APPROVALS });
    expect(isCeoPresent(s.ctx)).toBe(true);
  });
});
