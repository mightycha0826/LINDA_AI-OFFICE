// 티켓 worktree (7장 작업 폴더 격리, 11장 작업 공간). 2단계에서 만들기·정리만 한다. 커밋 정리·푸시는 4단계 Git 고양이.
// - 경로는 <wt>\T-12, 브랜치는 feature/T12-<짧은 설명>.
// - worktree에 비밀 파일(.env, 키)이 있으면 일을 시작하지 않는다.
// - 등록 저장소의 push 주소를 막아 둔다. Git 고양이는 4단계에서 주소를 직접 지정해 푸시한다.
import { eq } from 'drizzle-orm';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { emit, type Ctx } from '../context.ts';
import type { TicketRow } from '../core/tickets.ts';
import { orders, plans, tickets } from '../db/schema.ts';
import { OfficeError } from '../errors.ts';
import { applyPointSystem } from '../design/apply-point.ts';
import { DS_LINT_CRITERION } from '../design/ds-lint.ts';
import { runProcess } from '../brains/process.ts';
import { devSettings } from './claude-settings.ts';
import { assertInside, sandboxDir, worktreePathFor } from './paths.ts';
import { getProject } from './projects.ts';

/** 엔진이 쓰는 작업 공간. 테스트에서는 가짜로 바꿔 끼운다. */
export interface Workspace {
  /** 코딩 티켓의 worktree. 없으면 만든다. */
  ensureWorktree(ticket: TicketRow): Promise<{ path: string; branch: string }>;
  /** 파일 수정이 필요 없는 일의 빈 폴더 */
  sandbox(name: string): string;
  /** 리뷰어에게 넘길 변경 내용 (6장: 입력은 diff) */
  reviewDiff(ticket: TicketRow): Promise<string>;
}

export const PUSH_BLOCKED_URL = 'DISABLED-push-only-by-git-cat';

const SECRET_FILE = /(^|[\\/])(\.env(\..*)?|id_rsa[^\\/]*|id_ed25519[^\\/]*|[^\\/]*\.pem|[^\\/]*\.key|[^\\/]*\.pfx|[^\\/]*\.p12|credentials[^\\/]*\.json|\.npmrc|\.pypirc|\.netrc)$/i;
/** 예시 파일은 비밀이 아니다 */
const SECRET_EXAMPLE = /\.env\.(example|sample|template)$/i;

export class SecretInWorktreeError extends OfficeError {
  readonly files: string[];

  constructor(files: string[]) {
    super('secret-in-worktree', `worktree에 비밀로 보이는 파일이 있어 작업을 시작하지 않았어요: ${files.join(', ')}`);
    this.files = files;
  }
}

/** worktree 안의 비밀 파일 찾기. .git과 node_modules는 건너뛴다. */
export function findSecretFiles(root: string, limit = 20_000): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (++seen > limit) return;
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (SECRET_FILE.test(p) && !SECRET_EXAMPLE.test(p)) found.push(relative(root, p));
    }
  };
  walk(root);
  return found;
}

export function branchFor(ticket: Pick<TicketRow, 'id' | 'title'>): string {
  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');
  return `feature/${ticket.id.replace('-', '')}-${slug || 'work'}`;
}

async function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const r = await runProcess({ bin: 'git', args, cwd, timeoutMs });
  if (r.code !== 0) throw new OfficeError('git', `git ${args.join(' ')} 실패: ${(r.stderr || r.stdout || r.spawnError || '').trim()}`);
  return r.stdout.trim();
}

export class GitWorkspace implements Workspace {
  private readonly c: Ctx;

  constructor(c: Ctx) {
    this.c = c;
  }

  sandbox(name: string): string {
    return sandboxDir(this.c.config.paths.wt, name);
  }

