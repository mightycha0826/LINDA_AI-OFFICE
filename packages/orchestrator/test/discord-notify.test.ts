// 알림·거울·보고 (10장, 9장 ⑥⑦).
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { planOutput, type TicketInput } from '../src/brains/mock.ts';
import { ReportService } from '../src/chief/report-service.ts';
import { recordUsage } from '../src/core/budget.ts';
import { approvals } from '../src/db/schema.ts';
import { Mirror } from '../src/discord/mirror.ts';
import { Notifier } from '../src/discord/notifier.ts';
import { markCeoActive } from '../src/discord/presence.ts';
import { currentSlot } from '../src/discord/schedule.ts';
import { FakeDiscord, FakeMirror } from './fakes/fake-discord.ts';
import { CEO, approvedTickets, orderUntilPlanApproval, setup } from './helpers.ts';

// 기본 시계는 2026-10-15 09:00(서울). 점검 시각(08:00, 18:00, 22:00)의 30분 창 밖이다.
const toEvening = (s: ReturnType<typeof setup>) => s.clock.advanceHours(9.1); // 18:06

describe('점검 시각', () => {
  it('서울 시간 기준 점검 칸', () => {
    const s = setup();
    expect(currentSlot(s.config, s.clock.now())).toBeNull();
    toEvening(s);
    expect(currentSlot(s.config, s.clock.now())).toBe('2026-10-15 18:00');
  });
});

