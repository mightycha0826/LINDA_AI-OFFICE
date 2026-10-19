// Claude Code 권한 설정 (6장 개발자, 7장, 11장).
// 같은 설정을 두 곳에 둔다: worktree의 .claude/settings.json, 그리고 worktree 밖(paths.data)의 파일을 --settings로.
// AI가 worktree 안 설정 파일을 고쳐도 밖의 설정이 그대로 적용된다. 거부 규칙은 어느 출처에서 와도 우선한다.
// 데이터 폴더(비밀 파일·회사 DB) 읽기 거부는 폴더 위치를 알아야 해서 dataDir를 받을 때 붙는다 (7장 비밀 파일 읽기).
import { claudeDataDenyRules } from './secret-files.ts';

/** 모든 Claude 실행에 거는 거부 규칙 */
export const CLAUDE_DENY: readonly string[] = [
  // 푸시와 원격 저장소 조작은 Git 고양이만 (11장)
  'Bash(git push)',
  'Bash(git push *)',
  'Bash(git remote *)',
  'Bash(git config *)',
  'Bash(git -c *)',
  'Bash(git credential *)',
  'Bash(git worktree *)',
  'Bash(gh *)',
  // 자기 권한 설정을 고치지 못하게
  'Edit(.claude/**)',
  'Write(.claude/**)',
  // 비밀 파일은 읽지 않는다 (worktree에는 원래 없어야 한다)
  'Read(**/.env)',
  'Read(**/.env.*)',
];

/** 모든 Claude 실행의 거부 규칙 (공통 + 데이터 폴더) */
export function claudeDeny(dataDir: string): string[] {
  return [...CLAUDE_DENY, ...claudeDataDenyRules(dataDir)];
}

/** 개발자: worktree 안에서 파일 수정과 명령 실행 (7장 권한 분리 표) */
export function devSettings(dataDir: string): object {
  return {
    permissions: {
      allow: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'],
      deny: claudeDeny(dataDir),
    },
  };
}

/** 읽기 전용: 회의 발언 등. 리서치는 도구 목록 자체를 검색·읽기로 줄인다 (15장) */
export function readonlySettings(dataDir: string): object {
  return {
    permissions: {
      allow: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      deny: [...claudeDeny(dataDir), 'Bash', 'Edit', 'Write'],
    },
  };
}
