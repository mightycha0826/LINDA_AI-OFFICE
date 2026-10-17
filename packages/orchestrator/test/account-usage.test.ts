// 0단계 #5에서 찾은 것: Claude stream-json의 rate_limit_event로 계정 전체 사용률(실측)을 읽는다
import { describe, expect, it } from 'vitest';
import { parseClaudeStream } from '../src/brains/claude-code.ts';
import { getState } from '../src/context.ts';
import { buildReportData, formatReportData } from '../src/reports.ts';
import { buildSnapshot } from '../src/screen/snapshot.ts';
import { approvedTickets, setup } from './helpers.ts';

// 2026-10-16 실제 출력과 같은 모양 (값만 그대로)
const STREAM = [
  '{"type":"system","subtype":"init","session_id":"x"}',
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1792150800,"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.76,"resetsAt":1792150800},"seven_day":{"utilization":0.57,"resetsAt":1792468800}}}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}',
  '{"type":"result","subtype":"success","is_error":false,"result":"{}","structured_output":{"a":1},"usage":{"input_tokens":8,"output_tokens":676}}',
].join('\n');

describe('Claude stream-json 읽기', () => {
  it('최종 결과와 계정 5시간·주간 사용률을 꺼낸다', () => {
    const { result, account } = parseClaudeStream(STREAM);
    expect(result?.structured_output).toEqual({ a: 1 });
    expect(account).toEqual({
      provider: 'claude',
      fiveHourPct: 76,
      weeklyPct: 57,
      fiveHourResetsAt: new Date(1792150800 * 1000).toISOString(),
      weeklyResetsAt: new Date(1792468800 * 1000).toISOString(),
      status: 'allowed',
    });
  });

  it('예전 json 한 덩어리 출력도 읽는다 (사용률은 없음)', () => {
    const { result, account } = parseClaudeStream('{"type":"result","is_error":false,"result":"x","structured_output":{"b":2}}');
    expect(result?.structured_output).toEqual({ b: 2 });
    expect(account).toBeNull();
  });

  it('결과 줄이 없으면 null (오케스트레이터가 실패로 처리)', () => {
    expect(parseClaudeStream('{"type":"system"}\nnot json').result).toBeNull();
  });
});

describe('계정 사용률을 남기고 보여준다', () => {
  it('마지막 값을 저장하고, 화면 자원 탭과 정기 보고에 "실측"으로 나온다', async () => {
    const s = setup();
    const call = s.mock.call.bind(s.mock);
    s.mock.call = async (req) => {
      const r = await call(req);
      return { ...r, usage: { ...r.usage, account: { provider: 'claude', fiveHourPct: 61.5, weeklyPct: 20, fiveHourResetsAt: null, weeklyResetsAt: null, status: 'allowed' } } };
    };
    await approvedTickets(s);
    await s.engine.runUntilIdle();
    expect(getState<{ fiveHourPct: number } | null>(s.ctx, 'account.claude', null)?.fiveHourPct).toBe(61.5);
    const snap = buildSnapshot(s.ctx, { startedAt: '', gpu: null });
    expect(snap.system.account.claude).toMatchObject({ fiveHourPct: 61.5, weeklyPct: 20 });
    expect(formatReportData(buildReportData(s.ctx, '2026-10-01T00:00:00Z'))).toContain('Claude 계정 전체(개인 사용 포함, 실측): 5시간 61.5% · 주간 20%');
  });

  it('값이 없으면 화면과 보고에 나오지 않는다', () => {
    const s = setup();
    expect(buildSnapshot(s.ctx, { startedAt: '', gpu: null }).system.account.claude).toBeNull();
    expect(formatReportData(buildReportData(s.ctx, '2026-10-01T00:00:00Z'))).not.toContain('계정 전체');
  });
});
