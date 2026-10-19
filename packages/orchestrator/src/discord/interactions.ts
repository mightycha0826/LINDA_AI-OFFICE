// 결재 봇의 버튼·입력창·슬래시 명령 처리 (9장, 7장 결재 원칙).
// - 설정에 등록된 CEO 계정이 아니면 아무것도 하지 않고 기록만 남긴다.
// - 결재는 버튼 클릭으로만. 채팅의 "승인" 같은 글자는 처리하지 않는다(이 파일에 메시지 내용을 읽는 길이 없다).
// - 같은 결재를 두 번 누르면 "이미 처리된 결재예요", 오래된 버튼은 "새 버전이 있어요".
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.ts';
import { pendingApprovals, requestApproval, type ApprovalDecision } from '../core/approvals.ts';
import { budgetStatus } from '../core/budget.ts';
import { approvals, messages, plans, tickets } from '../db/schema.ts';
import type { Engine } from '../engine.ts';
import { AlreadyDecidedError, OfficeError, StaleApprovalError } from '../errors.ts';
import { buildReportData, formatReportData } from '../reports.ts';
import { applySetting, SETTINGS } from '../settings.ts';
import { approvalMessageFor, decidedMessage, mainMergeConfirm } from './messages.ts';
import { markCeoActive } from './presence.ts';
import type { Interaction, InteractionReply } from './types.ts';

const TICKET_ID = /^T-\d+$/;

/** Git 고양이 중 결재 봇이 쓰는 부분 (4단계) */
export interface GitCatPort {
  preparePush(ticketId: string, kind: 'push' | 'revert', origin: string): Promise<{ ok: boolean; message: string }>;
  registerAndClone(p: { id: string; repoUrl: string; testCommand: string; defaultBranch?: string }): Promise<string>;
}

export class InteractionHandler {
  private readonly c: Ctx;
  private readonly engine: Engine;
  private readonly log: (s: string) => void;
  private readonly gitcat: GitCatPort | null;

  constructor(c: Ctx, engine: Engine, log: (s: string) => void = () => {}, gitcat: GitCatPort | null = null) {
    this.c = c;
    this.engine = engine;
    this.log = log;
    this.gitcat = gitcat;
  }

  async handle(i: Interaction): Promise<InteractionReply> {
    if (i.userId !== this.c.config.ceoDiscordId) {
      this.log(`CEO가 아닌 계정의 입력을 무시했어요: ${i.userId} ${i.type} ${'customId' in i ? i.customId : i.name}`);
      return { kind: 'ignore' };
    }
    markCeoActive(this.c);
    try {
      if (i.type === 'button') return await this.button(i.customId);
      if (i.type === 'modal') return await this.modal(i.customId, i.fields);
      return await this.command(i.name, i.options, i.id);
    } catch (err) {
      if (err instanceof StaleApprovalError || err instanceof AlreadyDecidedError || err instanceof OfficeError) return { kind: 'reply', content: err.message, ephemeral: true };
      throw err;
    }
  }

  // --- 버튼 -------------------------------------------------------------------

