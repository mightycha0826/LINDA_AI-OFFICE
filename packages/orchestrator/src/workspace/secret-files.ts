// 비밀 파일 읽기 막기 (7장 "비밀 파일 읽기", 2026-10-19).
// - Codex 샌드박스 명령은 별도 Windows 계정(CodexSandboxOffline/Online, 그룹 CodexSandboxUsers)으로 돈다.
//   그래서 비밀 파일에 이 그룹의 읽기 거부(DENY) 권한을 걸면 주인 계정(오케스트레이터)은 그대로 읽고 Codex만 못 읽는다.
//   권한 변경은 주인이 scripts\protect-secrets.ps1로 직접 한다(되돌리기: unprotect-secrets.ps1).
// - Claude Code는 주인 계정으로 돌아 Windows 권한으로 막을 수 없다. 파일 도구(Read·Grep·Glob·Edit·Write)는
//   데이터 폴더 거부 규칙으로, Bash는 경로가 보이는 명령만 거부 규칙으로 막는다(우회 가능, 7장 한계 참고).
import { join } from 'node:path';

/** 막을 비밀 파일 (paths.data 기준). 봇 토큰, GitHub 토큰, 내부 API 토큰 */
export const SECRET_FILES: readonly string[] = ['secrets.json'];
/** 막기 확인용 가짜 파일. 진짜 비밀 대신 이걸로 시험한다(sim/secrets-read-check.ts) */
export const SECRETS_CANARY = 'secrets.canary.json';
/** Codex Windows 샌드박스(elevated)가 만드는 그룹. 0.163.0에서 확인 */
export const CODEX_SANDBOX_GROUP = 'CodexSandboxUsers';

export function secretPaths(dataDir: string): string[] {
  return [...SECRET_FILES, SECRETS_CANARY].map((f) => join(dataDir, f));
}

/**
 * Claude Code 권한 규칙의 절대 경로 꼴. Windows 경로는 POSIX 꼴로 바꿔 맞춘다:
 * C:\ai-office\data → //c/ai-office/data (앞의 //가 파일 시스템 루트라는 뜻)
 */
export function claudeAbsPattern(p: string): string {
  const posix = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const m = /^([A-Za-z]):(\/.*)?$/.exec(posix);
  if (m) return `//${m[1]!.toLowerCase()}${m[2] ?? ''}`;
  return posix.startsWith('/') ? `/${posix}` : `//${posix}`;
}

/** Bash 명령 문자열에 이 경로가 보이면 거부. 드라이브 글자·구분자 모양을 몇 가지 덮는다 */
function bashPathForms(p: string): string[] {
  const noDrive = p.replace(/^[A-Za-z]:/, '').replace(/[\\/]+$/, '');
  const back = noDrive.replace(/\//g, '\\');
  const fwd = noDrive.replace(/\\/g, '/');
  return [...new Set([back, fwd])];
}

/**
 * 데이터 폴더(비밀 파일, 회사 DB, Codex 로그인 정보, 다른 직원의 실행 파일)를 Claude가 읽지 못하게 하는 거부 규칙.
 * 파일 도구는 확실히 막힌다. Bash 규칙은 경로·파일 이름이 명령에 그대로 보일 때만 막는다(문자열 맞추기라 우회할 수 있다).
 */
export function claudeDataDenyRules(dataDir: string): string[] {
  const abs = claudeAbsPattern(dataDir);
  const fileTools = ['Read', 'Edit', 'Write'].map((t) => `${t}(${abs}/**)`);
  const bash = [...bashPathForms(dataDir), ...SECRET_FILES].map((s) => `Bash(*${s}*)`);
  return [...fileTools, ...bash];
}