  private async assertOwnWorktree(path: string, repo: string, branch: string, ticketId: string): Promise<void> {
    const commonDir = async (cwd: string) => resolve(cwd, await git(cwd, ['rev-parse', '--git-common-dir'])).toLowerCase();
    const stale = (why: string) => new OfficeError('stale-worktree', `${ticketId}: ${path} 폴더가 이미 있는데 ${why}. 남은 폴더를 치운 뒤 /재개해 주세요`);
    let mine: string, theirs: string, head: string;
    try {
      [mine, theirs, head] = await Promise.all([commonDir(repo), commonDir(path), git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])]);
    } catch {
      throw stale('git 작업 폴더가 아니에요');
    }
    if (mine !== theirs) throw stale('다른 저장소의 작업 폴더예요');
    if (head !== branch) throw stale(`브랜치가 달라요(${head}, 필요한 것 ${branch})`);
  }

  async ensureWorktree(ticket: TicketRow): Promise<{ path: string; branch: string }> {
    const c = this.c;
    if (ticket.worktreePath && ticket.branch && existsSync(ticket.worktreePath)) return { path: ticket.worktreePath, branch: ticket.branch };
    const order = c.db.select().from(orders).where(eq(orders.id, ticket.orderId)).get();
    if (!order?.projectId) throw new OfficeError('no-project', `${ticket.id}: 지시에 등록된 프로젝트가 없어요`);
    const project = getProject(c, order.projectId);
    const path = assertInside(c.config.paths.wt, worktreePathFor(c.config.paths.wt, ticket.id), `worktree(${ticket.id})`);
    const branch = ticket.branch ?? branchFor(ticket);
    mkdirSync(c.config.paths.wt, { recursive: true });

    await this.lockPushUrl(project.localPath);
    if (!existsSync(path)) {
      const exists = await git(project.localPath, ['branch', '--list', branch]);
      await git(project.localPath, exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, project.defaultBranch]);
    } else {
      // 같은 번호의 폴더가 남아 있으면(시험·예전 DB의 티켓 등) 다른 저장소나 다른 브랜치일 수 있다. 그대로 쓰면 엉뚱한 곳에 커밋한다.
      await this.assertOwnWorktree(path, project.localPath, branch, ticket.id);
    }

    const secrets = findSecretFiles(path);
    if (secrets.length > 0) throw new SecretInWorktreeError(secrets);

    // 권한 설정은 커밋되지 않게 공통 exclude에 넣는다
    mkdirSync(join(path, '.claude'), { recursive: true });
    writeFileSync(join(path, '.claude', 'settings.json'), JSON.stringify(devSettings(c.config.paths.data), null, 2), 'utf8');
    const common = resolve(path, await git(path, ['rev-parse', '--git-common-dir']));
    const exclude = join(common, 'info', 'exclude');
    mkdirSync(join(common, 'info'), { recursive: true });
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!current.split(/\r?\n/).includes('.claude/')) writeFileSync(exclude, `${current.replace(/\s*$/, '')}\n.claude/\n`, 'utf8');

    // 디자인 조합이 붙은 UI 티켓: 포인트 디자인 시스템 파일과 고른 조합을 넣어 둔다 (17장)
    const plan = ticket.planId ? c.db.select().from(plans).where(eq(plans.id, ticket.planId)).get() : undefined;
    if (plan?.designCombo && ticket.acceptanceCriteria.includes(DS_LINT_CRITERION)) applyPointSystem(path, plan.designCombo);

    c.db.update(tickets).set({ worktreePath: path, branch }).where(eq(tickets.id, ticket.id)).run();
    emit(c, 'ticket.status', { ticketId: ticket.id, from: ticket.status, to: ticket.status, event: 'worktree.created', branch });
    return { path, branch };
  }

  /** origin의 push 주소를 막아 둔다. 저장된 자격 증명이 있어도 `git push`가 나가지 않는다. */
  private async lockPushUrl(repo: string): Promise<void> {
    const remotes = (await git(repo, ['remote'])).split(/\r?\n/).filter(Boolean);
    if (!remotes.includes('origin')) return;
    await git(repo, ['config', 'remote.origin.pushurl', PUSH_BLOCKED_URL]);
  }

  async reviewDiff(ticket: TicketRow): Promise<string> {
    if (!ticket.worktreePath) return '';
    const order = this.c.db.select().from(orders).where(eq(orders.id, ticket.orderId)).get();
    const base = order?.projectId ? getProject(this.c, order.projectId).defaultBranch : 'main';
    const committed = await git(ticket.worktreePath, ['diff', '--stat', '--patch', `${base}...HEAD`]).catch((e: Error) => `(diff 실패: ${e.message})`);
    const uncommitted = await git(ticket.worktreePath, ['diff', '--patch', 'HEAD']).catch(() => '');
    const untracked = await git(ticket.worktreePath, ['ls-files', '--others', '--exclude-standard']).catch(() => '');
    const text = [committed, uncommitted && `# 커밋하지 않은 변경\n${uncommitted}`, untracked && `# 추적하지 않는 새 파일\n${untracked}`].filter(Boolean).join('\n\n');
    const max = 120_000;
    return text.length > max ? `${text.slice(0, max)}\n…(${text.length - max}자 생략)` : text;
  }

  /** 4단계 Git 고양이가 푸시를 끝낸 뒤 부른다. 브랜치는 남긴다. */
  async removeWorktree(ticket: TicketRow): Promise<void> {
    if (!ticket.worktreePath) return;
    const order = this.c.db.select().from(orders).where(eq(orders.id, ticket.orderId)).get();
    if (!order?.projectId) return;
    const project = getProject(this.c, order.projectId);
    assertInside(this.c.config.paths.wt, ticket.worktreePath, `worktree 정리(${ticket.id})`);
    await git(project.localPath, ['worktree', 'remove', '--force', ticket.worktreePath]);
    this.c.db.update(tickets).set({ worktreePath: null }).where(eq(tickets.id, ticket.id)).run();
  }
}
