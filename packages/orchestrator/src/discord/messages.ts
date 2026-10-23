// Discord 메시지 형식 (9장 ①~⑦). 말투는 포인트 디자인 시스템의 해요체(17장).
import { CEO_NEED_LABEL, MEETING_OUTCOME_LABEL } from '@ai-office/shared';
import type { ApprovalRow } from '../core/approvals.ts';
import type { DirectProposal } from '../core/direct.ts';
import type { PlanRow } from '../core/plans.ts';
import type { TicketRow } from '../core/tickets.ts';
import { ceoRequestsOf, type MinutesRow } from '../core/meeting.ts';
import { maxFailStreak, SAME_CRITERION_LIMIT, SAME_FAIL_LIMIT } from '../core/transitions.ts';
import type { Button } from './types.ts';
import type { OrderRow } from '../core/orders.ts';
import type { Clarification } from '../core/clarifications.ts';

const REVERSIBLE: Record<string, string> = { reversible: '되돌릴 수 있어요', partial: '일부만 되돌릴 수 있어요', irreversible: '되돌릴 수 없어요' };

export const approvalButtonId = (id: string, decision: 'approved' | 'revision' | 'rejected') => `ap:${id}:${decision}`;

export function clarificationMessage(order: OrderRow, state: Clarification): { content: string; buttons: Button[][] } {
  return {
    content: [
      `**PM 확인 질문 · ${order.projectId ? `[${order.projectId}] ` : ''}${order.id}**`,
      '',
      `요청: ${order.rawText.slice(0, 300)}`,
      '',
      ...state.rounds.at(-1)!.questions.map((q, i) => `${i + 1}. ${q}`),
      '',
      '이 답장에 번호별로 답해 주시겠어요? **답변하기** 버튼을 쓰셔도 괜찮아요. 더 필요한 내용은 이어서 여쭙고, 충분히 이해하면 계획서로 정리할게요.',
    ].join('\n'),
    buttons: [[{ id: `cq:${order.id}:${state.rounds.length}`, label: '답변하기', style: 'primary' }]],
  };
}

/** ① 계획 승인 요청 */
export function planApprovalMessage(plan: PlanRow, a: ApprovalRow): { content: string; buttons: Button[][] } {
  const g = plan.gateResult;
  const lines = [
    `**${plan.projectId ? `[${plan.projectId}] ` : ''}계획서 #${plan.id} · v${plan.version} — ${plan.goal}**`,
    '',
    '**티켓과 담당자**',
    ...plan.tickets.map((t, i) => `${i + 1}. **${t.title}** (${t.type})\n   담당: ${t.assignee} · 검토: ${t.reviewer}${t.needsCeoApproval ? ' · CEO 결재 필요' : ''}\n   완료 조건:\n${t.acceptanceCriteria.map((criterion) => `   - ${criterion}`).join('\n')}\n`),
    ...(plan.reviewerChanges.length ? ['', '**검토자 자동 변경** (같은 모델끼리는 검토하지 않아요)', ...plan.reviewerChanges.map((x) => `- ${x}`)] : []),
    ...(plan.tempStaff.length ? ['', `**임시 직원**: ${plan.tempStaff.map((s) => `${s.key}(${s.kind}${s.brain ? `, ${s.brain}` : ''}) — ${s.reason}`).join(' · ')}`] : []),
    ...(plan.designCombo ? ['', `**디자인 조합**: ${plan.designCombo.combo} (${plan.designCombo.mode}) — ${plan.designCombo.reason}`] : []),
    '',
    `**예상 사용량**: Claude 개발 몫 ${plan.estimate.claudeDevPct}%, 리서치 몫 ${plan.estimate.claudeResearchPct}%, GPT ${plan.estimate.gptPct}% · 약 ${plan.estimate.hours}시간`,
    '',
    `**GPT 관문**: ${g?.passed ? '통과' : `반대 의견 — ${g?.objection ?? g?.issues.join(' / ') ?? '없음'}`}`,
    `되돌리기: ${REVERSIBLE[a.reversible]}`,
  ];
  return {
    content: lines.join('\n'),
    buttons: [
      [
        { id: approvalButtonId(a.id, 'approved'), label: '승인', style: 'success' },
        { id: approvalButtonId(a.id, 'revision'), label: '수정 요청', style: 'primary' },
        { id: approvalButtonId(a.id, 'rejected'), label: '반려', style: 'danger' },
      ],
    ],
  };
}

