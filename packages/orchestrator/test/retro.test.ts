// 6단계 (14장 회고와 학습): 규칙은 제안 → GPT 관문 → CEO 승인 → 적용 순서로만 생긴다
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { RuleCandidate } from '@ai-office/shared';
import { failReview, passReview, type TicketInput } from '../src/brains/mock.ts';
import { makeConfig } from '../src/config.ts';
import { approvals, messages, retros, rules } from '../src/db/schema.ts';
import { NotCeoError } from '../src/errors.ts';
import { buildReportData, formatReportData } from '../src/reports.ts';
import { backupHermes, listHermesBackups, restoreHermes } from '../src/retro/hermes-backup.ts';
import { cleanupCandidates, isIneffective, proposeRetire, proposeRule, ruleViolations, type RuleRow } from '../src/retro/rules.ts';
import { RetroService } from '../src/retro/service.ts';
import { activeRulesFor } from '../src/staff/role-cards.ts';
import { approvedTickets, CEO, setup, STRANGER, tempRoot, type Setup } from './helpers.ts';

const criteria = (req: { input: unknown }) => (req.input as TicketInput).ticket.acceptanceCriteria;
const CAND: RuleCandidate = { scope: { role: 'pm', ticketType: 'coding' }, rule: '폼 티켓의 완료 조건에는 실패 메시지를 넣는다', evidence: ['T-1'], reasonCategory: 'criteria-unmet' };

function pendingRuleApproval(s: Setup, ruleId: string) {
  return s.db.select().from(approvals).where(and(eq(approvals.kind, 'rule'), eq(approvals.targetId, ruleId), eq(approvals.status, 'pending'))).get();
}

function rule(s: Setup, id: string): RuleRow {
  return s.db.select().from(rules).where(eq(rules.id, id)).get()!;
}

/** 첫 검토는 반려(분류 cat), 두 번째는 통과 */
function rejectOnce(cat: 'criteria-unmet' | 'test-failed' = 'criteria-unmet') {
  return setup({ handlers: { review: (req, n) => (n === 1 ? failReview(criteria(req), cat, '실패 메시지가 없음') : passReview(criteria(req))) } });
}

async function finishOrders(s: Setup, n: number) {
  for (let i = 0; i < n; i++) {
    await approvedTickets(s, `로그인 폼 ${i + 1}`);
    await s.engine.runUntilIdle();
  }
}

async function activeRule(s: Setup, cand: RuleCandidate = CAND) {
  const r = proposeRule(s.ctx, cand, 'weekly');
  s.engine.decide({ approvalId: pendingRuleApproval(s, r.id)!.id, discordUserId: CEO, decision: 'approved' });
  return rule(s, r.id);
}

