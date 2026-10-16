// 결재 봇 (9장, 7장): CEO 계정만, 버튼으로만, 두 번 클릭·오래된 버튼, 슬래시 명령.
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { makeConfig } from '../src/config.ts';
import { approvals, tickets } from '../src/db/schema.ts';
import { InteractionHandler } from '../src/discord/interactions.ts';
import { isCeoPresent } from '../src/discord/presence.ts';
import type { Interaction } from '../src/discord/types.ts';
import { isStopped } from '../src/context.ts';
import { loadSettingOverrides } from '../src/settings.ts';
import { CEO, STRANGER, approvedTickets, eventsOf, orderUntilPlanApproval, pendingPlanApproval, setup, ticket } from './helpers.ts';

const handler = (s: ReturnType<typeof setup>) => new InteractionHandler(s.ctx, s.engine);
const click = (customId: string, userId = CEO): Interaction => ({ type: 'button', userId, customId });
const cmd = (name: string, options: Record<string, string> = {}, userId = CEO): Interaction => ({ type: 'command', userId, name, options });

describe('CEO 계정 확인', () => {
  it('CEO가 아니면 버튼·명령 모두 무시하고 아무것도 바꾸지 않는다', async () => {
    const s = setup();
    const { approval } = await orderUntilPlanApproval(s);
    const h = handler(s);
    const before = eventsOf(s).length;
    expect(await h.handle(click(`ap:${approval!.id}:approved`, STRANGER))).toEqual({ kind: 'ignore' });
    expect(await h.handle(cmd('정지', {}, STRANGER))).toEqual({ kind: 'ignore' });
    expect(await h.handle({ type: 'modal', userId: STRANGER, customId: `apm:${approval!.id}`, fields: { note: 'x' } })).toEqual({ kind: 'ignore' });
    expect(pendingPlanApproval(s)!.id).toBe(approval!.id);
    expect(isStopped(s.ctx)).toBe(false);
    expect(eventsOf(s).length).toBe(before);
  });

  it('CEO가 누르면 접속 중으로 바뀐다', async () => {
    const s = setup();
    await handler(s).handle(cmd('한도'));
    expect(isCeoPresent(s.ctx)).toBe(true);
    expect(eventsOf(s, 'ceo.presence').at(-1)!.payload).toEqual({ status: 'online' });
  });
});

describe('결재 버튼', () => {
  it('승인하면 메시지 버튼이 모두 비활성화되고, 두 번 누르면 "이미 처리된 결재예요"', async () => {
    const s = setup();
    const { approval } = await orderUntilPlanApproval(s);
    const h = handler(s);
    const r = await h.handle(click(`ap:${approval!.id}:approved`));
    expect(r.kind).toBe('update');
    if (r.kind !== 'update') return;
    expect(r.content).toContain('승인됨');
    expect(r.buttons.flat().every((b) => b.disabled)).toBe(true);
    expect(s.db.select().from(tickets).all()).toHaveLength(1);

    expect(await h.handle(click(`ap:${approval!.id}:approved`))).toEqual({ kind: 'reply', content: '이미 처리된 결재예요', ephemeral: true });
    expect(await h.handle(click(`ap:${approval!.id}:rejected`))).toMatchObject({ kind: 'reply', content: '이미 처리된 결재예요' });
    expect(s.db.select().from(tickets).all()).toHaveLength(1);
  });

  it('수정 요청은 입력창을 띄우고, 쓴 내용이 PM에게 간다', async () => {
    const s = setup();
    const { approval } = await orderUntilPlanApproval(s);
    const h = handler(s);
    const modal = await h.handle(click(`ap:${approval!.id}:revision`));
    expect(modal).toMatchObject({ kind: 'modal', customId: `apm:${approval!.id}` });
    await h.handle({ type: 'modal', userId: CEO, customId: `apm:${approval!.id}`, fields: { note: '인증 링크 만료는 24시간' } });
    await s.engine.runUntilIdle();
    expect(JSON.stringify(s.mock.callsFor('plan').at(-1)!.input)).toContain('인증 링크 만료는 24시간');
    expect(pendingPlanApproval(s)!.targetVersion).toBe(2);
  });

  it('새 버전이 나온 뒤 옛 버튼은 "새 버전이 있어요"', async () => {
    const s = setup();
    const { order, approval: v1 } = await orderUntilPlanApproval(s);
    const { createPlanVersion, startGateReview, recordGateResult } = await import('../src/core/plans.ts');
    const { planOutput } = await import('../src/brains/mock.ts');
    const v2 = createPlanVersion(s.ctx, order.id, planOutput({ goal: 'v2' }), { afterGateRejection: false });
    startGateReview(s.ctx, v2.id);
    recordGateResult(s.ctx, v2.id, { passed: true, issues: [], objection: null });
    expect(await handler(s).handle(click(`ap:${v1!.id}:approved`))).toEqual({ kind: 'reply', content: '새 버전이 있어요', ephemeral: true });
    expect(s.db.select().from(tickets).all()).toHaveLength(0);
  });
});