/** ② CEO 결재 (배포·삭제·외부 전송·예산), ⑤ 규칙 추가 제안 */
export function ceoApprovalMessage(a: ApprovalRow, ticket: TicketRow | null): { content: string; buttons: Button[][] } {
  const isRule = a.kind === 'rule';
  // 규칙 삭제 제안(효과 없음, 10개 초과)은 승인·반려만. 수정은 새 후보로 올린다
  const isRetire = isRule && a.summary.startsWith('규칙 삭제 제안');
  const lines = [
    `**${isRetire ? '규칙 삭제 제안' : isRule ? '규칙 추가 제안' : 'CEO 결재'} · ${a.kind}**`,
    a.summary,
    ...(ticket ? [`티켓: ${ticket.id} ${ticket.title} · 완료 조건 ${ticket.acceptanceCriteria.join(' / ')}`] : []),
    `되돌리기: ${REVERSIBLE[a.reversible]}`,
  ];
  const row: Button[] = [{ id: approvalButtonId(a.id, 'approved'), label: '승인', style: 'success' }];
  if (isRule && !isRetire) row.push({ id: approvalButtonId(a.id, 'revision'), label: '수정', style: 'primary' });
  row.push({ id: approvalButtonId(a.id, 'rejected'), label: '반려', style: 'danger' });
  return { content: lines.join('\n'), buttons: [row] };
}

/** ③ 푸시 확인 (Git 고양이) */
export function pushApprovalMessage(a: ApprovalRow, ticket: TicketRow | null): { content: string; buttons: Button[][] } {
  const branch = ticket?.branch ?? 'feature/…';
  const isRevert = a.kind === 'revert';
  const lines = [
    `**🐈 ${isRevert ? '되돌리기 확인' : '푸시 확인'} · ${ticket ? `${ticket.id} ${ticket.title}` : a.targetId}**`,
    a.summary,
    '푸시 전 검사(테스트 재실행, 비밀 정보 검사)는 Git 고양이가 실행 직전에 해요.',
    `되돌리기: ${REVERSIBLE[a.reversible]}`,
  ];
  const buttons: Button[] = isRevert
    ? [
        { id: `push:${a.id}:main`, label: 'main에 되돌리기 커밋', style: 'danger' },
        { id: `push:${a.id}:cancel`, label: '취소', style: 'secondary' },
      ]
    : [
        { id: `push:${a.id}:feature`, label: branch, style: 'primary' },
        { id: `push:${a.id}:main`, label: 'main', style: 'danger' },
        { id: `push:${a.id}:cancel`, label: '취소', style: 'secondary' },
      ];
  return { content: lines.join('\n'), buttons: [buttons] };
}

/** ③ main을 누르면 한 번 더 확인 */
export function mainMergeConfirm(a: ApprovalRow, original: string): { content: string; buttons: Button[][] } {
  return {
    content: `${original}\n\n**main에 바로 병합합니다. 계속할까요?**`,
    buttons: [
      [
        { id: `pushc:${a.id}:merge`, label: '병합', style: 'danger' },
        { id: `pushc:${a.id}:cancel`, label: '취소', style: 'secondary' },
      ],
    ],
  };
}

/**
 * ④ 막힘. event는 막힘으로 보낸 전환 이벤트다. 같은 반려 반복이나 회의의 사장님 판단 요청이면 맨 위에 이유를 붙인다 (2026-10-23).
 */