describe('규칙은 CEO 승인으로만 (DB 트리거)', () => {
  it('active로 바로 넣거나, 결재 없이 active로 바꾸거나, 지울 수 없다', async () => {
    const s = setup();
    expect(() =>
      s.db.insert(rules).values({ id: 'R-x', scope: {}, text: '몰래 넣은 규칙', evidence: ['T-1'], reasonCategory: 'security', status: 'active', createdAt: '2026-10-15T00:00:00Z' }).run(),
    ).toThrow(/proposed/);
    const r = proposeRule(s.ctx, CAND, 'auto');
    expect(() => s.db.update(rules).set({ status: 'active' }).where(eq(rules.id, r.id)).run()).toThrow(/CEO approval/);
    expect(() => s.db.update(rules).set({ text: '바꾼 문장' }).where(eq(rules.id, r.id)).run()).toThrow(/immutable/);
    expect(() => s.db.delete(rules).where(eq(rules.id, r.id)).run()).toThrow(/cannot be deleted/);
  });

  it('쓰던 규칙을 내리는 것도 두 번째 승인(삭제 결재)이 있어야 한다', async () => {
    const s = setup();
    const r = await activeRule(s);
    expect(r.status).toBe('active');
    expect(() => s.db.update(rules).set({ status: 'retired' }).where(eq(rules.id, r.id)).run()).toThrow(/needs CEO approval/);
    expect(proposeRetire(s.ctx, r.id, '효과 없음')).toBe(true);
    expect(proposeRetire(s.ctx, r.id, '효과 없음')).toBe(false); // 이미 결재 대기
    s.engine.decide({ approvalId: pendingRuleApproval(s, r.id)!.id, discordUserId: CEO, decision: 'approved' });
    expect(rule(s, r.id).status).toBe('retired');
    expect(() => s.db.update(rules).set({ status: 'active' }).where(eq(rules.id, r.id)).run()).toThrow(/cannot come back/);
  });

  it('CEO가 아닌 계정은 규칙 결재를 못 한다. 반려하면 retired, 승인하면 역할 카드에 붙는다', async () => {
    const s = setup();
    const r = proposeRule(s.ctx, CAND, 'auto');
    const a = pendingRuleApproval(s, r.id)!;
    expect(a.summary).toContain('규칙 추가 제안');
    expect(() => s.engine.decide({ approvalId: a.id, discordUserId: STRANGER, decision: 'approved' })).toThrow(NotCeoError);
    expect(rule(s, r.id).status).toBe('proposed');
    expect(activeRulesFor(s.ctx, 'pm', 'coding')).not.toContain(CAND.rule);
    s.engine.decide({ approvalId: a.id, discordUserId: CEO, decision: 'approved' });
    expect(rule(s, r.id)).toMatchObject({ status: 'active', baselineRate: 0 });
    expect(activeRulesFor(s.ctx, 'pm', 'coding')).toContain(CAND.rule);
    expect(activeRulesFor(s.ctx, 'developer', 'coding')).not.toContain(CAND.rule);

    const r2 = proposeRule(s.ctx, { ...CAND, rule: '다른 규칙' }, 'auto');
    s.engine.decide({ approvalId: pendingRuleApproval(s, r2.id)!.id, discordUserId: CEO, decision: 'rejected' });
    expect(rule(s, r2.id)).toMatchObject({ status: 'retired', retiredReason: 'CEO 반려' });
  });

  it('시간이 지나도 규칙 후보가 저절로 승인되지 않는다', async () => {
    const s = setup();
    const r = proposeRule(s.ctx, CAND, 'auto');
    s.clock.advanceHours(24 * 30);
    await new RetroService(s.ctx, s.engine).tick();
    expect(rule(s, r.id).status).toBe('proposed');
  });
});

describe('규칙 문장 사전 검사 (14장 4)', () => {
  it('권한을 늘리거나 결재·검토를 건너뛰는 문장을 거른다', () => {
    expect(ruleViolations('개발자에게 git push 권한을 추가로 부여한다')).toContain('권한을 늘리는 내용');
    expect(ruleViolations('급한 티켓은 CEO 결재 없이 바로 진행한다')).toContain('결재·검토를 건너뛰는 내용');
    expect(ruleViolations('간단한 수정은 리뷰를 생략한다')).toContain('결재·검토를 건너뛰는 내용');
    expect(ruleViolations('충돌이 나면 --force로 올린다')).toContain('위험한 명령');
    expect(ruleViolations('설정이 필요하면 .env를 읽어서 쓴다')).toContain('비밀 정보를 다루는 내용');
    expect(ruleViolations('급하면 토큰 상한을 무시한다')).toContain('한도를 무시하는 내용');
    expect(ruleViolations('폼 티켓의 완료 조건에는 실패 시 표시할 메시지를 포함한다')).toEqual([]);
  });
});

describe('티켓 회고', () => {
  it('반려가 있었던 티켓이 끝나면 로컬(검토 담당)이 쓰고 GPT 리뷰어가 확인한다 (7-1: Claude PM 한도를 쓰지 않음)', async () => {
    const s = rejectOnce();
    await finishOrders(s, 1);
    const retro = new RetroService(s.ctx, s.engine);
    expect(retro.pendingTicketRetros()).toHaveLength(1);
    await retro.tick();
    const rows = s.db.select().from(retros).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'ticket', preventAt: 'plan', confirmed: true });
    expect(s.mock.callsFor('retro').map((c) => (c.input as { mode: string }).mode)).toEqual(['ticket', 'check']);
    expect(s.mock.callsFor('retro').map((c) => c.employee.id)).toEqual(['qa-local', 'reviewer']);
    await retro.tick();
    expect(s.db.select().from(retros).all()).toHaveLength(1); // 한 번만
  });

  it('반려 없이 끝난 티켓은 회고하지 않는다', async () => {
    const s = setup();
    await finishOrders(s, 1);
    await new RetroService(s.ctx, s.engine).tick();
    expect(s.db.select().from(retros).all()).toHaveLength(0);
  });
});