  private async button(id: string): Promise<InteractionReply> {
    const [kind, target, action] = id.split(':') as [string, string, string];
    if (kind === 'ap') {
      if (action === 'revision') {
        return {
          kind: 'modal',
          customId: `apm:${target}`,
          title: '수정 요청',
          fields: [{ id: 'note', label: '고칠 내용과 PM 질문에 대한 답', style: 'paragraph', required: true }],
        };
      }
      return this.decide(target, action as ApprovalDecision);
    }
    if (kind === 'bk') {
      if (action === 'direct') {
        return { kind: 'modal', customId: `bkm:${target}`, title: `방향 지시 · ${target}`, fields: [{ id: 'note', label: '어떻게 진행할지', style: 'paragraph', required: true }] };
      }
      this.engine.ceoTicketAction(target, this.c.config.ceoDiscordId, action === 'retry' ? 'retry' : 'cancel');
      return { kind: 'update', content: `${this.ticketLine(target)}\n\n**${action === 'retry' ? '다시 시도해요' : '취소했어요'}**`, buttons: [] };
    }
    if (kind === 'push') {
      const a = this.approval(target);
      if (action === 'main' && a.kind !== 'revert') {
        // main 병합은 한 번 더 확인한다 (9장 ③)
        const ticket = this.c.db.select().from(tickets).where(eq(tickets.id, a.targetId)).get() ?? null;
        return { kind: 'update', ...mainMergeConfirm(a, approvalMessageFor(a, null, ticket).content) };
      }
      if (action === 'cancel') return this.decide(target, 'rejected');
      return this.decide(target, 'approved', action === 'feature' ? 'feature' : 'main');
    }
    if (kind === 'pushc') return action === 'merge' ? this.decide(target, 'approved', 'main') : this.decide(target, 'rejected');
    return { kind: 'reply', content: '모르는 버튼이에요', ephemeral: true };
  }

  private async modal(id: string, fields: Record<string, string>): Promise<InteractionReply> {
    const [kind, target] = id.split(':') as [string, string];
    const note = (fields.note ?? '').trim();
    if (kind === 'apm') return this.decide(target, 'revision', null, note);
    if (kind === 'bkm') {
      this.engine.ceoTicketAction(target, this.c.config.ceoDiscordId, 'direct', note);
      return { kind: 'update', content: `${this.ticketLine(target)}\n\n**방향 지시**: ${note}`, buttons: [] };
    }
    return { kind: 'reply', content: '모르는 입력창이에요', ephemeral: true };
  }

  private approval(id: string) {
    const a = this.c.db.select().from(approvals).where(eq(approvals.id, id)).get();
    if (!a) throw new OfficeError('not-found', '결재를 찾지 못했어요');
    return a;
  }

  private decide(approvalId: string, decision: ApprovalDecision, choice: string | null = null, note?: string): InteractionReply {
    const a = this.engine.decide({ approvalId, discordUserId: this.c.config.ceoDiscordId, decision, ...(choice ? { choice } : {}), ...(note ? { note } : {}) });
    const plan = a.kind === 'plan' ? (this.c.db.select().from(plans).where(eq(plans.id, a.targetId)).get() ?? null) : null;
    const ticket = this.c.db.select().from(tickets).where(eq(tickets.id, a.targetId)).get() ?? null;
    const msg = decidedMessage(approvalMessageFor(a, plan, ticket), a.status, a.choice, a.decidedAt ?? this.c.clock.now().toISOString());
    return { kind: 'update', content: msg.content, buttons: msg.buttons };
  }

  private ticketLine(id: string): string {
    const t = this.c.db.select().from(tickets).where(eq(tickets.id, id)).get();
    return t ? `**${t.id} ${t.title}**` : `**${id}**`;
  }

  // --- 슬래시 명령 -------------------------------------------------------------

