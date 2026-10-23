// Git 고양이 (11장). AI가 아니라 정해진 순서대로 git 명령을 실행하는 코드다.
// - 푸시는 CEO가 결재함 버튼을 눌러야만 한다. 이 파일은 결정된 결재(approval.decided)를 보고 실행한다.
// - 강제 푸시는 없다. 이 파일에는 --force도, 강제 갱신 refspec도 없다(테스트가 확인한다).
// - 푸시 주소는 등록된 저장소(projects.repoUrl)뿐이다. AI 출력이나 티켓 내용에서 주소를 받지 않는다.
// - GitHub 토큰은 푸시·fetch를 하는 git 프로세스에만, 그 순간 환경 변수로 넣는다. AI 직원 프로세스에는 없다.
// - 푸시 전 검사: 비밀 정보·큰 파일은 차단, 리뷰·테스트는 경고 (checks.ts).
// - 실패해도 티켓 상태는 바꾸지 않는다(done은 끝난 상태). #막힘에 알리고 CEO가 다시 /push 한다 (4단계 결정 K).
// - 프로젝트 통합 브랜치 (2026-10-23 CEO 결정): 끝난 티켓을 로컬 integration/<프로젝트>에 차례로 합친다. 원격 git은 쓰지 않는다.
//   충돌은 병합 담당(개발팀장 Claude)이 풀고, 풀렸는지·테스트가 통과하는지는 이 코드가 판정한다.
import { and, eq, gt, gte, isNotNull } from 'drizzle-orm';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TestRunner } from '../brains/brain.ts';
import { runProcess, type RunOptions, type RunResult } from '../brains/process.ts';
import { emit, getState, newId, nowIso, setState, type Ctx } from '../context.ts';
import { requestApproval, type ApprovalRow } from '../core/approvals.ts';
import { approvals, employees, events, messages, tickets } from '../db/schema.ts';
import { OfficeError } from '../errors.ts';
import { projectOfOrder, registerProject, validateProject, type ProjectRow } from '../workspace/projects.ts';
import { assertInside, integrationBranch, integrationPathFor } from '../workspace/paths.ts';
import { runTestCommand } from '../workspace/test-runner.ts';
import { writeClaudeSettings } from '../workspace/worktrees.ts';
import type { TicketRow } from '../core/tickets.ts';
import { largeFiles, secretScan, summarizeChecks, type CheckResult, type Runner } from './checks.ts';
import { formatCommitMessage, TRAILER, type CommitDraft, type CommitTicketInfo } from './commit-message.ts';
import { createGithubRepo, type CreatedRepo } from './github-repo.ts';

/** 병합 담당 (2026-10-23 CEO 결정): 통합 브랜치 충돌은 개발팀장(Claude, 개발 몫)이 푼다 */
export const MERGE_RESOLVER_ID = 'developer';

export interface ConflictRequest {
  ticket: { id: string; title: string; type: string; acceptanceCriteria: string[] };
  files: string[];
  /** 통합 브랜치 작업 폴더 (<wt>\_integration\<프로젝트>) */
  workdir: string;
}
/** resolved: 풀었다고 보고함(판정은 코드) · wait: 한도·연결 문제로 다음 바퀴에 · failed: 형식 오류·호출 실패 */
export type ConflictResult = 'resolved' | 'wait' | 'failed';

export interface GitCatDeps {
  c: Ctx;
  tests: TestRunner;
  /** 푸시가 끝난 worktree 정리 (GitWorkspace.removeWorktree) */
  removeWorktree?: (t: TicketRow) => Promise<void>;
  /** 커밋 메시지 초안 (Engine.draftCommit, 7-5부터 커밋 서기). 없거나 실패하면 기본 형식 */
  drafter?: (info: CommitTicketInfo, diffStat: string) => Promise<CommitDraft | null>;
  /** 병합 담당 (Engine.resolveMerge). 없으면 통합 브랜치 충돌은 실패로 본다 */
  resolveConflict?: (r: ConflictRequest) => Promise<ConflictResult>;
  /** 변경 요약가 (16장 7-5): 푸시 결재 메시지에 붙일 diff 요약 5줄 이내. 없거나 실패하면 요약 없이 */
  summarizeDiff?: (ticket: { id: string; title: string; type: string; acceptanceCriteria: string[] }, diff: string) => Promise<string[] | null>;
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
/** 통합 브랜치에 합친 기록 (티켓 ID → 결과). 실패한 티켓은 다시 합치지 않는다 */
const INTEGRATED = 'gitcat.integrated';
/** 통합 브랜치 기능을 처음 켠 시각. 이 뒤에 끝난 티켓만 합친다 */
const INTEGRATE_SINCE = 'gitcat.integrateSince';

interface Integrated {
  ok: boolean;
  sha: string | null;
  at: string;
  reason?: string;
}

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
    const p = projectOfOrder(this.c, t.orderId);
    if (!p) throw new OfficeError('gitcat', `${ticketId}: 등록된 프로젝트가 없어요`);
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

