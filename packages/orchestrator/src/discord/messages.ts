// Discord 메시지 형식 (9장 ①~⑦). 말투는 포인트 디자인 시스템의 해요체(17장).
import type { ApprovalRow } from '../core/approvals.ts';
import type { PlanRow } from '../core/plans.ts';
import type { TicketRow } from '../core/tickets.ts';
import type { MinutesRow } from '../core/meeting.ts';
import type { Button } from './types.ts';

const REVERSIBLE: Record<string, string> = { reversible: '되돌릴 수 있어요', partial: '일부만 되돌릴 수 있어요', irreversible: '되돌릴 수 없어요' };

export const approvalButtonId = (id: string, decision: 'approved' | 'revision' | 'rejected') => `ap:${id}:${decision}`;

/** ① 계획 승인 요청 */
export function planApprovalMessage(plan: PlanRow, a: ApprovalRow): { content: string; buttons: Button[][] } {
  const g = plan.gateResult;
  const lines = [
    `**계획서 #${plan.id} · v${plan.version} — ${plan.goal}**`,
    '',
    '**티켓과 담당자**',
    ...plan.tickets.map((t, i) => `${i + 1}. ${t.title} (${t.type}) · 담당 ${t.assignee} · 검토 ${t.reviewer}${t.needsCeoApproval ? ' · CEO 결재 필요' : ''}\n   완료 조건: ${t.acceptanceCriteria.join(' / ')}`),
    ...(plan.tempStaff.length ? ['', `**임시 직원**: ${plan.tempStaff.map((s) => `${s.key}(${s.kind}${s.brain ? `, ${s.brain}` : ''}) — ${s.reason}`).join(' · ')}`] : []),
    ...(plan.designCombo ? ['', `**디자인 조합**: ${plan.designCombo.combo} (${plan.designCombo.mode}) — ${plan.designCombo.reason}`] : []),
    '',
    `**예상 사용량**: Claude 개발 몫 ${plan.estimate.claudeDevPct}%, 리서치 몫 ${plan.estimate.claudeResearchPct}%, GPT ${plan.estimate.gptPct}% · 약 ${plan.estimate.hours}시간`,
    ...(plan.questions.length ? ['', '**PM 질문**', ...plan.questions.map((q) => `- ${q}`)] : []),
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

/** ③ 푸시 확인 (Git 고양이). 푸시 전 검사 결과는 4단계에서 채운다 */
export function pushApprovalMessage(a: ApprovalRow, ticket: TicketRow | null, checks: string[] = []): { content: string; buttons: Button[][] } {
  const branch = ticket?.branch ?? 'feature/…';
  const isRevert = a.kind === 'revert';
  const lines = [
    `**🐈 ${isRevert ? '되돌리기 확인' : '푸시 확인'} · ${ticket ? `${ticket.id} ${ticket.title}` : a.targetId}**`,
    a.summary,
    ...(checks.length ? checks : ['푸시 전 검사(테스트 재실행, 비밀 정보 검사)는 Git 고양이가 실행 직전에 해요.']),
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

/** ④ 막힘 */
export function blockedMessage(ticket: TicketRow, minutes: MinutesRow | null): { content: string; buttons: Button[][] } {
  const lines = [`**막힘 · ${ticket.id} ${ticket.title}**`, `반려 ${ticket.reworkCount}회 · 완료 조건: ${ticket.acceptanceCriteria.join(' / ')}`];
  if (minutes) {
    lines.push('', `**회의 결론**: ${minutes.outcome === 'agreed' ? '합의' : '불합의'}`);
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
    `**회의록 · ${m.kind === 'gate-review' ? 'GPT 관문' : '티켓 회의'} · ${m.outcome === 'agreed' ? '합의' : '불합의'}**`,
    `참석: ${m.participants.join(', ')}`,
    ...m.agenda.map((a) => `안건: ${a.criterion} — ${a.reason} (${a.reasonCategory})`),
    ...m.rounds.map((r) => `${r.round}라운드: ${r.positions.map((p) => `${p.employeeId} "${p.claim}"`).join(' / ')}`),
    `다음 할 일: ${m.nextActions.join(', ') || '없음'}`,
  ].join('\n');
}