export function blockedMessage(ticket: TicketRow, minutes: MinutesRow | null, event?: string): { content: string; buttons: Button[][] } {
  const lines = [`**막힘 · ${ticket.id} ${ticket.title}**`];
  const topStreak = maxFailStreak(ticket.failStreaks);
  if ((event === 'review.failed' || event === 'guard.repeat') && ticket.sameFailCount < SAME_FAIL_LIMIT && topStreak >= SAME_CRITERION_LIMIT) {
    // 묶음은 바뀌었지만 같은 조건이 계속 반려된 경우 (2026-10-23 보강)
    const stuck = Object.entries(ticket.failStreaks ?? {}).filter(([, n]) => n >= SAME_CRITERION_LIMIT).sort((a, b) => b[1] - a[1]);
    lines.push(`**막힌 이유**: 같은 완료 조건이 ${topStreak}번 연속 반려됐어요 (다른 조건은 반려와 통과를 오감)`, ...stuck.map(([x, n]) => `- ${x} (${n}번)`));
  } else if (event === 'review.failed' || event === 'guard.repeat') {
    lines.push(`**막힌 이유**: 같은 완료 조건이 ${ticket.sameFailCount}번 연속 반려됐어요`, ...(ticket.lastFailedCriteria ?? []).map((x) => `- ${x}`));
  }
  if (event === 'meeting.escalated' && minutes) {
    lines.push('**막힌 이유**: 회의에서 사장님 판단을 요청했어요', ...ceoRequestsOf(minutes).map((r) => `- [${CEO_NEED_LABEL[r.kind]}] ${r.employeeId}: ${r.question}`));
  }
  lines.push(`반려 ${ticket.reworkCount}회 · 완료 조건: ${ticket.acceptanceCriteria.join(' / ')}`);
  if (minutes) {
    lines.push('', `**회의 결론**: ${MEETING_OUTCOME_LABEL[minutes.outcome]}`);
    for (const r of minutes.rounds) lines.push(`${r.round}라운드 — ${r.positions.map((p) => `${p.employeeId}: ${p.claim}`).join(' / ')}`);
    if (minutes.agenda.length) lines.push(`안건: ${minutes.agenda.map((x) => `${x.criterion}(${x.reason})`).join(' / ')}`);
  }
  return {
    content: lines.join('\n'),
    buttons: [
      [
        { id: `bk:${ticket.id}:retry`, label: '다시 시도', style: 'primary' },
        { id: `bk:${ticket.id}:direct`, label: '방향 지시', style: 'secondary' },
        { id: `bk:${ticket.id}:cancel`, label: '취소', style: 'danger' },
      ],
    ],
  };
}

/** 계획 작성이 멈춘 지시 (#막힘). PM이 형식·규칙 위반을 두 번 했을 때 (6장) */
export function blockedPlanMessage(order: { id: string; rawText: string; projectId: string | null }, issues: string): { content: string; buttons: Button[][] } {
  const lines = [
    `**계획 작성 멈춤 · ${order.projectId ? `[${order.projectId}] ` : ''}${order.id}**`,
    `> ${order.rawText.slice(0, 200)}`,
    'PM이 규칙에 맞는 계획서를 두 번 쓰지 못했어요:',
    ...issues
      .split('\n')
      .filter(Boolean)
      .slice(0, 8)
      .map((x) => `- ${x.slice(0, 300)}`),
  ];
  return {
    content: lines.join('\n'),
    buttons: [
      [
        { id: `pb:${order.id}:retry`, label: '다시 시도', style: 'primary' },
        { id: `pb:${order.id}:cancel`, label: '취소', style: 'danger' },
      ],
    ],
  };
}

const DECISION_NAME: Record<string, string> = { approved: '승인됨', rejected: '반려됨', revision: '수정 요청됨', expired: '새 버전이 올라와 닫혔어요' };