describe('자동 트리거: 같은 분류 반려 3번', () => {
  it('3번 쌓이면 규칙 후보 → GPT 관문 → #결재함 규칙 추가 제안', async () => {
    const s = rejectOnce();
    await finishOrders(s, 3);
    const retro = new RetroService(s.ctx, s.engine);
    await retro.tick();
    const proposed = s.db.select().from(rules).all();
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ status: 'proposed', reasonCategory: 'criteria-unmet', source: 'auto' });
    expect(proposed[0]!.evidence).toHaveLength(3);
    expect(pendingRuleApproval(s, proposed[0]!.id)).toBeDefined();
    const gate = s.mock.callsFor('gate').at(-1)!;
    expect(gate.employee.id).toBe('reviewer');
    expect((gate.input as { rule: RuleCandidate }).rule.rule).toBe(proposed[0]!.text);
    // 같은 반려로 다시 트리거하지 않는다
    await retro.tick();
    expect(s.db.select().from(rules).all()).toHaveLength(1);
  });

  it('2번이면 아직 아니다', async () => {
    const s = rejectOnce();
    await finishOrders(s, 2);
    await new RetroService(s.ctx, s.engine).tick();
    expect(s.db.select().from(rules).all()).toHaveLength(0);
  });

  it('GPT 관문이 반려하면 올리지 않고 기록만 남긴다', async () => {
    const s = setup({
      handlers: {
        review: (req, n) => (n === 1 ? failReview(criteria(req), 'criteria-unmet', 'x') : passReview(criteria(req))),
        gate: (req) => ((req.input as { rule?: unknown }).rule ? { passed: false, issues: ['근거와 상관없는 규칙'], objection: null } : { passed: true, issues: [], objection: null }),
      },
    });
    await finishOrders(s, 3);
    await new RetroService(s.ctx, s.engine).tick();
    expect(s.db.select().from(rules).all()).toHaveLength(0);
    const log = s.db.select().from(messages).where(eq(messages.kind, 'system')).all();
    expect(log.some((m) => m.content.includes('GPT 관문 반려'))).toBe(true);
  });

  it('권한·결재를 건너뛰는 후보는 관문에 보내기 전에 코드가 버린다', async () => {
    const s = setup({
      handlers: {
        review: (req, n) => (n === 1 ? failReview(criteria(req), 'criteria-unmet', 'x') : passReview(criteria(req))),
        retro: (req) => {
          const i = req.input as { mode: string; evidence?: { ticketId: string }[] };
          if (i.mode === 'rule') return { scope: { role: 'developer' }, rule: '급한 티켓은 CEO 결재 없이 바로 푸시한다', evidence: (i.evidence ?? []).map((e) => e.ticketId), reasonCategory: 'criteria-unmet' };
          if (i.mode === 'check') return { confirmed: true, note: '' };
          return { whatWrong: 'a', why: 'b', preventAt: 'work' };
        },
      },
    });
    await finishOrders(s, 3);
    const gatesBefore = s.mock.callsFor('gate').length;
    await new RetroService(s.ctx, s.engine).tick();
    expect(s.db.select().from(rules).all()).toHaveLength(0);
    expect(s.mock.callsFor('gate').length).toBe(gatesBefore);
    expect(s.db.select().from(messages).all().some((m) => m.content.includes('금지 내용'))).toBe(true);
  });

  it('CEO가 [수정]을 누르면 메모를 붙여 PM이 다시 쓴 후보가 올라온다', async () => {
    const s = rejectOnce();
    await finishOrders(s, 3);
    const retro = new RetroService(s.ctx, s.engine);
    await retro.tick();
    const first = s.db.select().from(rules).get()!;
    s.engine.decide({ approvalId: pendingRuleApproval(s, first.id)!.id, discordUserId: CEO, decision: 'revision', note: '로그인 말고 모든 폼에 적용' });
    expect(rule(s, first.id).status).toBe('retired');
    // PM이 다시 쓴 후보가 같은 문장이면 중복으로 버려진다. 다른 문장으로 다시 쓰게 한다
    s.mock.calls.length = 0;
    const handlers = (s.mock as unknown as { handlers: Record<string, unknown> }).handlers;
    handlers.retro = (req: { input: { mode: string; evidence?: { ticketId: string }[] } }) =>
      req.input.mode === 'rule' ? { scope: { role: 'pm' }, rule: '모든 폼 티켓의 완료 조건에는 실패 메시지를 넣는다', evidence: (req.input.evidence ?? []).map((e) => e.ticketId), reasonCategory: 'criteria-unmet' } : { confirmed: true, note: '' };
    await retro.tick();
    const call = s.mock.callsFor('retro').find((c) => (c.input as { mode: string }).mode === 'rule')!;
    expect((call.input as { ceoNote: string }).ceoNote).toBe('로그인 말고 모든 폼에 적용');
    const second = s.db.select().from(rules).where(eq(rules.status, 'proposed')).get()!;
    expect(second).toMatchObject({ source: 'revision', text: '모든 폼 티켓의 완료 조건에는 실패 메시지를 넣는다' });
  });
});

