// 커밋 메시지 (11장). Qwen은 초안(종류·범위·요약)만 쓰고, 형식은 코드가 강제한다.
//
//   feat(auth): 로그인 기능 추가 (T-12)
//
//   완료 조건:
//   - 로그인 테스트 통과
//
//   리뷰: Codex 통과 (반려 1회)
//   AI-Office-Ticket: T-12
import { z } from 'zod';

export const CommitDraftSchema = z.object({
  type: z.enum(['feat', 'fix', 'docs', 'refactor', 'test', 'chore']),
  scope: z.string().regex(/^[a-z0-9-]{1,20}$/, '영문 소문자·숫자·- 20자 이내'),
  subject: z.string().trim().min(1).max(50),
});
export type CommitDraft = z.infer<typeof CommitDraftSchema>;

export interface CommitTicketInfo {
  id: string;
  title: string;
  acceptanceCriteria: string[];
  reworkCount: number;
  reviewPassed: boolean;
  reviewerName: string;
}

/** 초안이 없거나 틀렸을 때 쓰는 기본값 */
export function fallbackDraft(t: Pick<CommitTicketInfo, 'title'>): CommitDraft {
  return { type: 'chore', scope: 'ticket', subject: t.title.slice(0, 50) };
}

export const TRAILER = 'AI-Office-Ticket';

export function formatCommitMessage(t: CommitTicketInfo, draft: CommitDraft | null): string {
  const d = draft && CommitDraftSchema.safeParse(draft).success ? draft : fallbackDraft(t);
  // 요약 줄에서 줄바꿈과 다른 티켓 표시를 지운다 (형식 강제)
  const subject = d.subject.replace(/[\r\n]+/g, ' ').replace(/\(T-\d+\)/g, '').trim();
  return [
    `${d.type}(${d.scope}): ${subject} (${t.id})`,
    '',
    '완료 조건:',
    ...t.acceptanceCriteria.map((c) => `- ${c.replace(/[\r\n]+/g, ' ')}`),
    '',
    `리뷰: ${t.reviewerName} ${t.reviewPassed ? '통과' : '통과 전 (CEO가 경고를 보고 진행)'}${t.reworkCount ? ` (반려 ${t.reworkCount}회)` : ''}`,
    `${TRAILER}: ${t.id}`,
    '',
  ].join('\n');
}