  /**
   * 이 티켓 커밋을 하나로 합칠 시작점. 통합 브랜치에서 시작한 티켓이면 통합 브랜치와 갈라진 곳이라
   * 이어받은 앞 티켓 커밋은 합치지 않고 그대로 둔다. 그곳이 원격 기준(base)보다 앞이 아니면 base.
   * 검사(비밀 정보·큰 파일)는 원격에 없는 커밋 전부를 봐야 하므로 여전히 base로 한다.
   */
  private async squashBaseFor(wt: string, p: ProjectRow, base: string): Promise<string> {
    const integ = integrationBranch(p.id);
    if ((await this.git(wt, ['rev-parse', '--verify', '--quiet', `refs/heads/${integ}`])).code !== 0) return base;
    const fork = await this.mustGit(wt, ['merge-base', 'HEAD', integ]);
    return (await this.git(wt, ['merge-base', '--is-ancestor', base, fork])).code === 0 ? fork : base;
  }

  /** GPT 개발자는 커밋하지 않는다. 리뷰 diff에 들어간 커밋하지 않은 변경을 담는다 (.claude는 exclude에 있다) */
  private async commitLeftovers(wt: string, t: TicketRow, why: string): Promise<void> {
    if (!(await this.mustGit(wt, ['status', '--porcelain']))) return;
    await this.mustGit(wt, ['add', '-A']);
    await this.mustGit(wt, ['commit', '-m', `wip: ${t.id} ${why}`], { author: true });
  }