describe('알림 (10장)', () => {
  it('점검 시간 밖·CEO 부재: 결재 메시지는 버튼과 함께 조용히 올리고, 멘션은 점검 시각에 한 번으로 묶는다', async () => {
    const s = setup();
    const discord = new FakeDiscord();
    const n = new Notifier(s.ctx, discord);
    const { approval } = await orderUntilPlanApproval(s);
    await n.tick();
    const [msg] = discord.in('approvals');
    expect(msg).toMatchObject({ silent: true });
    expect(msg!.content).not.toContain(`<@${CEO}>`);
    expect(msg!.buttons!.flat().map((b) => b.label)).toEqual(['승인', '수정 요청', '반려']);
    expect(s.db.select().from(approvals).where(eq(approvals.id, approval!.id)).get()!.discordMessageId).toBe(msg!.id);

    toEvening(s);
    await n.tick();
    const mention = discord.sent.at(-1)!;
    expect(mention.content).toContain(`<@${CEO}>`);
    expect(mention.content).toContain('결재 대기 1건');
    expect(mention.content).toContain(`/approvals/${msg!.id}`);
    expect(mention.silent).toBeFalsy();
    // 다시 돌려도 더 보내지 않는다
    const count = discord.sent.length;
    await n.tick();
    expect(discord.sent.length).toBe(count);
  });

  it('CEO 접속 중이면 점검 시간 밖이어도 바로 멘션한다', async () => {
    const s = setup();
    const discord = new FakeDiscord();
    markCeoActive(s.ctx);
    await orderUntilPlanApproval(s);
    await new Notifier(s.ctx, discord).tick();
    expect(discord.in('approvals')[0]).toMatchObject({ silent: false, content: expect.stringContaining(`<@${CEO}>`) });
  });

  it('시간당 멘션 상한을 넘으면 조용히 올리고 모아 둔다', async () => {
    const s = setup({ config: { schedule: { maxImmediatePerHour: 1 } } });
    const discord = new FakeDiscord();
    const n = new Notifier(s.ctx, discord);
    markCeoActive(s.ctx);
    await orderUntilPlanApproval(s, '첫 지시');
    await n.tick();
    await orderUntilPlanApproval(s, '둘째 지시');
    await n.tick();
    const msgs = discord.in('approvals');
    expect(msgs.map((m) => !!m.silent)).toEqual([false, true]);
  });

  it('결재가 결정되면 원래 메시지의 버튼을 비활성화한다', async () => {
    const s = setup();
    const discord = new FakeDiscord();
    const n = new Notifier(s.ctx, discord);
    const { approval } = await orderUntilPlanApproval(s);
    await n.tick();
    s.engine.decide({ approvalId: approval!.id, discordUserId: CEO, decision: 'approved' });
    await n.tick();
    const edit = discord.edits.find((e) => e.messageId === discord.in('approvals')[0]!.id)!;
    expect(edit.content).toContain('승인됨');
    expect(edit.buttons!.flat().every((b) => b.disabled)).toBe(true);
  });

  it('막힘은 #막힘에 버튼과 함께, 완료는 #보고에 조용히', async () => {
    const s = setup({
      handlers: {
        plan: () => planOutput({ tickets: [{ ...planOutput().tickets[0]!, title: 'A' }, { ...planOutput().tickets[0]!, title: 'B' }] }),
        review: (req) => {
          const t = (req.input as TicketInput).ticket;
          const pass = t.title === 'A';
          return pass
            ? { verdict: 'pass', criteria: t.acceptanceCriteria.map((criterion) => ({ criterion, pass: true })), fixRequests: [] }
            : { verdict: 'fail', criteria: t.acceptanceCriteria.map((criterion) => ({ criterion, pass: false, reason: 'x' })), reasonCategory: 'criteria-unmet', fixRequests: ['x'] };
        },
        meeting: () => ({ claim: '유지', agree: false, nextActions: [] }),
      },
    });
    const discord = new FakeDiscord();
    await approvedTickets(s);
    await s.engine.runUntilIdle();
    await new Notifier(s.ctx, discord).tick();
    const blocked = discord.in('blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.content).toContain('T-2 B');
    expect(blocked[0]!.content).toContain('회의 결론');
    expect(blocked[0]!.buttons!.flat().map((b) => b.label)).toEqual(['다시 시도', '방향 지시', '취소']);
    expect(discord.in('reports').find((m) => m.content.includes('완료 · T-1 A'))).toMatchObject({ silent: true });
  });

  it('보내기에 실패하면 다음 바퀴에 다시 보낸다 (빠지는 알림 없음)', async () => {
    const s = setup();
    const discord = new FakeDiscord();
    const n = new Notifier(s.ctx, discord);
    await orderUntilPlanApproval(s);
    discord.failNext = true;
    await n.tick();
    expect(discord.in('approvals')).toHaveLength(0);
    await n.tick();
    expect(discord.in('approvals')).toHaveLength(1);
  });

  it('예산 상한 근접(90%)을 알린다. 5시간에 한 번만', async () => {
    const s = setup();
    const discord = new FakeDiscord();
    const n = new Notifier(s.ctx, discord);
    recordUsage(s.ctx, { budget: 'dev', inputTokens: 1, outputTokens: 1, estimatedPct: 50, estimatedWeeklyPct: 10, source: 'estimated' });
    await n.tick();
    await n.tick();
    expect(discord.in('reports').filter((m) => m.content.includes('Claude 개발 몫을 5시간 한도의'))).toHaveLength(1);
  });
});

describe('거울 채널 (⑦)', () => {
  it('티켓마다 스레드 하나, 직원 이름으로, 긴 글은 앞부분과 화면 링크, 회의록은 끝에', async () => {
    const s = setup({
      config: { screenUrl: 'http://office.ts.net', mirror: { maxChars: 40 } },
      handlers: {
        review: (req, n) => {
          const c = (req.input as TicketInput).ticket.acceptanceCriteria;
          return n <= 2
            ? { verdict: 'fail', criteria: c.map((criterion) => ({ criterion, pass: false, reason: '아주 긴 이유가 들어가는 반려 사유입니다. 이 글은 40자를 넘습니다.' })), reasonCategory: 'criteria-unmet', fixRequests: ['x'] }
            : { verdict: 'pass', criteria: c.map((criterion) => ({ criterion, pass: true })), fixRequests: [] };
        },
      },
    });
    const port = new FakeMirror();
    await approvedTickets(s);
    await s.engine.runUntilIdle();
    const mirror = new Mirror(s.ctx, port, { maxPerFlush: 100 });
    while ((await mirror.flush()) > 0);
    expect(port.threads).toEqual([{ ticketId: 'T-1', title: 'T-1 기능 구현', id: 'thread-T-1' }]);
    expect(new Set(port.posts.map((p) => p.username))).toEqual(new Set(['개발자', '리뷰어 · 감사관', '회사 시스템', '회의록']));
    const long = port.posts.find((p) => p.username === '리뷰어 · 감사관')!;
    expect(long.content.length).toBeLessThan(120);
    expect(long.content).toContain('http://office.ts.net/#ticket=T-1');
    expect(port.posts.find((p) => p.username === '회의록')!.content).toContain('티켓 회의');
  });

  it('한 번에 보내는 수에 상한이 있다', async () => {
    const s = setup();
    const port = new FakeMirror();
    await approvedTickets(s);
    await s.engine.runUntilIdle();
    const sent = await new Mirror(s.ctx, port, { maxPerFlush: 1 }).flush();
    expect(sent).toBe(1);
  });
});

describe('정기 보고 (⑥)', () => {
  it('관문을 통과하면 결재 대기 목록과 함께 #보고에 올린다. 같은 칸은 한 번만', async () => {
    const s = setup();
    toEvening(s);
    const discord = new FakeDiscord();
    const reports = new ReportService(s.ctx, s.engine, discord);
    await orderUntilPlanApproval(s);
    const r = await reports.submit('오늘은 계획서 1건이 결재를 기다려요.');
    expect(r).toMatchObject({ posted: true, gate: { passed: true } });
    const [m] = discord.in('reports');
    expect(m!.content).toContain('정기 보고 · 2026-10-15 18:00');
    expect(m!.content).toContain('GPT 관문 통과');
    expect(m!.content).toContain('결재 대기');
    expect(await reports.submit('다시')).toMatchObject({ posted: false });
    expect(s.mock.callsFor('gate').at(-1)!.prompt.user).toContain('<data source="비서실장 보고문">');
  });

  it('관문 반려는 2번까지 돌려보내고, 3번째는 반대 의견을 붙여 올린다', async () => {
    const s = setup({ handlers: { gate: (req) => ((req.input as { report?: string }).report ? { passed: false, issues: ['결재 대기를 빠뜨림'], objection: '결재 대기 누락' } : { passed: true, issues: [], objection: null }) } });
    toEvening(s);
    const discord = new FakeDiscord();
    const reports = new ReportService(s.ctx, s.engine, discord);
    expect(await reports.submit('보고 1')).toMatchObject({ posted: false, gate: { issues: ['결재 대기를 빠뜨림'] } });
    expect(await reports.submit('보고 2')).toMatchObject({ posted: false });
    expect(await reports.submit('보고 3')).toMatchObject({ posted: true });
    expect(discord.in('reports')[0]!.content).toContain('GPT 반대 의견: 결재 대기 누락');
  });

  it('GPT 한도가 떨어졌으면 "관문 미통과"를 달고 올린다', async () => {
    const s = setup();
    toEvening(s);
    recordUsage(s.ctx, { budget: 'review', inputTokens: 1, outputTokens: 1, estimatedPct: 100, estimatedWeeklyPct: 10, source: 'estimated' });
    const discord = new FakeDiscord();
    const r = await new ReportService(s.ctx, s.engine, discord).submit('보고');
    expect(r).toMatchObject({ posted: true, gate: null });
    expect(discord.in('reports')[0]!.content).toContain('관문 미통과');
  });

  it('비서실장 보고가 유예 시간 안에 없으면 시스템 봇이 데이터만으로 대신 보고한다', async () => {
    const s = setup();
    s.clock.advanceHours(9); // 18:00
    const discord = new FakeDiscord();
    const reports = new ReportService(s.ctx, s.engine, discord);
    expect(await reports.fallbackIfMissing()).toBe(false); // 아직 유예 시간 안
    s.clock.advance(11 * 60_000); // 18:11
    expect(await reports.fallbackIfMissing()).toBe(true);
    expect(discord.in('reports')[0]!.content).toContain('비서실장 보고가 없어 회사 데이터만 올려요');
    expect(await reports.fallbackIfMissing()).toBe(false);
  });
});