/** 결정된 결재: 원래 내용 + 결과, 버튼은 모두 비활성 */
export function decidedMessage(original: { content: string; buttons: Button[][] }, status: string, choice: string | null, at: string): { content: string; buttons: Button[][] } {
  return {
    content: `${original.content}\n\n**${DECISION_NAME[status] ?? status}**${choice ? ` · ${choice}` : ''} · ${at.slice(0, 16).replace('T', ' ')}`,
    buttons: original.buttons.map((row) => row.map((b) => ({ ...b, disabled: true }))),
  };
}

/** 결재 메시지 다시 만들기 (결정 뒤 수정할 때 원래 모양이 필요하다) */
export function approvalMessageFor(a: ApprovalRow, plan: PlanRow | null, ticket: TicketRow | null): { content: string; buttons: Button[][] } {
  if (a.kind === 'plan' && plan) return planApprovalMessage(plan, a);
  if (a.kind === 'push' || a.kind === 'main-merge' || a.kind === 'revert') return pushApprovalMessage(a, ticket);
  return ceoApprovalMessage(a, ticket);
}

/** ⑦ 거울 메시지 길이 줄이기: 앞부분 + 화면 링크 */
export function clip(text: string, max: number, screenUrl: string, ticketId: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…${screenUrl ? ` (전체: ${screenUrl.replace(/\/$/, '')}/#ticket=${ticketId})` : ''}`;
}

/** ⑦ 회의록을 스레드 끝에 올리는 형식 */
export function minutesText(m: MinutesRow): string {
  return [
    `**회의록 · ${m.kind === 'gate-review' ? 'GPT 관문' : '티켓 회의'} · ${MEETING_OUTCOME_LABEL[m.outcome]}**`,
    `참석: ${m.participants.join(', ')}`,
    ...m.agenda.map((a) => `안건: ${a.criterion} — ${a.reason} (${a.reasonCategory})`),
    ...m.rounds.map((r) => `${r.round}라운드: ${r.positions.map((p) => `${p.employeeId} "${p.claim}"`).join(' / ')}`),
    ...ceoRequestsOf(m).map((r) => `사장님 판단 요청 [${CEO_NEED_LABEL[r.kind]}] ${r.employeeId}: ${r.question}`),
    `다음 할 일: ${m.nextActions.join(', ') || '없음'}`,
  ].join('\n');
}

/** 직원이 자기 답장에 함께 붙이는 작업·수정 범위와 확인 질문. */
export function proposalMessage(p: DirectProposal, _name: string): { content: string; buttons: Button[][] } {
  if (p.kind === 'order') {
    return {
      content: [
        `**이렇게 진행할까요?** · ${p.title}`,
        '',
        p.rawText,
        '',
        '**마무리할 때 확인할 내용**',
        ...p.criteria.map((x, i) => `${i + 1}. ${x}`),
        '',
        '이 내용으로 제가 맡아서 진행할까요? 이 답장에 “응, 진행해”라고 말씀해 주세요. 더 이야기하거나 내용을 고쳐도 괜찮아요.',
      ].join('\n'),
      buttons: [
        [
          { id: `dp:${p.id}:start`, label: '맡기고 시작', style: 'success' },
          { id: `dp:${p.id}:chat`, label: '그냥 대화', style: 'secondary' },
        ],
      ],
    };
  }
  return {
    content: [`**이렇게 수정할까요?** · ${p.ticketId}`, '', p.note, '', '이 내용으로 바꿀까요? 이 답장에 “응, 반영해”라고 말씀해 주세요.'].join('\n'),
    buttons: [
      [
        { id: `rv:${p.id}:apply`, label: '수정 반영', style: 'primary' },
        { id: `rv:${p.id}:chat`, label: '그냥 대화', style: 'secondary' },
      ],
    ],
  };
}