  /** 티켓 커밋 메시지: 초안은 커밋 서기(로컬), 형식은 코드 */
  private async commitMessage(t: TicketRow, diffStat: string): Promise<string> {
    const review = this.reviewInfo(t);
    const info: CommitTicketInfo = { id: t.id, title: t.title, acceptanceCriteria: t.acceptanceCriteria, reworkCount: t.reworkCount, reviewPassed: review.passed, reviewerName: review.reviewerName };
    const draft = this.d.drafter ? await this.d.drafter(info, diffStat).catch(() => null) : null;
    return formatCommitMessage(info, draft);
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
        const own = await this.squashBaseFor(t.worktreePath, p, base);
        const review = this.reviewInfo(t);
        const test = await this.d.tests.run(t.id, new AbortController().signal);
        const checks: CheckResult[] = [
          { name: '리뷰', ok: review.passed, blocking: false, detail: review.passed ? '통과' : '리뷰를 통과하지 않은 작업이에요. 그래도 누르면 진행해요' },
          { name: '테스트 재실행', ok: test.passed, blocking: false, detail: test.passed ? '통과' : `실패 — ${test.summary.split('\n').slice(-3).join(' ')}` },
          ...(await this.scans(t.worktreePath, base)),
        ];
        const ahead = await this.mustGit(t.worktreePath, ['rev-list', '--count', `${own}..HEAD`]);
        const dirty = await this.mustGit(t.worktreePath, ['status', '--porcelain']);
        const files = await this.mustGit(t.worktreePath, ['diff', '--name-only', own]);
        const summary = summarizeChecks(checks);
        if (summary.blocked) {
          this.fail(t.id, 'checks', summary.lines.join('\n'));
          return { ok: false, message: `푸시하지 않아요\n${summary.lines.join('\n')}` };
        }
        const changes = await this.diffSummary(t, own);
        requestApproval(this.c, {
          kind: 'push',
          targetId: t.id,
          reversible: 'partial',
          summary: [
            `${t.id} ${t.title} 푸시 (${t.branch}) · 요청: ${origin}`,
            `커밋 ${ahead}개${dirty ? ' + 커밋하지 않은 변경' : ''} · 바뀐 파일 ${files.split('\n').filter(Boolean).length}개`,
            ...(changes.length ? ['변경 요약 (변경 요약가):', ...changes.map((l) => `· ${l}`)] : []),
            ...summary.lines,
          ].join('\n'),
        });
        return { ok: true, message: '검사를 마치고 결재함에 확인 버튼을 올렸어요' };
      } catch (err) {
        const msg = (err as Error).message;
        this.fail(ticketId, 'prepare', msg);
        return { ok: false, message: msg };
      }
    });
  }

  /** 변경 요약가에게 diff를 넘겨 요약을 받는다(16장 7-5). 참고용이라 어떤 실패도 결재를 막지 않는다 */
  private async diffSummary(t: TicketRow, base: string): Promise<string[]> {
    if (!this.d.summarizeDiff || !t.worktreePath) return [];
    try {
      const r = await this.git(t.worktreePath, ['diff', base]);
      if (r.code !== 0 || !r.stdout.trim()) return [];
      const lines = await this.d.summarizeDiff({ id: t.id, title: t.title, type: t.type, acceptanceCriteria: t.acceptanceCriteria }, r.stdout.slice(0, 20_000));
      return (lines ?? []).slice(0, 5);
    } catch (err) {
      this.d.log?.(`${t.id} 변경 요약 실패(건너뜀): ${(err as Error).message}`);
      return [];
    }
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

      await this.commitLeftovers(wt, t, '푸시 전 남은 변경');
      const base = await this.baseFor(t, p, url);
      const own = await this.squashBaseFor(wt, p, base);
      if ((await this.mustGit(wt, ['rev-parse', 'HEAD'])) === own) throw new OfficeError('gitcat', '새 커밋이 없어요');

      // 이 티켓의 wip 커밋들을 하나로 합친다 (squash)
      const message = await this.commitMessage(t, await this.mustGit(wt, ['diff', '--stat', own, 'HEAD']));
      await this.mustGit(wt, ['reset', '--soft', own]);
      await this.mustGit(wt, ['commit', '-F', '-'], { stdin: message, author: true });
      const sha = await this.mustGit(wt, ['rev-parse', 'HEAD']);
      emit(this.c, 'git.commit', { ticketId: t.id, sha, subject: message.split('\n')[0] });

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

  // --- 4) 프로젝트 통합 브랜치 (11장, 2026-10-23 CEO 결정) --------------------

  /**
   * 끝난(done) 코딩 티켓을 프로젝트 통합 브랜치에 끝난 순서대로 합친다. 로컬 브랜치만 바꾸고 원격 git은 쓰지 않는다.
   * 이 기능을 처음 켠 뒤에 끝난 티켓만 합친다(예전 티켓을 한꺼번에 합치며 한도를 쓰지 않게). 처리한(합쳤거나 실패한) 티켓 수를 돌려준다.
   */
  async integrateDone(): Promise<number> {
    const since = getState<string | null>(this.c, INTEGRATE_SINCE, null);
    if (!since) {
      setState(this.c, INTEGRATE_SINCE, nowIso(this.c));
      return 0;
    }
    const record = getState<Record<string, Integrated>>(this.c, INTEGRATED, {});
    const todo = this.c.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.status, 'done'), eq(tickets.type, 'coding'), isNotNull(tickets.branch), gte(tickets.finishedAt, since)))
      .orderBy(tickets.finishedAt)
      .all()
      .filter((t) => !record[t.id]);
    let n = 0;
    for (const t of todo) {
      // 병합 담당을 기다리면 뒤 티켓도 다음 바퀴에 (끝난 순서를 지킨다)
      if (!(await this.integrate(t))) break;
      n++;
    }
    return n;
  }

  private recordIntegration(ticketId: string, r: Omit<Integrated, 'at'>): void {
    setState(this.c, INTEGRATED, { ...getState<Record<string, Integrated>>(this.c, INTEGRATED, {}), [ticketId]: { ...r, at: nowIso(this.c) } });
  }

  /** 티켓 하나를 합친다. 병합 담당을 기다려야 하면 합치기 전으로 돌려 두고 false */
  private async integrate(t: TicketRow): Promise<boolean> {
    // 되돌릴 자리. 비동기 안에서 채우므로 객체로 둔다
    const at = { dir: '', before: '' };
    const undo = async () => {
      if (!at.dir || !at.before) return;
      await this.git(at.dir, ['reset', '--hard', at.before]);
      await this.git(at.dir, ['clean', '-fd']);
    };
    try {
      const { p } = this.context(t.id);
      const conflicts = await this.serial(async () => {
        at.dir = await this.integrationWorktree(p);
        at.before = await this.mustGit(at.dir, ['rev-parse', 'HEAD']);
        if (t.worktreePath && existsSync(t.worktreePath)) await this.commitLeftovers(assertInside(this.c.config.paths.wt, t.worktreePath, `Git 고양이(${t.id})`), t, '통합 전 남은 변경');
        const r = await this.git(at.dir, ['merge', '--squash', t.branch!]);
        const files = (await this.mustGit(at.dir, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
        if (r.code !== 0 && !files.length) throw new GitStepError(classify(r.stderr + r.stdout), `git merge: ${r.stderr || r.stdout || r.spawnError || ''}`);
        return files;
      });
      if (conflicts.length) {
        const ticket = { id: t.id, title: t.title, type: t.type, acceptanceCriteria: t.acceptanceCriteria };
        const res = this.d.resolveConflict ? await this.d.resolveConflict({ ticket, files: conflicts, workdir: at.dir }) : 'failed';
        if (res === 'wait') {
          await this.serial(undo);
          return false;
        }
        if (res === 'failed') throw new OfficeError('gitcat', `병합 담당이 충돌을 풀지 못했어요: ${conflicts.join(', ')}`);
      }
      await this.serial(() => this.finishIntegration(t, p, at.dir, at.before, conflicts.length > 0));
    } catch (err) {
      await this.serial(undo).catch(() => undefined);
      const reason = (err as Error).message;
      this.recordIntegration(t.id, { ok: false, sha: null, reason });
      this.fail(t.id, 'integrate', `${reason}\n통합 브랜치에 넣지 않고 되돌렸어요. 이 티켓은 /push로 따로 올릴 수 있어요`);
    }
    return true;
  }

  /**
   * 합친 상태를 코드가 판정한다: 풀리지 않은 파일·충돌 표시가 없어야 하고, 정해진 형식의 커밋 하나로 남긴 뒤 테스트가 통과해야 한다.
   * 어긋나면 던진다(되돌리기는 부른 쪽). 병합 담당이 커밋했어도 Git 고양이 커밋 하나로 다시 만든다.
   */
  private async finishIntegration(t: TicketRow, p: ProjectRow, dir: string, before: string, hadConflict: boolean): Promise<void> {
    await this.mustGit(dir, ['add', '-A']);
    if ((await this.mustGit(dir, ['rev-parse', 'HEAD'])) !== before) await this.mustGit(dir, ['reset', '--soft', before]);
    if (/^\+(?:<{7}|>{7})(?: |$)/m.test(await this.mustGit(dir, ['diff', '--cached', '-U0', before]))) throw new OfficeError('gitcat', '충돌 표시(<<<<<<< >>>>>>>)가 남아 있어요');
    const stat = await this.mustGit(dir, ['diff', '--cached', '--stat', before]);
    if (!stat) {
      // 충돌을 풀었다는데 합칠 것이 없으면 병합 담당이 변경을 버린 것이다
      if (hadConflict) throw new OfficeError('gitcat', '충돌을 푼 뒤 합칠 변경이 남지 않았어요');
      this.recordIntegration(t.id, { ok: true, sha: null });
      return;
    }
    const message = await this.commitMessage(t, stat);
    await this.mustGit(dir, ['commit', '-F', '-'], { stdin: message, author: true });
    // ponytail: 테스트도 git 줄(serial) 안에서 돈다. 그동안 푸시가 기다린다. 길어지면 프로젝트별 줄로 나눈다
    const test = await runTestCommand(this.c, p, dir, undefined, this.run);
    if (!test.passed) throw new OfficeError('gitcat', `통합 브랜치에 합친 상태에서 테스트가 실패했어요\n${test.summary.split('\n').slice(-5).join('\n')}`);
    const sha = await this.mustGit(dir, ['rev-parse', 'HEAD']);
    this.recordIntegration(t.id, { ok: true, sha });
    emit(this.c, 'git.commit', { ticketId: t.id, sha, subject: message.split('\n')[0], target: integrationBranch(p.id) });
  }

  /** 통합 브랜치 작업 폴더. 없으면 기본 브랜치에서 만든다. 커밋된 것만 남는 곳이라 지난번에 멈춘 흔적은 지운다 */
  private async integrationWorktree(p: ProjectRow): Promise<string> {
    const dir = assertInside(this.c.config.paths.wt, integrationPathFor(this.c.config.paths.wt, p.id), `통합 브랜치(${p.id})`);
    const branch = integrationBranch(p.id);
    if (!existsSync(dir)) {
      mkdirSync(dirname(dir), { recursive: true });
      const exists = await this.mustGit(p.localPath, ['branch', '--list', branch]);
      await this.mustGit(p.localPath, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, p.defaultBranch]);
      // 병합 담당(Claude)이 일하는 곳이라 티켓 worktree와 같은 권한 설정을 둔다 (푸시·원격 조작 거부)
      await writeClaudeSettings(dir, this.c.config.paths.data);
    }
    const head = await this.mustGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (head !== branch) throw new OfficeError('gitcat', `${dir} 폴더가 ${branch}가 아니에요(${head}). 폴더를 치워 주세요`);
    await this.mustGit(dir, ['reset', '--hard', 'HEAD']);
    await this.mustGit(dir, ['clean', '-fd']);
    return dir;
  }
}