  private async command(name: string, o: Record<string, string | number | undefined>, interactionId?: string): Promise<InteractionReply> {
    const c = this.c;
    const ticketArg = () => {
      const id = String(o['티켓'] ?? '').toUpperCase().trim();
      if (!TICKET_ID.test(id)) throw new OfficeError('arg', '티켓 번호를 T-12 형식으로 적어 주세요');
      const t = c.db.select().from(tickets).where(eq(tickets.id, id)).get();
      if (!t) throw new OfficeError('arg', `${id} 티켓이 없어요`);
      return t;
    };
    switch (name) {
      case '지시': {
        // 헤르메스(비서실장) 없이 CEO가 직접 지시한다. 되묻기 없이 적은 글이 그대로 지시서가 된다.
        // 상호작용 ID가 지시의 discordMessageId라, 같은 명령이 두 번 처리돼도 지시는 하나만 생긴다.
        const text = String(o['내용'] ?? '').trim();
        if (text.length < 4) throw new OfficeError('arg', '지시 내용을 조금 더 자세히 적어 주세요');
        if (!interactionId || !/^\d{17,20}$/.test(interactionId)) throw new OfficeError('arg', '지시 번호를 만들 수 없어요. 다시 시도해 주세요');
        const { order, created } = this.engine.submitOrder({ discordMessageId: interactionId, rawText: text });
        if (!created) return { kind: 'reply', content: `이미 받은 지시예요 (${order.id})`, ephemeral: true };
        return { kind: 'reply', content: `지시를 받았어요 (**${order.id}**). PM이 계획서를 만들면 결재함에 올라와요.
> ${text.slice(0, 300)}`, ephemeral: false };
      }
      case '보고': {
        const since = new Date(c.clock.now().getTime() - 24 * 3_600_000).toISOString();
        return { kind: 'reply', content: `**지금 상태** (최근 24시간)\n${formatReportData(buildReportData(c, since))}`, ephemeral: false };
      }
      case '상태': {
        const t = ticketArg();
        const recent = c.db.select().from(messages).where(eq(messages.ticketId, t.id)).all().slice(-3);
        return {
          kind: 'reply',
          ephemeral: false,
          content: [
            `**${t.id} ${t.title}** · ${t.status}${t.pauseReason ? `(${t.pauseReason})` : ''}`,
            `담당 ${t.assigneeId} · 검토 ${t.reviewerId} · 반려 ${t.reworkCount}회 · 턴 ${t.turnsUsed}/${t.turnCap} · 토큰 ${t.tokensUsed}/${t.tokenCap}`,
            `완료 조건: ${t.acceptanceCriteria.join(' / ')}`,
            ...recent.map((m) => `- ${m.fromId}: ${m.content.slice(0, 80)}`),
          ].join('\n'),
        };
      }
      case 'push':
      case '되돌리기': {
        const t = ticketArg();
        if (!t.branch) return { kind: 'reply', content: `${t.id}에는 아직 작업 브랜치가 없어요`, ephemeral: true };
        const kind = name === 'push' ? 'push' : 'revert';
        const exists = pendingApprovals(c).find((a) => a.kind === kind && a.targetId === t.id);
        if (exists) return { kind: 'reply', content: '이미 결재함에 확인 버튼이 있어요', ephemeral: true };
        if (this.gitcat) {
          // 검사(테스트 재실행 등)는 오래 걸릴 수 있어 먼저 답하고 뒤에서 돌린다. 결과는 결재함이나 #막힘에 올라간다
          void this.gitcat.preparePush(t.id, kind, `CEO /${name}`).catch((err: Error) => this.log(`푸시 준비 실패: ${err.message}`));
          return { kind: 'reply', content: 'Git 고양이가 푸시 전 검사를 시작했어요. 끝나면 결재함에 확인 버튼을 올려요', ephemeral: true };
        }
        requestApproval(c, {
          kind,
          targetId: t.id,
          reversible: kind === 'push' ? 'partial' : 'reversible',
          summary: kind === 'push' ? `${t.id} ${t.title} 푸시 (${t.branch})` : `${t.id} ${t.title} 되돌리기 (revert 커밋)`,
        });
        return { kind: 'reply', content: '결재함에 확인 버튼을 올렸어요. 버튼을 눌러야 실행돼요', ephemeral: true };
      }
      case '한도': {
        const name_ = { dev: 'Claude 개발', research: 'Claude 리서치', review: 'GPT 리뷰' } as const;
        const lines = (['dev', 'research', 'review'] as const).map((b) => {
          const s = budgetStatus(c, b);
          return `${name_[b]}: 5시간 ${s.fiveHour.used.toFixed(1)}/${s.fiveHour.limit}% · 주간 ${s.weekly.used.toFixed(1)}/${s.weekly.limit}%${s.blockedUntil ? ` · ${s.blockedUntil}까지 막힘` : ''}`;
        });
        return { kind: 'reply', content: `**몫별 사용량** (추정치)\n${lines.join('\n')}`, ephemeral: false };
      }
      case '정지': {
        const ids = this.engine.stop(c.config.ceoDiscordId);
        return { kind: 'reply', content: `모든 직원을 멈췄어요. 멈춘 티켓 ${ids.length}개. /재개로 다시 시작해요`, ephemeral: false };
      }
      case '재개': {
        const ids = this.engine.resume(c.config.ceoDiscordId);
        return { kind: 'reply', content: `다시 시작해요. 이어간 티켓 ${ids.length}개. 한도 때문에 멈춘 티켓은 한도가 다시 차면 이어가요`, ephemeral: false };
      }
      case '프로젝트': {
        if (!this.gitcat) return { kind: 'reply', content: 'Git 고양이가 연결되지 않았어요', ephemeral: true };
        const p = { id: String(o['아이디'] ?? ''), repoUrl: String(o['주소'] ?? ''), testCommand: String(o['테스트'] ?? ''), ...(o['브랜치'] ? { defaultBranch: String(o['브랜치']) } : {}) };
        void this.gitcat
          .registerAndClone(p)
          .then((m) => this.log(m))
          .catch((err: Error) => this.log(`프로젝트 등록 실패: ${err.message}`));
        return { kind: 'reply', content: `${p.id} 저장소를 받아 등록하는 중이에요`, ephemeral: false };
      }
      case '설정': {
        const key = String(o['항목'] ?? '');
        const value = o['값'];
        if (value === undefined || value === '') return { kind: 'reply', content: `${SETTINGS[key]?.label ?? key}: 바꿀 값을 적어 주세요`, ephemeral: true };
        return { kind: 'reply', content: applySetting(c, key, String(value)), ephemeral: false };
      }
      default:
        return { kind: 'reply', content: '모르는 명령이에요', ephemeral: true };
    }
  }
}

