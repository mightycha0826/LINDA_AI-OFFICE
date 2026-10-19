// Git 고양이 (11장). AI가 아니라 정해진 순서대로 git 명령을 실행하는 코드다.
// - 푸시는 CEO가 결재함 버튼을 눌러야만 한다. 이 파일은 결정된 결재(approval.decided)를 보고 실행한다.
// - 강제 푸시는 없다. 이 파일에는 --force도, 강제 갱신 refspec도 없다(테스트가 확인한다).
// - 푸시 주소는 등록된 저장소(projects.repoUrl)뿐이다. AI 출력이나 티켓 내용에서 주소를 받지 않는다.
// - GitHub 토큰은 푸시·fetch를 하는 git 프로세스에만, 그 순간 환경 변수로 넣는다. AI 직원 프로세스에는 없다.
// - 푸시 전 검사: 비밀 정보·큰 파일은 차단, 리뷰·테스트는 경고 (checks.ts).
// - 실패해도 티켓 상태는 바꾸지 않는다(done은 끝난 상태). #막힘에 알리고 CEO가 다시 /push 한다 (4단계 결정 K).
import { eq, gt } from 'drizzle-orm';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestRunner } from '../brains/brain.ts';
import { runProcess, type RunOptions, type RunResult } from '../brains/process.ts';
import { emit, getState, newId, setState, type Ctx } from '../context.ts';
import { requestApproval, type ApprovalRow } from '../core/approvals.ts';
import { approvals, employees, events, messages, orders, tickets } from '../db/schema.ts';
import { OfficeError } from '../errors.ts';
import { getProject, registerProject, validateProject, type ProjectRow } from '../workspace/projects.ts';
import { assertInside } from '../workspace/paths.ts';
import type { TicketRow } from '../core/tickets.ts';
import { largeFiles, secretScan, summarizeChecks, type CheckResult, type Runner } from './checks.ts';
import { formatCommitMessage, TRAILER, type CommitDraft, type CommitTicketInfo } from './commit-message.ts';
import { createGithubRepo, type CreatedRepo } from './github-repo.ts';

export interface GitCatDeps {
  c: Ctx;
  tests: TestRunner;
  /** 푸시가 끝난 worktree 정리 (GitWorkspace.removeWorktree) */
  removeWorktree?: (t: TicketRow) => Promise<void>;
  /** Qwen 커밋 메시지 초안 (Engine.draftCommit). 없거나 실패하면 기본 형식 */
  drafter?: (info: CommitTicketInfo, diffStat: string) => Promise<CommitDraft | null>;
  /** 푸시하는 순간에만 꺼낸다 */
  githubToken?: () => string | undefined;
  /** 테스트에서만: 등록 주소 대신 로컬 bare 저장소 */
  remoteUrlFor?: (p: ProjectRow) => string;
  /** 테스트에서만: GitHub API 대신 가짜 응답 */
  fetchImpl?: typeof fetch;
  run?: Runner;
  log?: (s: string) => void;
}

type GitFailure = 'conflict' | 'rejected' | 'auth' | 'protected' | 'network' | 'error';

function classify(text: string): GitFailure {
  if (/CONFLICT|could not apply|Merge conflict/i.test(text)) return 'conflict';
  if (/protected branch|GH006/i.test(text)) return 'protected';
  if (/Authentication failed|403|denied|could not read Username|invalid credentials/i.test(text)) return 'auth';
  if (/non-fast-forward|\[rejected\]|fetch first|stale info/i.test(text)) return 'rejected';
  if (/Could not resolve host|unable to access|Connection (timed out|refused|reset)|Failed to connect|network/i.test(text)) return 'network';
  return 'error';
}

const FAILURE_TEXT: Record<GitFailure, string> = {
  conflict: '최신 main과 충돌해요. 충돌을 풀어야 해요',
  rejected: '원격 브랜치가 그사이 바뀌어 받아 주지 않았어요 (강제 푸시는 하지 않아요)',
  auth: 'GitHub 인증에 실패했어요. 토큰과 권한을 확인해 주세요',
  protected: 'GitHub 브랜치 보호 규칙이 막았어요 (main "PR 필수"를 끄거나 토큰에 예외를 주세요)',
  network: '네트워크 오류로 두 번 시도했지만 실패했어요',
  error: 'git 명령이 실패했어요',
};