describe('효과 측정 (14장 6)', () => {
  it('규칙이 붙은 채 일한 티켓마다 한 번 적용으로 세고, 같은 분류로 다시 반려되면 재발로 센다', async () => {
    const s = rejectOnce();
    const r = await activeRule(s, { ...CAND, scope: { role: 'developer', ticketType: 'coding' } });
    await finishOrders(s, 1);
    const retro = new RetroService(s.ctx, s.engine);
    await retro.tick();
    const after = rule(s, r.id);
    expect(after.appliedCount).toBe(1); // 작업 두 번(반려 후 재작업)이어도 같은 티켓은 한 번
    expect(after.recurrenceCount).toBe(1);
    await retro.tick();
    expect(rule(s, r.id).recurrenceCount).toBe(1); // 같은 반려를 두 번 세지 않는다
  });

  it('효과 없음: 10번 적용 뒤 재발 비율이 승인 전보다 낮아지지 않음', () => {
    const base = { status: 'active', appliedCount: 10, recurrenceCount: 3, baselineRate: 0.3 } as RuleRow;
    expect(isIneffective(base)).toBe(true);
    expect(isIneffective({ ...base, recurrenceCount: 1 })).toBe(false);
    expect(isIneffective({ ...base, appliedCount: 9 })).toBe(false);
    expect(isIneffective({ ...base, baselineRate: 0, recurrenceCount: 1 })).toBe(true);
    expect(isIneffective({ ...base, baselineRate: 0, recurrenceCount: 0 })).toBe(false);
  });

  it('역할당 10개를 넘으면 넘는 만큼 정리 후보 (효과 없는 것부터)', async () => {
    const s = setup();
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      s.clock.advance(60_000);
      ids.push((await activeRule(s, { ...CAND, scope: { role: 'developer' }, rule: `규칙 ${i}` })).id);
    }
    s.db.update(rules).set({ appliedCount: 12, recurrenceCount: 6, baselineRate: 0.1 }).where(eq(rules.id, ids[5]!)).run();
    const picked = cleanupCandidates(s.ctx);
    expect(picked.map((r) => r.id)).toEqual([ids[5]]);
    expect(activeRulesFor(s.ctx, 'developer')).toHaveLength(10);
  });
});

