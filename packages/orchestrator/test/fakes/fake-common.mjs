// 가짜 CLI 공통: 실행 기록, 프롬프트에서 완료 조건 읽기, 스키마 모양에 맞는 출력 만들기.
import { appendFileSync, readFileSync } from 'node:fs';

export function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function log(entry) {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + '\n', 'utf8');
}

export function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** 프롬프트의 "### 완료 조건" 아래 번호 목록 */
export function criteriaFrom(prompt) {
  const at = prompt.indexOf('### 완료 조건');
  if (at < 0) return [];
  const out = [];
  for (const line of prompt.slice(at).split(/\r?\n/).slice(1)) {
    const m = /^\d+\. (.+)$/.exec(line.trim());
    if (m) out.push(m[1]);
    else if (out.length && line.trim().startsWith('#')) break;
  }
  return out;
}

/** 스키마의 속성 이름으로 어떤 출력인지 알아내 그럴듯한 값을 만든다. */
export function outputFor(schema, prompt) {
  if (process.env.FAKE_OUTPUT) return JSON.parse(process.env.FAKE_OUTPUT);
  const props = Object.keys(schema?.properties ?? {});
  if (props.includes('verdict')) {
    return { verdict: 'pass', criteria: criteriaFrom(prompt).map((criterion) => ({ criterion, pass: true })), fixRequests: [] };
  }
  if (props.includes('passed')) return { passed: true, issues: [], objection: null };
  // 계획서 (7-1부터 PM은 Claude)
  if (props.includes('goal') && props.includes('tickets')) {
    return {
      goal: '기능 파일 추가',
      questions: [],
      tickets: [{ title: 'feature file', type: 'coding', assignee: process.env.FAKE_PLAN_ASSIGNEE ?? 'developer', reviewer: 'reviewer', acceptanceCriteria: ['check.js 테스트 통과'], needsCeoApproval: false, estimatedTokens: 50000 }],
      tempStaff: [],
      estimate: { claudeDevPct: 5, claudeResearchPct: 1, gptPct: 3, hours: 1 },
      projectId: 'demo',
    };
  }
  if (props.includes('agree')) return { claim: '완료 조건대로 하면 된다', agree: true, nextActions: [] };
  if (props.includes('changedFiles')) {
    return { summary: '기능 구현', changedFiles: ['feature.txt'], criteriaSelfCheck: criteriaFrom(prompt).map((criterion) => ({ criterion, claimed: true })) };
  }
  if (props.includes('document')) return { document: '# 초안', claims: [] };
  return {};
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