describe('막힘 버튼', () => {
  async function blockedTicket() {
    const s = setup({
      handlers: {
        review: (req) => {
          const c = (req.input as { ticket: { acceptanceCriteria: string[] } }).ticket.acceptanceCriteria;
          return { verdict: 'fail', criteria: c.map((criterion) => ({ criterion, pass: false, reason: 'x' })), reasonCategory: 'criteria-unmet', fixRequests: ['x'] };
        },
        meeting: () => ({ claim: '입장 유지', agree: false, nextActions: [] }),
      },
    });
    const { tickets: [tk] } = await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(ticket(s, tk!.id).status).toBe('blocked');
    return { s, tk: tk! };
  }

  it('[방향 지시]는 입력창을 띄우고, 쓴 내용과 함께 다시 진행한다', async () => {
    const { s, tk } = await blockedTicket();
    const h = handler(s);
    expect(await h.handle(click(`bk:${tk.id}:direct`))).toMatchObject({ kind: 'modal', customId: `bkm:${tk.id}` });
    const r = await h.handle({ type: 'modal', userId: CEO, customId: `bkm:${tk.id}`, fields: { note: '테스트부터 고쳐' } });
    expect(r).toMatchObject({ kind: 'update', content: expect.stringContaining('테스트부터 고쳐') });
    expect(ticket(s, tk.id).status).toBe('in_progress');
  });

  it('[취소]는 티켓을 끝낸다', async () => {
    const { s, tk } = await blockedTicket();
    await handler(s).handle(click(`bk:${tk.id}:cancel`));
    expect(ticket(s, tk.id).status).toBe('cancelled');
  });
});

describe('푸시 확인 (③)', () => {
  it('/push는 버튼만 띄운다. main은 한 번 더 확인하고, 결정만 기록한다(실행은 4단계)', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    const h = handler(s);
    expect(await h.handle(cmd('push', { 티켓: tk!.id }))).toMatchObject({ kind: 'reply', content: expect.stringContaining('작업 브랜치가 없어요') });

    s.db.update(tickets).set({ branch: 'feature/T1-login' }).where(eq(tickets.id, tk!.id)).run();
    await h.handle(cmd('push', { 티켓: 't-1' }));
    const a = s.db.select().from(approvals).where(eq(approvals.kind, 'push')).get()!;
    expect(a).toMatchObject({ status: 'pending', targetId: 'T-1', reversible: 'partial' });
    expect(await h.handle(cmd('push', { 티켓: 'T-1' }))).toMatchObject({ content: expect.stringContaining('이미 결재함에') });

    const confirm = await h.handle(click(`push:${a.id}:main`));
    expect(confirm).toMatchObject({ kind: 'update', content: expect.stringContaining('main에 바로 병합합니다') });
    expect(s.db.select().from(approvals).where(eq(approvals.id, a.id)).get()!.status).toBe('pending');

    await h.handle(click(`pushc:${a.id}:merge`));
    expect(s.db.select().from(approvals).where(eq(approvals.id, a.id)).get()).toMatchObject({ status: 'approved', choice: 'main', decidedByDiscordId: CEO });
  });

  it('[취소]는 반려로 기록한다', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    s.db.update(tickets).set({ branch: 'feature/T1-x' }).where(eq(tickets.id, tk!.id)).run();
    const h = handler(s);
    await h.handle(cmd('되돌리기', { 티켓: 'T-1' }));
    const a = s.db.select().from(approvals).where(eq(approvals.kind, 'revert')).get()!;
    await h.handle(click(`push:${a.id}:cancel`));
    expect(s.db.select().from(approvals).where(eq(approvals.id, a.id)).get()!.status).toBe('rejected');
  });
});

describe('슬래시 명령', () => {
  it('/정지 · /재개', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    const h = handler(s);
    await h.handle(cmd('정지'));
    expect(ticket(s, tk!.id).status).toBe('paused');
    await h.handle(cmd('재개'));
    expect(ticket(s, tk!.id).status).toBe('in_progress');
  });

  it('/보고 · /상태 · /한도', async () => {
    const s = setup();
    await approvedTickets(s);
    const h = handler(s);
    const report = await h.handle(cmd('보고'));
    expect(report).toMatchObject({ kind: 'reply', ephemeral: false });
    if (report.kind === 'reply') for (const sec of ['1. 완료된 일', '2. 결재 대기', '3. 막힌 것', '4. 사용량']) expect(report.content).toContain(sec);
    expect(await h.handle(cmd('상태', { 티켓: 'T-1' }))).toMatchObject({ content: expect.stringContaining('T-1') });
    expect(await h.handle(cmd('상태', { 티켓: '아무거나' }))).toMatchObject({ content: expect.stringContaining('T-12 형식') });
    expect(await h.handle(cmd('한도'))).toMatchObject({ content: expect.stringContaining('추정치') });
  });

  it('/설정: 검사를 통과한 값만 반영하고, 재시작 뒤에도 남는다', async () => {
    const s = setup();
    const h = handler(s);
    expect(await h.handle(cmd('설정', { 항목: 'absence-minutes', 값: '30' }))).toMatchObject({ content: '부재 전환 시간(분): 20분 → 30분' });
    expect(s.config.absenceMinutes).toBe(30);
    // 개발 90% + 리서치 15%는 100%를 넘어 반영하지 않는다
    expect(await h.handle(cmd('설정', { 항목: 'claude-dev-5h', 값: '90' }))).toMatchObject({ content: expect.stringContaining('반영하지 않았어요') });
    expect(s.config.limits.claude.fiveHour.dev).toBe(55);
    expect(await h.handle(cmd('설정', { 항목: 'report-times', 값: '07:30,19:00' }))).toMatchObject({ content: expect.stringContaining('07:30, 19:00') });
    expect(await h.handle(cmd('설정', { 항목: 'report-times', 값: '25:00' }))).toMatchObject({ content: expect.stringContaining('반영하지 않았어요') });

    // 재시작: 새 설정 객체에 DB에 남은 값을 덮는다
    const fresh = makeConfig({ ceoDiscordId: CEO, paths: s.config.paths });
    loadSettingOverrides({ ...s.ctx, config: fresh });
    expect(fresh.absenceMinutes).toBe(30);
    expect(fresh.schedule.checkTimes).toEqual(['07:30', '19:00']);
  });
});