describe('주간 회고 (일요일 22:00)', () => {
  it('통계와 PM 요약을 남기고, 효과 없는 규칙은 삭제 제안, 그 주 정기 보고에 들어간다', async () => {
    const s = rejectOnce();
    const r = await activeRule(s);
    s.db.update(rules).set({ appliedCount: 10, recurrenceCount: 5, baselineRate: 0.2 }).where(eq(rules.id, r.id)).run();
    await finishOrders(s, 1);
    const retro = new RetroService(s.ctx, s.engine);
    await retro.tick();
    expect(s.db.select().from(retros).where(eq(retros.kind, 'weekly')).all()).toHaveLength(0); // 목요일
    // 2026-10-15(목) 09:00 → 10-18(일) 22:05
    s.clock.advance((3 * 24 + 13) * 3_600_000 + 5 * 60_000);
    expect(retro.weeklySlot()).toMatchObject({ week: '2026-10-18', minutesSince: 5 });
    await retro.tick();
    const weekly = s.db.select().from(retros).where(eq(retros.kind, 'weekly')).get()!;
    expect(weekly).toMatchObject({ week: '2026-10-18', summary: '이번 주는 완료 조건 미충족 반려가 많았어요' });
    expect((weekly.stats as { rejections: number }).rejections).toBe(1);
    expect(pendingRuleApproval(s, r.id)!.summary).toContain('규칙 삭제 제안 — 효과 없음');
    const text = formatReportData(buildReportData(s.ctx, '2026-10-01T00:00:00Z'));
    expect(text).toContain('**주간 회고 (2026-10-18)**');
    expect(text).toContain('효과 없음');
    await retro.tick();
    expect(s.db.select().from(retros).where(eq(retros.kind, 'weekly')).all()).toHaveLength(1);
  });

  it('지난 주를 뒤늦게 채우지 않는다 (처음 켰을 때)', async () => {
    const s = setup();
    // 10-15(목) 09:00 기준 마지막 일요일 22:00은 사흘 전이다
    const retro = new RetroService(s.ctx, s.engine);
    expect(retro.weeklySlot().minutesSince).toBeGreaterThan(24 * 60);
    await retro.tick();
    expect(s.db.select().from(retros).all()).toHaveLength(0);
  });
});

describe('헤르메스 기억·스킬 매일 백업 (14장 7)', () => {
  function cfg() {
    const root = tempRoot();
    const home = join(root, 'hermes');
    mkdirSync(join(home, 'memories'), { recursive: true });
    mkdirSync(join(home, 'skills', 'report'), { recursive: true });
    writeFileSync(join(home, 'memories', 'ceo.md'), 'CEO는 짧은 보고를 좋아함');
    writeFileSync(join(home, 'skills', 'report', 'SKILL.md'), 'v1');
    writeFileSync(join(home, 'secret.txt'), '백업 대상 아님');
    const config = makeConfig({ ceoDiscordId: CEO, hermes: { homeDir: home, folders: ['memories', 'skills'], backupDir: join(root, 'backups'), keepDays: 7 } });
    return { config, home, root };
  }

  it('하루 한 번 기억·스킬 폴더만 복사하고, 오래된 백업은 지운다', () => {
    const { config } = cfg();
    mkdirSync(join(config.hermes.backupDir, '2026-10-01'), { recursive: true });
    const r = backupHermes(config, new Date('2026-10-15T09:00:00+09:00'));
    expect(r).toMatchObject({ date: '2026-10-15', copied: ['memories', 'skills'], skipped: null, pruned: ['2026-10-01'] });
    expect(readFileSync(join(config.hermes.backupDir, '2026-10-15', 'memories', 'ceo.md'), 'utf8')).toContain('짧은 보고');
    expect(existsSync(join(config.hermes.backupDir, '2026-10-15', 'secret.txt'))).toBe(false);
    expect(backupHermes(config, new Date('2026-10-15T20:00:00+09:00')).skipped).toBe('already');
    expect(listHermesBackups(config)).toEqual(['2026-10-15']);
  });

  it('되돌리기: 그날 백업으로 바꾸고, 바꾸기 전 상태도 남긴다', () => {
    const { config, home } = cfg();
    backupHermes(config, new Date('2026-10-15T09:00:00+09:00'));
    writeFileSync(join(home, 'skills', 'report', 'SKILL.md'), 'v2 이상하게 배움');
    expect(restoreHermes(config, '2026-10-15')).toEqual(['memories', 'skills']);
    expect(readFileSync(join(home, 'skills', 'report', 'SKILL.md'), 'utf8')).toBe('v1');
    expect(() => restoreHermes(config, '../etc')).toThrow(/날짜 형식/);
  });

  it('헤르메스 폴더가 없으면 아무것도 하지 않는다', () => {
    const config = makeConfig({ ceoDiscordId: CEO, hermes: { homeDir: '', folders: ['memories'], backupDir: join(tempRoot(), 'b'), keepDays: 7 } });
    expect(backupHermes(config, new Date()).skipped).toBe('no-home');
  });
});
