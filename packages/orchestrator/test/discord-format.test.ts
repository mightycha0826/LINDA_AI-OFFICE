import { describe, expect, it } from 'vitest';
import { readableDiscordText, discordChunks, staffReplyText } from '../src/discord/format.ts';
import { Mirror } from '../src/discord/mirror.ts';
import { recordMessage } from '../src/core/guards.ts';
import { FakeMirror } from './fakes/fake-discord.ts';
import { approvedTickets, setup } from './helpers.ts';

describe('Discord 읽기 서식', () => {
  it('접두사에 바로 붙은 JSON과 중첩 목록을 한국어 문장·들여쓰기로 표시한다', () => {
    const text = readableDiscordText('교정 1차 점검: {"issues":[{"kind":"tone","where":"첫 문단","note":"말투 통일"}],"missingCriteria":[]}');
    expect(text).toContain('글을 살펴보니');
    expect(text).toContain('- 첫 문단: 말투 통일');
    expect(text).not.toContain('{');
    expect(text).not.toContain('"issues"');
    expect(readableDiscordText('```json\n{"verdict":"fail","fixRequests":["테스트 추가"]}\n```')).toContain('이렇게 고쳐 주시겠어요?');
    expect(readableDiscordText('**안내**\n- [문서](https://example.com)')).toBe('**안내**\n- [문서](https://example.com)');
  });

  it('변환에 모델을 쓰지 않아도 자체 확인과 최종 검토를 구별하고 미확인 근거를 보존한다', () => {
    const work = readableDiscordText(JSON.stringify({ summary: '로그인을 구현했어요.', changedFiles: ['login.ts'], criteriaSelfCheck: [{ criterion: '실패 테스트', claimed: false }], notes: '문구 검토가 필요해요.' }));
    expect(work).toContain('아직 확인하지 못함');
    expect(work).toContain('최종 판정은 검토를 거쳐야');
    expect(work).not.toContain('criteriaSelfCheck');
    const doc = readableDiscordText(JSON.stringify({ document: '시장 보고서', claims: [{ text: '성장 전망', sources: [], noSource: true }] }));
    expect(doc).toContain('근거를 확인하지 못했어요');
  });

  it('대화 봉투는 벗기지만 요청한 JSON 코드 예시는 보존한다', () => {
    expect(staffReplyText('{"text":"네, 듣고 있어요.","intent":"chat"}')).toBe('네, 듣고 있어요.');
    expect(staffReplyText('알겠어요.\n{"text":"어떤 화면이면 좋을까요?","intent":"chat"}\n편하게 말씀해 주세요.')).toBe('알겠어요.\n어떤 화면이면 좋을까요?\n편하게 말씀해 주세요.');
    const code = '예시는 이렇게 쓰면 돼요.\n```json\n{"name":"demo"}\n```';
    expect(staffReplyText(code)).toBe(code);
    expect(discordChunks(code, 1900, false)).toEqual([code]);
  });

  it('통역사가 실패해도 거울에 원본 JSON을 노출하지 않는다', async () => {
    const s = setup();
    const { tickets: [ticket] } = await approvedTickets(s);
    recordMessage(s.ctx, { ticketId: ticket!.id, orderId: ticket!.orderId, fromId: 'developer', toId: 'reviewer', kind: 'handoff', content: '완료 보고{"summary":"예약 구현","changedFiles":["예약.ts"]}' });
    const port = new FakeMirror();
    await new Mirror(s.ctx, port, { interpret: async () => { throw new Error('모델 사용 불가'); } }).flush();
    expect(port.posts.at(-1)!.content).toContain('예약 구현');
    expect(port.posts.at(-1)!.content).not.toContain('"summary"');
  });

  it('긴 계획서를 생략하지 않고 이모지와 줄을 보존하여 나눈다', () => {
    const source = ('예약 완료 😀\n').repeat(600);
    const chunks = discordChunks(source);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((part) => part.length <= 1900)).toBe(true);
    expect(chunks.join('\n')).toBe(source.trim());
    expect(discordChunks('가'.repeat(1899) + '😀' + '나'.repeat(20)).join('')).toBe('가'.repeat(1899) + '😀' + '나'.repeat(20));
  });
});