class GitStepError extends Error {
  readonly failure: GitFailure;

  constructor(failure: GitFailure, detail: string) {
    super(`${FAILURE_TEXT[failure]}: ${detail.trim().slice(-500)}`);
    this.failure = failure;
  }
}

const CURSOR = 'gitcat.cursor';

export class GitCat {
  private readonly d: GitCatDeps;
  private readonly c: Ctx;
  private readonly run: Runner;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(d: GitCatDeps) {
    this.d = d;
    this.c = d.c;
    this.run = d.run ?? ((o: RunOptions) => runProcess(o));
  }

  /** git 작업은 한 번에 하나씩 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private get timeoutMs(): number {
    return this.c.config.gitcat.timeoutMin * 60_000;
  }

  private remoteUrl(p: ProjectRow): string {
    return this.d.remoteUrlFor ? this.d.remoteUrlFor(p) : p.repoUrl;
  }

  /** 로컬 git (자격 증명 없음) */
  private async git(cwd: string, args: string[], opts: { stdin?: string; author?: boolean } = {}): Promise<RunResult> {
    const g = this.c.config.gitcat;
    const author = opts.author
      ? { GIT_AUTHOR_NAME: g.authorName, GIT_AUTHOR_EMAIL: g.authorEmail, GIT_COMMITTER_NAME: g.authorName, GIT_COMMITTER_EMAIL: g.authorEmail }
      : {};
    return this.run({ bin: 'git', args, cwd, timeoutMs: this.timeoutMs, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}), extraEnv: author });
  }

  private async mustGit(cwd: string, args: string[], opts: { stdin?: string; author?: boolean } = {}): Promise<string> {
    const r = await this.git(cwd, args, opts);
    if (r.code !== 0) throw new GitStepError(classify(r.stderr + r.stdout), `git ${args[0]}: ${r.stderr || r.stdout || r.spawnError || ''}`);
    return r.stdout.trim();
  }

  /** 원격 git (fetch, ls-remote, push, clone). 토큰은 이 프로세스에만 넣는다. 네트워크 오류는 한 번 다시 시도한다. */
  private async remoteGit(cwd: string, args: string[]): Promise<string> {
    const token = this.d.githubToken?.();
    const privilegedEnv = token
      ? {
          // 시스템의 자격 증명 도우미(Windows 자격 증명 관리자)를 지우고, 이번 프로세스의 토큰만 쓴다
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'credential.helper',
          GIT_CONFIG_VALUE_0: '',
          GIT_CONFIG_KEY_1: 'credential.helper',
          GIT_CONFIG_VALUE_1: '!f() { echo username=x-access-token; echo "password=$GIT_CAT_TOKEN"; }; f',
          GIT_CAT_TOKEN: token,
        }
      : undefined;
    let last: RunResult | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      last = await this.run({ bin: 'git', args, cwd, timeoutMs: this.timeoutMs, ...(privilegedEnv ? { privilegedEnv } : {}) });
      if (last.code === 0) return last.stdout.trim();
      if (classify(last.stderr) !== 'network') break;
      this.d.log?.(`git ${args[0]} 네트워크 오류, 한 번 더 시도해요`);
    }
    throw new GitStepError(classify(last!.stderr + last!.stdout), `git ${args[0]}: ${last!.stderr || last!.spawnError || ''}`);
  }

  private context(ticketId: string): { t: TicketRow; p: ProjectRow; url: string } {
    const t = this.c.db.select().from(tickets).where(eq(tickets.id, ticketId)).get();
    if (!t) throw new OfficeError('gitcat', `${ticketId} 티켓이 없어요`);
    const order = this.c.db.select().from(orders).where(eq(orders.id, t.orderId)).get();
    if (!order?.projectId) throw new OfficeError('gitcat', `${ticketId}: 등록된 프로젝트가 없어요`);
    const p = getProject(this.c, order.projectId);
    return { t, p, url: this.remoteUrl(p) };
  }

  /** 원격 기본 브랜치 끝 (FETCH_HEAD). 강제 갱신 refspec 없이 받는다 */
  private async fetchSha(cwd: string, url: string, branch: string): Promise<string> {
    await this.remoteGit(cwd, ['fetch', '--no-tags', url, `refs/heads/${branch}`]);
    return this.mustGit(cwd, ['rev-parse', 'FETCH_HEAD']);
  }

  private async remoteBranchSha(cwd: string, url: string, branch: string): Promise<string | null> {
    const out = await this.remoteGit(cwd, ['ls-remote', url, `refs/heads/${branch}`]);
    return out.split(/\s+/)[0] || null;
  }

  /** 이번 푸시에 들어갈 커밋의 시작점: 원격 작업 브랜치가 있으면 그 끝, 없으면 원격 기본 브랜치와의 분기점 */
  private async baseFor(t: TicketRow, p: ProjectRow, url: string): Promise<string> {
    const wt = t.worktreePath!;
    const remoteBranch = await this.remoteBranchSha(wt, url, t.branch!);
    if (remoteBranch) {
      await this.remoteGit(wt, ['fetch', '--no-tags', url, `refs/heads/${t.branch}`]);
      const isAncestor = await this.git(wt, ['merge-base', '--is-ancestor', remoteBranch, 'HEAD']);
      if (isAncestor.code !== 0) throw new GitStepError('rejected', `원격 ${t.branch}가 로컬 기록에 없어요`);
      return remoteBranch;
    }
    const main = await this.fetchSha(wt, url, p.defaultBranch);
    return this.mustGit(wt, ['merge-base', 'HEAD', main]);
  }

  private reviewInfo(t: TicketRow): { passed: boolean; reviewerName: string } {
    const last = this.c.db
      .select()
      .from(messages)
      .where(eq(messages.ticketId, t.id))
      .all()
      .filter((m) => m.kind === 'review')
      .at(-1);
    const reviewer = this.c.db.select().from(employees).where(eq(employees.id, t.reviewerId)).get();
    return { passed: t.status === 'done' || last?.reviewVerdict === 'pass', reviewerName: reviewer?.brain.provider === 'codex' ? 'Codex' : (reviewer?.displayName ?? t.reviewerId) };
  }

  private async scans(cwd: string, base: string): Promise<CheckResult[]> {
    const g = this.c.config.gitcat;
    return [
      await secretScan(this.run, { cwd, bin: g.gitleaksBin, args: g.gitleaksArgs, base, timeoutMs: this.timeoutMs }),
      await largeFiles(this.run, { cwd, base, maxBytes: g.maxFileMB * 1024 * 1024, timeoutMs: this.timeoutMs }),
    ];
  }

  private fail(ticketId: string, stage: string, reason: string, approvalId?: string): void {
    emit(this.c, 'git.push', { ticketId, ok: false, stage, reason, ...(approvalId ? { approvalId } : {}) });
    this.d.log?.(`Git 고양이 ${ticketId} ${stage} 실패: ${reason}`);
  }

  /** 준비 단계에서 거절: #막힘에 알리도록 이벤트를 남긴다 */
  private refuse(ticketId: string, message: string): { ok: false; message: string } {
    this.fail(ticketId, 'prepare', message);
    return { ok: false, message };
  }

  // --- 1) 확인 요청 준비 ---------------------------------------------------

  /**
   * /push · /되돌리기 · 비서실장 확인 요청 → 푸시 전 검사를 돌리고 결재함에 확인 버튼(③)을 올린다.
   * 비밀 정보·큰 파일이 있으면 버튼 없이 차단한다. 결과는 git.push 이벤트로도 남는다.
   */
  preparePush(ticketId: string, kind: 'push' | 'revert', origin: string): Promise<{ ok: boolean; message: string }> {
    return this.serial(async () => {
      try {
        const { t, p, url } = this.context(ticketId);
        const pending = this.c.db.select().from(approvals).where(eq(approvals.targetId, t.id)).all().find((a) => a.kind === kind && a.status === 'pending');
        if (pending) return { ok: true, message: '이미 결재함에 확인 버튼이 있어요' };

        if (kind === 'revert') {
          const sha = await this.findTicketCommit(p, url, t.id);
          if (!sha) return this.refuse(t.id, `${p.defaultBranch}에서 ${t.id} 커밋을 찾지 못했어요`);
          requestApproval(this.c, { kind: 'revert', targetId: t.id, reversible: 'reversible', summary: `${t.id} ${t.title} 되돌리기 — ${p.defaultBranch}의 ${sha.slice(0, 7)}를 반대로 되돌리는 커밋 (요청: ${origin})` });
          return { ok: true, message: '결재함에 되돌리기 확인 버튼을 올렸어요' };
        }

        if (!t.worktreePath || !t.branch || !existsSync(t.worktreePath)) return this.refuse(t.id, `${t.id}에는 작업 공간(worktree)이 없어요`);
        assertInside(this.c.config.paths.wt, t.worktreePath, `Git 고양이(${t.id})`);
        const base = await this.baseFor(t, p, url);
        const review = this.reviewInfo(t);
        const test = await this.d.tests.run(t.id, new AbortController().signal);
        const checks: CheckResult[] = [
          { name: '리뷰', ok: review.passed, blocking: false, detail: review.passed ? '통과' : '리뷰를 통과하지 않은 작업이에요. 그래도 누르면 진행해요' },
          { name: '테스트 재실행', ok: test.passed, blocking: false, detail: test.passed ? '통과' : `실패 — ${test.summary.split('\n').slice(-3).join(' ')}` },
          ...(await this.scans(t.worktreePath, base)),
        ];
        const ahead = await this.mustGit(t.worktreePath, ['rev-list', '--count', `${base}..HEAD`]);
        const dirty = await this.mustGit(t.worktreePath, ['status', '--porcelain']);
        const files = await this.mustGit(t.worktreePath, ['diff', '--name-only', base]);
        const summary = summarizeChecks(checks);
        if (summary.blocked) {
          this.fail(t.id, 'checks', summary.lines.join('\n'));
          return { ok: false, message: `푸시하지 않아요\n${summary.lines.join('\n')}` };
        }
        requestApproval(this.c, {
          kind: 'push',
          targetId: t.id,
          reversible: 'partial',
          summary: [`${t.id} ${t.title} 푸시 (${t.branch}) · 요청: ${origin}`, `커밋 ${ahead}개${dirty ? ' + 커밋하지 않은 변경' : ''} · 바뀐 파일 ${files.split('\n').filter(Boolean).length}개`, ...summary.lines].join('\n'),
        });
        return { ok: true, message: '검사를 마치고 결재함에 확인 버튼을 올렸어요' };
      } catch (err) {
        const msg = (err as Error).message;
        this.fail(ticketId, 'prepare', msg);
        return { ok: false, message: msg };
      }
    });
  }

  private async findTicketCommit(p: ProjectRow, url: string, ticketId: string): Promise<string | null> {
    const main = await this.fetchSha(p.localPath, url, p.defaultBranch);
    const out = await this.mustGit(p.localPath, ['log', main, '-E', `--grep=^${TRAILER}: ${ticketId}$`, '--format=%H', '-n', '1']);
    return out || null;
  }

  // --- 2) 결재 결과 실행 ---------------------------------------------------

  /** 결정된 푸시·되돌리기 결재를 실행한다. 이벤트 커서는 DB에 남는다. */
  async tick(): Promise<number> {
    const cursor = getState<number>(this.c, CURSOR, 0);
    const batch = this.c.db.select().from(events).where(gt(events.seq, cursor)).orderBy(events.seq).limit(200).all();
    let done = 0;
    for (const ev of batch) {
      setState(this.c, CURSOR, ev.seq);
      if (ev.type !== 'approval.decided') continue;
      const p = ev.payload as { approvalId: string; status: string };
      if (p.status !== 'approved') continue;
      const a = this.c.db.select().from(approvals).where(eq(approvals.id, p.approvalId)).get();
      if (!a || (a.kind !== 'push' && a.kind !== 'revert' && a.kind !== 'main-merge')) continue;
      // CEO 결정은 DB에서 다시 확인한다: 승인 상태이고 결정자가 CEO 계정이어야 한다
      if (a.status !== 'approved' || a.decidedByDiscordId !== this.c.config.ceoDiscordId) continue;
      await this.serial(() => (a.kind === 'revert' ? this.executeRevert(a) : this.executePush(a)));
      done++;
    }
    return done;
  }

  private async executePush(a: ApprovalRow): Promise<void> {
    const toMain = a.choice === 'main' || a.kind === 'main-merge';
    let ticketId = a.targetId;
    try {
      const { t, p, url } = this.context(a.targetId);
      ticketId = t.id;
      if (!t.worktreePath || !t.branch || !existsSync(t.worktreePath)) throw new OfficeError('gitcat', 'worktree가 없어요');
      const wt = assertInside(this.c.config.paths.wt, t.worktreePath, `Git 고양이(${t.id})`);

      // 커밋하지 않은 변경도 리뷰 diff에 들어갔으므로 함께 담는다 (.claude는 exclude에 있다)
      if (await this.mustGit(wt, ['status', '--porcelain'])) {
        await this.mustGit(wt, ['add', '-A']);
        await this.mustGit(wt, ['commit', '-m', `wip: ${t.id} 푸시 전 남은 변경`], { author: true });
      }
      const base = await this.baseFor(t, p, url);
      if ((await this.mustGit(wt, ['rev-parse', 'HEAD'])) === base) throw new OfficeError('gitcat', '새 커밋이 없어요');

      // wip 커밋들을 하나로 합친다 (squash). 메시지 초안은 Qwen, 형식은 코드
      const review = this.reviewInfo(t);
      const info: CommitTicketInfo = { id: t.id, title: t.title, acceptanceCriteria: t.acceptanceCriteria, reworkCount: t.reworkCount, reviewPassed: review.passed, reviewerName: review.reviewerName };
      const diffStat = await this.mustGit(wt, ['diff', '--stat', base, 'HEAD']);
      const draft = this.d.drafter ? await this.d.drafter(info, diffStat).catch(() => null) : null;
      await this.mustGit(wt, ['reset', '--soft', base]);
      await this.mustGit(wt, ['commit', '-F', '-'], { stdin: formatCommitMessage(info, draft), author: true });
      const sha = await this.mustGit(wt, ['rev-parse', 'HEAD']);
      emit(this.c, 'git.commit', { ticketId: t.id, sha, subject: formatCommitMessage(info, draft).split('\n')[0] });

      // 합친 커밋을 다시 검사한다 (실패하면 닫힘)
      const scans = summarizeChecks(await this.scans(wt, base));
      if (scans.blocked) throw new OfficeError('gitcat', scans.lines.join('\n'));

      if (!toMain) {
        await this.remoteGit(wt, ['push', url, `HEAD:refs/heads/${t.branch}`]);
        emit(this.c, 'git.push', { ticketId: t.id, ok: true, target: t.branch, sha: sha.slice(0, 7), approvalId: a.id });
      } else {
        // main 직접 병합: 최신 main 위로 rebase → 합친 상태에서 테스트 → 백업 → fast-forward 푸시
        const main = await this.fetchSha(wt, url, p.defaultBranch);
        const rebase = await this.git(wt, ['rebase', main]);
        if (rebase.code !== 0) {
          await this.git(wt, ['rebase', '--abort']);
          throw new GitStepError('conflict', rebase.stderr + rebase.stdout);
        }
        const test = await this.d.tests.run(t.id, new AbortController().signal);
        if (!test.passed) throw new OfficeError('gitcat', `최신 ${p.defaultBranch}와 합친 상태에서 테스트가 실패해 푸시하지 않았어요\n${test.summary.split('\n').slice(-5).join('\n')}`);
        const stamp = this.c.clock.now().toISOString().replace(/[-:]/g, '').slice(0, 15);
        await this.mustGit(p.localPath, ['branch', `backup/${p.defaultBranch}-${stamp}`, main]);
        const merged = await this.mustGit(wt, ['rev-parse', 'HEAD']);
        await this.remoteGit(wt, ['push', url, `HEAD:refs/heads/${p.defaultBranch}`]);
        emit(this.c, 'git.push', { ticketId: t.id, ok: true, target: p.defaultBranch, sha: merged.slice(0, 7), backup: `backup/${p.defaultBranch}-${stamp}`, test: 'passed', approvalId: a.id });
      }
      // 티켓이 끝났고 푸시도 끝나면 worktree는 지우고 브랜치는 남긴다
      if (t.status === 'done' && this.d.removeWorktree) await this.d.removeWorktree(this.c.db.select().from(tickets).where(eq(tickets.id, t.id)).get()!);
    } catch (err) {
      this.fail(ticketId, toMain ? 'main-merge' : 'push', (err as Error).message, a.id);
    }
  }

  private async executeRevert(a: ApprovalRow): Promise<void> {
    const ticketId = a.targetId;
    let tmp: string | null = null;
    let repo: string | null = null;
    try {
      const { p, url } = this.context(ticketId);
      repo = p.localPath;
      const commit = await this.findTicketCommit(p, url, ticketId);
      if (!commit) throw new OfficeError('gitcat', `${p.defaultBranch}에서 ${ticketId} 커밋을 찾지 못했어요`);
      const main = await this.fetchSha(p.localPath, url, p.defaultBranch);
      tmp = assertInside(this.c.config.paths.wt, join(this.c.config.paths.wt, '_revert', `${ticketId}-${newId().slice(0, 8)}`), `되돌리기(${ticketId})`);
      mkdirSync(join(this.c.config.paths.wt, '_revert'), { recursive: true });
      await this.mustGit(p.localPath, ['worktree', 'add', '--detach', tmp, main]);
      const r = await this.git(tmp, ['revert', '--no-edit', commit], { author: true });
      if (r.code !== 0) {
        await this.git(tmp, ['revert', '--abort']);
        throw new GitStepError('conflict', r.stderr + r.stdout);
      }
      const sha = await this.mustGit(tmp, ['rev-parse', 'HEAD']);
      await this.remoteGit(tmp, ['push', url, `HEAD:refs/heads/${p.defaultBranch}`]);
      emit(this.c, 'git.push', { ticketId, ok: true, target: p.defaultBranch, sha: sha.slice(0, 7), revert: commit.slice(0, 7), approvalId: a.id });
    } catch (err) {
      this.fail(ticketId, 'revert', (err as Error).message, a.id);
    } finally {
      if (tmp && repo) {
        // 임시 worktree 정리. 지워지지 않으면 폴더를 지우고 git 기록만 정리한다
        const removed = await this.git(repo, ['worktree', 'remove', tmp]);
        if (removed.code !== 0) {
          rmSync(tmp, { recursive: true, force: true });
          await this.git(repo, ['worktree', 'prune']);
        }
      }
    }
  }

  // --- 3) 프로젝트 등록 ------------------------------------------------------

  /** 저장소를 repos\<id>에 받아 오고 등록한다. 받기에 실패하면 등록하지 않는다. */
  registerAndClone(p: { id: string; repoUrl: string; testCommand: string; defaultBranch?: string }): Promise<string> {
    return this.serial(async () => {
      const localPath = join(this.c.config.paths.repos, p.id);
      const project = { ...p, localPath };
      if (!existsSync(localPath)) {
        mkdirSync(this.c.config.paths.repos, { recursive: true });
        // 등록 규칙(주소·경로·중복)을 먼저 검사하고 받는다
        validateProject(this.c, project);
        await this.remoteGit(this.c.config.paths.repos, ['clone', '--no-tags', this.d.remoteUrlFor ? this.d.remoteUrlFor({ ...project, defaultBranch: p.defaultBranch ?? 'main', discordCategoryId: null, discordChannelId: null }) : p.repoUrl, localPath]);
      }
      registerProject(this.c, project);
      writeFileSync(join(localPath, '.git', 'info', 'exclude'), '.claude/\n', { flag: 'a' });
      return `${p.id} 프로젝트를 등록했어요 (${localPath})`;
    });
  }

  /** /새프로젝트: GitHub에 비공개 저장소를 만든다(11장). 등록은 registerAndClone이 한다. 토큰은 이 요청에만 넣는다 */
  async createRepo(name: string, description?: string): Promise<CreatedRepo> {
    const token = this.d.githubToken?.();
    if (!token) throw new OfficeError('repo-auth', 'GitHub 토큰이 없어요. scripts\\set-secrets.ps1 -WithGithub로 넣어 주세요');
    return createGithubRepo({ token, name, ...(description ? { description } : {}), ...(this.d.fetchImpl ? { fetchImpl: this.d.fetchImpl } : {}) });
  }
}