/** 슬래시 명령 정의 (bot.ts가 Discord에 등록한다) */
export const SLASH_COMMANDS: { name: string; description: string; options: { name: string; description: string; required: boolean; choices?: { name: string; value: string }[] }[] }[] = [
  { name: '지시', description: '회사에 일을 맡겨요 (PM이 계획서를 만들어 결재함에 올려요)', options: [{ name: '내용', description: '예: demo 프로젝트에 로그인 기능 추가', required: true }] },
  { name: '보고', description: '지금 상태를 바로 보고해요', options: [] },
  { name: '상태', description: '티켓 하나의 상세', options: [{ name: '티켓', description: '예: T-12', required: true }] },
  { name: 'push', description: '푸시 확인 버튼을 결재함에 올려요', options: [{ name: '티켓', description: '예: T-12', required: true }] },
  { name: '되돌리기', description: 'revert 커밋 확인 버튼을 결재함에 올려요', options: [{ name: '티켓', description: '예: T-12', required: true }] },
  { name: '한도', description: 'Claude·GPT 몫별 사용량과 남은 양', options: [] },
  {
    name: '프로젝트',
    description: '회사가 건드릴 저장소를 등록해요 (등록된 저장소만 건드려요)',
    options: [
      { name: '아이디', description: '영문 소문자 (예: todo-app)', required: true },
      { name: '주소', description: 'https://github.com/주인/저장소', required: true },
      { name: '테스트', description: '테스트 명령 (예: npm test)', required: true },
      { name: '브랜치', description: '기본 브랜치 (비우면 main)', required: false },
    ],
  },
  { name: '정지', description: '모든 직원을 즉시 멈춰요', options: [] },
  { name: '재개', description: '정지를 풀어요', options: [] },
  {
    name: '설정',
    description: '한도 비율, 보고 시각, 부재 전환 시간, 티켓 상한을 바꿔요',
    options: [
      { name: '항목', description: '바꿀 항목', required: true, choices: Object.entries(SETTINGS).map(([value, s]) => ({ name: s.label.slice(0, 100), value })) },
      { name: '값', description: '새 값', required: true },
    ],
  },
];
