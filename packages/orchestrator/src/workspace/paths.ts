// 작업 폴더 격리 (7장). AI 직원은 paths.wt 아래에서만 일한다.
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { OfficeError } from '../errors.ts';

/** dir이 root 안(같거나 하위)인지. 상대 경로 탈출(..)과 다른 드라이브를 막는다. */
export function isInside(root: string, dir: string): boolean {
  const rel = relative(resolve(root), resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function assertInside(root: string, dir: string | undefined, what: string): string {
  if (!dir) throw new OfficeError('workdir', `${what}: 작업 폴더가 없어요`);
  const abs = resolve(dir);
  if (!isInside(root, abs) || resolve(root) === abs) {
    throw new OfficeError('workdir', `${what}: 작업 공간(${root}) 밖에서는 실행하지 않아요: ${abs}`);
  }
  return abs;
}

/** 티켓 worktree 경로: <wt>\T-12 */
export function worktreePathFor(wtRoot: string, ticketId: string): string {
  if (!/^T-\d+$/.test(ticketId)) throw new OfficeError('workdir', `티켓 번호 형식이 아니에요: ${ticketId}`);
  return join(wtRoot, ticketId);
}

/** 프로젝트 통합 브랜치 (11장, 2026-10-23): 끝난 티켓을 로컬에서 차례로 합쳐 두고, 새 티켓은 여기서 시작한다 */
export const integrationBranch = (projectId: string) => `integration/${projectId}`;

/** 통합 브랜치 작업 폴더: <wt>\_integration\<프로젝트>. 병합 담당(개발팀장)이 충돌을 푸는 곳 */
export function integrationPathFor(wtRoot: string, projectId: string): string {
  return join(wtRoot, '_integration', projectId);
}

/** 파일 수정이 필요 없는 일(리서치, 관문, 문서 작업)의 빈 폴더: <wt>\_sandbox\<이름> */
export function sandboxDir(wtRoot: string, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, '_');
  const dir = join(wtRoot, '_sandbox', safe);
  mkdirSync(dir, { recursive: true });
  return dir;
}
