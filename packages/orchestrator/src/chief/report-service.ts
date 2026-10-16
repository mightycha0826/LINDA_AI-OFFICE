// 정기 보고 (10장). 08:00 · 18:00 · 22:00.
// - 비서실장(헤르메스 cron)이 보고문을 submit_report로 낸다. GPT 관문을 거쳐 시스템 봇이 #보고에 올린다(3단계 결정 A).
//   관문 반려는 최대 2회, 그다음에도 반려면 반대 의견을 붙여 올린다. GPT 한도가 떨어졌으면 "관문 미통과"를 달고 올린다.
// - 점검 시각에서 reportGraceMin분이 지나도 보고가 없으면 시스템 봇이 데이터만으로 대신 보고한다.
import { getState, setState, type Ctx } from '../context.ts';
import type { Engine } from '../engine.ts';
import { buildReportData, formatReportData } from '../reports.ts';
import { currentSlot, localTime } from '../discord/schedule.ts';
import type { DiscordPort } from '../discord/types.ts';

const DONE = 'report.done';
const ATTEMPTS = 'report.attempts';
const LAST_SLOT_AT = 'report.lastAt';

export interface SubmitResult {
  posted: boolean;
  gate: { passed: boolean; issues: string[]; objection: string | null } | null;
  note: string;
}

export class ReportService {
  private readonly c: Ctx;
  private readonly engine: Engine;
  private readonly port: DiscordPort;

  constructor(c: Ctx, engine: Engine, port: DiscordPort) {
    this.c = c;
    this.engine = engine;
    this.port = port;
  }

  /** 지금 보고 칸. 점검 시간이 아니면 수시 보고 */
  slotNow(): string {
    // 점검 시각부터 한 시간 안에 낸 보고는 그 칸의 정기 보고로 본다
    return currentSlot(this.c.config, this.c.clock.now(), Math.max(60, this.c.config.schedule.checkWindowMin)) ?? `수시 ${this.c.clock.now().toISOString().slice(0, 16)}`;
  }

  private isDone(slot: string): boolean {
    return !!getState<Record<string, string>>(this.c, DONE, {})[slot];
  }

  private markDone(slot: string): void {
    const done = getState<Record<string, string>>(this.c, DONE, {});
    setState(this.c, DONE, { ...done, [slot]: this.c.clock.now().toISOString() });
    setState(this.c, LAST_SLOT_AT, this.c.clock.now().toISOString());
  }

  /** 지난 보고 이후 (없으면 24시간 전) */
  since(): string {
    return getState<string>(this.c, LAST_SLOT_AT, new Date(this.c.clock.now().getTime() - 24 * 3_600_000).toISOString());
  }

  private async post(slot: string, body: string, gateLabel: string): Promise<void> {
    const data = buildReportData(this.c, this.since());
    const approvals = data.pendingApprovals.length
      ? data.pendingApprovals.map((a) => `- ${a.summary}${a.link ? ` — ${a.link}` : ''}`).join('\n')
      : '- 없음';
    await this.port.send({ channel: 'reports', content: `**정기 보고 · ${slot}**\n${body}\n\n${gateLabel}\n\n**결재 대기 (여기서 한 번에 처리)**\n${approvals}` });
    this.markDone(slot);
  }

  async submit(text: string, slot = this.slotNow()): Promise<SubmitResult> {
    if (this.isDone(slot)) return { posted: false, gate: null, note: `${slot} 보고는 이미 올라갔어요` };
    const gate = await this.engine.gateReport(text);
    if (!gate) {
      await this.post(slot, text, '관문 미통과 (GPT 한도 소진이나 연결 문제로 검사하지 못했어요)');
      return { posted: true, gate: null, note: '관문 없이 올렸어요' };
    }
    if (gate.passed) {
      await this.post(slot, text, 'GPT 관문 통과');
      return { posted: true, gate, note: '올렸어요' };
    }
    const attempts = getState<Record<string, number>>(this.c, ATTEMPTS, {});
    const n = (attempts[slot] ?? 0) + 1;
    setState(this.c, ATTEMPTS, { ...attempts, [slot]: n });
    if (n <= this.c.config.maxGateRejections) {
      return { posted: false, gate, note: `관문에서 반려됐어요(${n}/${this.c.config.maxGateRejections}). 지적을 고쳐 다시 내 주세요` };
    }
    await this.post(slot, text, `GPT 반대 의견: ${gate.objection ?? gate.issues.join(' / ')}`);
    return { posted: true, gate, note: '반대 의견을 붙여 올렸어요' };
  }

  /** 점검 시각에서 유예 시간이 지나도 보고가 없으면 데이터만으로 대신 보고한다. 올렸으면 true */
  async fallbackIfMissing(): Promise<boolean> {
    const c = this.c;
    const slot = currentSlot(c.config, c.clock.now(), c.config.schedule.checkWindowMin);
    if (!slot || this.isDone(slot)) return false;
    const start = Number(slot.slice(-5, -3)) * 60 + Number(slot.slice(-2));
    const into = localTime(c.clock.now(), c.config.schedule.timezone).minutes - start;
    if (into < c.config.schedule.reportGraceMin) return false;
    await this.post(slot, `비서실장 보고가 없어 회사 데이터만 올려요.\n${formatReportData(buildReportData(c, this.since()))}`, '데이터 보고 (AI가 쓴 글이 아니라 관문을 거치지 않았어요)');
    return true;
  }
}
