// 개편 조직도 (DESIGN 2-0): 직원마다 직급과 한 줄 "하는 일". 사무실 화면의 이름표·직원 탭·상세가 이것을 쓴다.
// 부서는 seed.ts(STANDING_STAFF)와 staff/assistants.ts가 정하고, 여기서는 팀장·팀원·보조만 나눈다.
import type { StaffRank } from '@ai-office/shared';
import { ASSISTANT_IDS } from './assistants.ts';

/** 2-0 표에서 굵게 쓴 팀장 */
export const TEAM_LEADS = ['chief-of-staff', 'pm', 'developer', 'reviewer', 'strategy', 'marketing'] as const;

/** 상시 직원의 한 줄 "하는 일" (2-0 표의 하는 일 칸) */
const JOBS: Record<string, string> = {
  'chief-of-staff': 'Discord 대화, 지시 등록, 정기 보고',
  pm: '지시 분류, 계획서, 티켓 배정, 토큰 예상',
  developer: '설계 결정, 어려운 티켓 구현, GPT 개발자 코드 최종 리뷰',
  'dev-a': '일반 티켓 구현과 테스트 (작업 공간 안에서만)',
  'dev-b': '일반 티켓 구현과 테스트 (작업 공간 안에서만)',
  reviewer: '코드 리뷰, 보안 감사, 계획서·보고 관문',
  'qa-local': '문서 1차 점검(맞춤법·말투·필수 항목), 문서 검토',
  strategy: '시장·경쟁 조사, 분석 보고서',
  marketing: '문구, 홍보 자료, 웹사이트 원고',
  'git-cat': '커밋·푸시·main 병합. CEO 버튼으로만',
};

/** 보조 직원의 한 줄 "하는 일" */
const ASSISTANT_JOBS: Record<string, string> = {
  explainer: '#막힘 알림을 2~3줄로 풀어 설명',
  'diff-summarizer': '푸시 결재 전 바뀐 코드를 5줄로 요약',
  interpreter: '직원끼리 주고받은 JSON을 문장으로',
  'commit-scribe': '커밋 메시지 초안',
  'retro-scribe': '티켓·주간 회고 초안',
  briefer: '비서실장 보고가 빠졌을 때 보고 초안',
  drafter: '글쓰기·마케팅 티켓의 초안',
};

/** 캐릭터 이름 (2026-10-21 CEO 지정). 직함(displayName)은 그대로 두고 화면 이름표·대화에만 쓴다. 기준 그림은 assets/sources/<ID>-portrait.webp */
export const PERSON_NAMES: Record<string, string> = {
  'dev-a': '한주아',
  'dev-b': '한서윤',
  strategy: '서예린',
  'qa-local': '백예원',
  reviewer: '차은설',
};

/** 캐릭터 이름. 아직 없으면 null */
export function personNameOf(id: string): string | null {
  return PERSON_NAMES[id] ?? null;
}

export function rankOf(id: string, isTemporary: boolean): StaffRank {
  if (isTemporary) return 'temp';
  if ((TEAM_LEADS as readonly string[]).includes(id)) return 'lead';
  return ASSISTANT_IDS.includes(id) ? 'assistant' : 'member';
}

/** 화면에 보일 한 줄. 모르는 직원(임시 직원 등)은 빈 문자열 */
export function jobOf(id: string): string {
  return JOBS[id] ?? ASSISTANT_JOBS[id] ?? '';
}
