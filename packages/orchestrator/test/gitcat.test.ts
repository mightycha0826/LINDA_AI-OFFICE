// Git 고양이 (11장): 실제 git 저장소로 확인한다. 로컬 bare 저장소가 GitHub 역할을 한다.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { RunOptions } from '../src/brains/process.ts';
import { runProcess } from '../src/brains/process.ts';
import { formatCommitMessage } from '../src/gitcat/commit-message.ts';
import { GitCat, MERGE_RESOLVER_ID, type ConflictRequest, type GitCatDeps } from '../src/gitcat/git-cat.ts';
import { approvals, employees, events, projects } from '../src/db/schema.ts';
import { GitWorkspace } from '../src/workspace/worktrees.ts';
import { integrationPathFor, isInside } from '../src/workspace/paths.ts';
import { claudeProfileFor } from '../src/brains/claude-code.ts';
import { codexSandboxFor } from '../src/brains/codex.ts';
import type { BrainRequest } from '../src/brains/brain.ts';
import { blockBudget } from '../src/core/budget.ts';
import { CEO, approvedTickets, setup, ticket } from './helpers.ts';

const FAKES = fileURLToPath(new URL('./fakes/', import.meta.url));
const SRC = fileURLToPath(new URL('../src/gitcat/', import.meta.url));
const TOKEN = 'ghtoken_' + 'x'.repeat(40);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

interface Rig {
  s: ReturnType<typeof setup>;
  bare: string;
  repo: string;
  wt: string;
  cat: GitCat;
  runs: RunOptions[];
  testsPass: { value: boolean };
}

/** GitHub 역할 bare 저장소 + repos\demo 복제 + 승인된 티켓 T-1의 worktree + wip 커밋 두 개 */
async function rig(opts: { maxFileMB?: number; gitleaksBin?: string; summarizeDiff?: GitCatDeps['summarizeDiff']; resolveConflict?: GitCatDeps['resolveConflict'] } = {}): Promise<Rig> {
  const s = setup({ config: { gitcat: { gitleaksBin: opts.gitleaksBin ?? process.execPath, gitleaksArgs: opts.gitleaksBin ? [] : [join(FAKES, 'fake-gitleaks.mjs')], maxFileMB: opts.maxFileMB ?? 50 } } });
  const bare = join(s.root, 'github', 'demo.git');
  const seed = join(s.root, 'seed');
  mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 'owner@localhost');
  git(seed, 'config', 'user.name', 'owner');
  git(seed, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(seed, 'README.md'), '# demo\n');
  writeFileSync(join(seed, 'app.txt'), 'line 1\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(s.root, 'clone', '-q', '--bare', seed, bare);
  const repo = s.db.select().from(projects).where(eq(projects.id, 'demo')).get()!.localPath;
  git(s.root, 'clone', '-q', bare, repo);
  git(repo, 'config', 'core.autocrlf', 'false');

  const { tickets: [tk] } = await approvedTickets(s);
  const { path: wt } = await new GitWorkspace(s.ctx).ensureWorktree(tk!);
  git(wt, 'config', 'user.email', 'dev@localhost');
  git(wt, 'config', 'user.name', 'dev');
  writeFileSync(join(wt, 'feature.txt'), 'step 1\n');
  git(wt, 'add', 'feature.txt');
  git(wt, 'commit', '-q', '-m', 'wip: 1');
  writeFileSync(join(wt, 'feature.txt'), 'step 1\nstep 2\n');
  git(wt, 'commit', '-q', '-am', 'wip: 2');

  const runs: RunOptions[] = [];
  const testsPass = { value: true };
  const cat = new GitCat({
    c: s.ctx,
    tests: { run: async () => ({ passed: testsPass.value, summary: testsPass.value ? 'ok' : '1 failed' }) },
    removeWorktree: (t) => new GitWorkspace(s.ctx).removeWorktree(t),
    drafter: async (info) => ({ type: 'feat', scope: 'demo', subject: `${info.title} 추가` }),
    githubToken: () => TOKEN,
    ...(opts.summarizeDiff ? { summarizeDiff: opts.summarizeDiff } : {}),
    ...(opts.resolveConflict ? { resolveConflict: opts.resolveConflict } : {}),
    remoteUrlFor: () => bare,
    run: (o) => {
      runs.push(o);
      return runProcess(o);
    },
  });
  return { s, bare, repo, wt, cat, runs, testsPass };
}

function pushApproval(r: Rig) {
  return r.s.db.select().from(approvals).where(eq(approvals.kind, 'push')).all().at(-1);
}
function gitEvents(r: Rig) {
  return r.s.db.select().from(events).all().filter((e) => e.type === 'git.push').map((e) => e.payload as Record<string, unknown>);
}
async function approveAndRun(r: Rig, choice: 'feature' | 'main') {
  const a = pushApproval(r)!;
  r.s.engine.decide({ approvalId: a.id, discordUserId: CEO, decision: 'approved', choice });
  await r.cat.tick();
}

describe('커밋 메시지 형식 (11장)', () => {
  it('종류(범위): 요약 (티켓) + 완료 조건 + 리뷰 + 트레일러. 초안이 틀리면 기본 형식', () => {
    const info = { id: 'T-12', title: '로그인 기능', acceptanceCriteria: ['로그인 테스트 통과'], reworkCount: 1, reviewPassed: true, reviewerName: 'Codex' };
    expect(formatCommitMessage(info, { type: 'feat', scope: 'auth', subject: '로그인 기능 추가' })).toBe(
      'feat(auth): 로그인 기능 추가 (T-12)\n\n완료 조건:\n- 로그인 테스트 통과\n\n리뷰: Codex 통과 (반려 1회)\nAI-Office-Ticket: T-12\n',
    );
    expect(formatCommitMessage(info, { type: 'yolo' as 'feat', scope: 'A B', subject: 'x' }).split('\n')[0]).toBe('chore(ticket): 로그인 기능 (T-12)');
    expect(formatCommitMessage(info, { type: 'fix', scope: 'auth', subject: '줄\n바꿈 (T-99)' }).split('\n')[0]).toBe('fix(auth): 줄 바꿈 (T-12)');
  });
});

describe('변경 요약가 (16장 7-5)', () => {
  it('푸시 결재 메시지에 diff 요약을 붙인다. diff에는 바뀐 파일이 들어간다', async () => {
    const seen: string[] = [];
    const r = await rig({ summarizeDiff: async (_t, diff) => (seen.push(diff), ['기능 파일 feature.txt를 추가했어요']) });
    expect(await r.cat.preparePush('T-1', 'push', 'CEO /push')).toMatchObject({ ok: true });
    expect(pushApproval(r)!.summary).toContain('변경 요약 (변경 요약가):\n· 기능 파일 feature.txt를 추가했어요');
    expect(seen[0]).toContain('feature.txt');
  });

  it('요약이 실패해도 결재 버튼은 그대로 올라간다', async () => {
    const r = await rig({ summarizeDiff: async () => Promise.reject(new Error('모델 문제')) });
    expect(await r.cat.preparePush('T-1', 'push', 'CEO /push')).toMatchObject({ ok: true });
    expect(pushApproval(r)!.summary).not.toContain('변경 요약');
  });
});

describe('푸시 (작업 브랜치)', () => {
  it('검사 → 결재 버튼 → CEO 승인 → wip 커밋을 하나로 합쳐 등록된 주소로만 푸시', async () => {
    const r = await rig();
    expect(await r.cat.preparePush('T-1', 'push', 'CEO /push')).toMatchObject({ ok: true });
    const a = pushApproval(r)!;
    expect(a.status).toBe('pending');
    expect(a.summary).toContain('커밋 2개');
    expect(a.summary).toContain('✔ 비밀 정보 검사');
    expect(a.summary).toContain('✔ 큰 파일');
    expect(git(r.bare, 'branch', '--list')).not.toContain('feature/T1');

    await approveAndRun(r, 'feature');
    const log = git(r.bare, 'log', 'feature/T1-work', '--format=%s|%an', '-n', '2').split('\n');
    expect(log[0]).toBe('feat(demo): 기능 구현 추가 (T-1)|Git 고양이');
    expect(log[1]).toBe('init|owner'); // wip 두 개가 하나로 합쳐졌다
    expect(git(r.bare, 'log', 'feature/T1-work', '-n', '1', '--format=%B')).toContain('AI-Office-Ticket: T-1');
    expect(git(r.bare, 'rev-parse', 'main')).toBe(git(r.repo, 'rev-parse', 'origin/main')); // main은 그대로
    expect(gitEvents(r).at(-1)).toMatchObject({ ok: true, target: 'feature/T1-work' });
  });

  it('토큰은 원격 git(fetch·ls-remote·push)에만 들어가고, 인자에는 없다. 강제 푸시도 없다', async () => {
    const r = await rig();
    await r.cat.preparePush('T-1', 'push', 'test');
    await approveAndRun(r, 'feature');
    for (const run of r.runs) {
      const remote = run.bin === 'git' && ['fetch', 'ls-remote', 'push', 'clone'].includes(run.args[0]!);
      expect(!!run.privilegedEnv?.GIT_CAT_TOKEN, run.args.join(' ')).toBe(remote);
      expect(run.args.join(' ')).not.toContain(TOKEN);
      expect(run.args).not.toContain('--force');
      expect(run.args).not.toContain('-f');
      expect(run.args.some((x) => x.startsWith('+'))).toBe(false);
      if (run.args[0] === 'push') expect(run.args[1]).toBe(r.bare); // 등록된 주소(테스트에서는 bare)로만
      if (run.privilegedEnv) expect(run.privilegedEnv.GIT_CONFIG_VALUE_0).toBe(''); // 시스템 자격 증명 도우미를 비운다
    }
    expect(r.runs.some((x) => x.args[0] === 'push')).toBe(true);
  });

  it('Git 고양이 코드에는 강제 푸시 명령이 아예 없다', () => {
    for (const f of readdirSync(SRC)) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(src, f).not.toMatch(/['"]--force['"]|['"]-f['"]|force-with-lease/);
    }
  });

  it('CEO가 반려하면 아무것도 나가지 않는다', async () => {
    const r = await rig();
    await r.cat.preparePush('T-1', 'push', 'test');
    r.s.engine.decide({ approvalId: pushApproval(r)!.id, discordUserId: CEO, decision: 'rejected' });
    await r.cat.tick();
    expect(git(r.bare, 'branch', '--list')).not.toContain('feature/T1');
    expect(r.runs.some((x) => x.args[0] === 'push')).toBe(false);
  });

  it('티켓이 끝난 뒤 푸시가 끝나면 worktree는 지우고 브랜치는 남긴다', async () => {
    const r = await rig();
    r.s.db.$client.prepare(`UPDATE tickets SET status = 'done', finished_at = ? WHERE id = 'T-1'`).run(new Date().toISOString());
    await r.cat.preparePush('T-1', 'push', 'test');
    await approveAndRun(r, 'feature');
    expect(existsSync(r.wt)).toBe(false);
    expect(git(r.repo, 'branch', '--list', 'feature/T1-work')).toContain('feature/T1-work');
    expect(ticket(r.s, 'T-1').worktreePath).toBeNull();
  });
});

describe('푸시 전 검사: 차단', () => {
  it('비밀 정보가 있으면 버튼을 올리지 않고(버튼으로도 못 넘어감) #막힘에 알린다', async () => {
    const r = await rig();
    // 가짜 AWS 키 모양(실제 키 아님). 저장소 스캐너에 걸리지 않게 실행 중에 이어 붙인다
    writeFileSync(join(r.wt, 'config.txt'), `aws=${'AKIA'}${'ABCDEFGHIJKLMNOP'}\n`);
    git(r.wt, 'add', 'config.txt');
    git(r.wt, 'commit', '-q', '-m', 'wip: 설정');
    expect(await r.cat.preparePush('T-1', 'push', 'test')).toMatchObject({ ok: false, message: expect.stringContaining('비밀 정보') });
    expect(pushApproval(r)).toBeUndefined();
    expect(gitEvents(r).at(-1)).toMatchObject({ ok: false, stage: 'checks' });
  });

  it('승인 뒤에 비밀 정보가 들어와도 실행 직전 다시 검사해서 막는다', async () => {
    const r = await rig();
    await r.cat.preparePush('T-1', 'push', 'test');
    writeFileSync(join(r.wt, 'late.txt'), 'token=ghp_' + 'a'.repeat(36) + '\n'); // 커밋하지 않은 변경
    await approveAndRun(r, 'feature');
    expect(git(r.bare, 'branch', '--list')).not.toContain('feature/T1');
    expect(gitEvents(r).at(-1)).toMatchObject({ ok: false, stage: 'push' });
  });

  it('gitleaks가 없으면 푸시하지 않는다 (실패하면 닫힘)', async () => {
    const r = await rig({ gitleaksBin: 'definitely-not-gitleaks-xyz' });
    expect(await r.cat.preparePush('T-1', 'push', 'test')).toMatchObject({ ok: false, message: expect.stringContaining('gitleaks를 실행하지 못해') });
  });

  it('큰 파일이 있으면 막는다', async () => {
    const r = await rig({ maxFileMB: 1 });
    writeFileSync(join(r.wt, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 7));
    git(r.wt, 'add', 'big.bin');
    git(r.wt, 'commit', '-q', '-m', 'wip: big');
    expect(await r.cat.preparePush('T-1', 'push', 'test')).toMatchObject({ ok: false, message: expect.stringContaining('big.bin') });
  });

  it('리뷰를 통과하지 않았거나 테스트가 실패하면 경고만 붙이고 버튼은 올린다', async () => {
    const r = await rig();
    r.testsPass.value = false;
    expect(await r.cat.preparePush('T-1', 'push', 'test')).toMatchObject({ ok: true });
    const a = pushApproval(r)!;
    expect(a.summary).toContain('⚠ 리뷰');
    expect(a.summary).toContain('⚠ 테스트 재실행');
  });
});

describe('main 직접 병합', () => {
  it('최신 main 위로 rebase → 합친 상태 테스트 → 백업 브랜치 → fast-forward 푸시', async () => {
    const r = await rig();
    // 그사이 다른 사람이 main에 다른 파일을 올렸다
    const other = join(r.s.root, 'other');
    git(r.s.root, 'clone', '-q', r.bare, other);
    git(other, 'config', 'user.email', 'o@localhost');
    git(other, 'config', 'user.name', 'o');
    writeFileSync(join(other, 'docs.txt'), 'docs\n');
    git(other, 'add', 'docs.txt');
    git(other, 'commit', '-q', '-m', 'docs');
    git(other, 'push', '-q', 'origin', 'main');
    const mainBefore = git(r.bare, 'rev-parse', 'main');

    await r.cat.preparePush('T-1', 'push', 'test');
    await approveAndRun(r, 'main');
    const log = git(r.bare, 'log', 'main', '--format=%s', '-n', '3').split('\n');
    expect(log).toEqual(['feat(demo): 기능 구현 추가 (T-1)', 'docs', 'init']); // 일직선
    expect(git(r.repo, 'rev-parse', `${git(r.repo, 'branch', '--list', 'backup/main-*', '--format=%(refname:short)')}`)).toBe(mainBefore);
    expect(gitEvents(r).at(-1)).toMatchObject({ ok: true, target: 'main', test: 'passed' });
  });

  it('충돌하면 푸시하지 않고 알린다. 티켓 상태는 바꾸지 않는다', async () => {
    const r = await rig();
    writeFileSync(join(r.wt, 'app.txt'), 'line 1 from ticket\n');
    git(r.wt, 'commit', '-q', '-am', 'wip: app');
    const other = join(r.s.root, 'other');
    git(r.s.root, 'clone', '-q', r.bare, other);
    git(other, 'config', 'user.email', 'o@localhost');
    git(other, 'config', 'user.name', 'o');
    writeFileSync(join(other, 'app.txt'), 'line 1 from main\n');
    git(other, 'commit', '-q', '-am', 'main change');
    git(other, 'push', '-q', 'origin', 'main');
    const mainBefore = git(r.bare, 'rev-parse', 'main');
    const statusBefore = ticket(r.s, 'T-1').status;

    await r.cat.preparePush('T-1', 'push', 'test');
    await approveAndRun(r, 'main');
    expect(git(r.bare, 'rev-parse', 'main')).toBe(mainBefore);
    expect(gitEvents(r).at(-1)).toMatchObject({ ok: false, stage: 'main-merge', reason: expect.stringContaining('충돌') });
    expect(ticket(r.s, 'T-1').status).toBe(statusBefore);
    expect(git(r.wt, 'status', '--porcelain')).toBe(''); // rebase를 되돌려 깨끗하다
  });

  it('합친 상태에서 테스트가 실패하면 푸시하지 않는다', async () => {
    const r = await rig();
    await r.cat.preparePush('T-1', 'push', 'test');
    r.testsPass.value = false;
    const mainBefore = git(r.bare, 'rev-parse', 'main');
    await approveAndRun(r, 'main');
    expect(git(r.bare, 'rev-parse', 'main')).toBe(mainBefore);
    expect(gitEvents(r).at(-1)).toMatchObject({ ok: false, reason: expect.stringContaining('테스트가 실패') });
  });
});

describe('되돌리기', () => {
  it('main의 티켓 커밋을 지우지 않고 반대로 되돌리는 커밋을 새로 만든다', async () => {
    const r = await rig();
    await r.cat.preparePush('T-1', 'push', 'test');
    await approveAndRun(r, 'main');
    const merged = git(r.bare, 'rev-parse', 'main');

    expect(await r.cat.preparePush('T-1', 'revert', 'CEO /되돌리기')).toMatchObject({ ok: true });
    const a = r.s.db.select().from(approvals).where(eq(approvals.kind, 'revert')).get()!;
    r.s.engine.decide({ approvalId: a.id, discordUserId: CEO, decision: 'approved', choice: 'main' });
    await r.cat.tick();
    const log = git(r.bare, 'log', 'main', '--format=%H %s', '-n', '2').split('\n');
    expect(log[0]).toContain('Revert "feat(demo): 기능 구현 추가 (T-1)"');
    expect(log[1]!.startsWith(merged)).toBe(true); // 원래 커밋은 남아 있다
    expect(git(r.bare, 'ls-tree', '--name-only', 'main').split(/\r?\n/)).not.toContain('feature.txt'); // 티켓이 더한 파일이 사라졌다
  }, 30_000);

  it('main에 그 티켓 커밋이 없으면 버튼을 올리지 않는다', async () => {
    const r = await rig();
    expect(await r.cat.preparePush('T-1', 'revert', 'test')).toMatchObject({ ok: false, message: expect.stringContaining('찾지 못했어요') });
    expect(r.s.db.select().from(approvals).where(eq(approvals.kind, 'revert')).all()).toHaveLength(0);
  });
});

// --- 프로젝트 통합 브랜치 (11장, 2026-10-23 CEO 결정) ------------------------------------

const INTEG = 'integration/demo';
/** 합친 상태에서 돌리는 프로젝트 테스트: BROKEN 파일이 있으면 실패 */
const INTEGRATION_TEST = `node -e "process.exit(require('fs').existsSync('BROKEN') ? 1 : 0)"`;

async function integrationRig(opts: { resolveConflict?: GitCatDeps['resolveConflict'] } = {}): Promise<Rig> {
  const r = await rig(opts);
  r.s.db.update(projects).set({ testCommand: INTEGRATION_TEST }).where(eq(projects.id, 'demo')).run();
  expect(await r.cat.integrateDone()).toBe(0); // 처음 켠 시각을 남긴다. 그 뒤에 끝난 티켓만 합친다
  return r;
}

/** 티켓을 끝낸다(검토를 통과해 done이 된 것과 같다). 끝난 순서대로 합치므로 시각을 1분씩 민다 */
function finish(r: Rig, id: string): void {
  r.s.clock.advance(60_000);
  r.s.db.$client.prepare(`UPDATE tickets SET status = 'done', finished_at = ? WHERE id = ?`).run(r.s.clock.now().toISOString(), id);
}

/** 같은 프로젝트의 두 번째 티켓과 그 worktree */
async function secondTicket(r: Rig): Promise<{ id: string; wt: string }> {
  const { tickets: [tk] } = await approvedTickets(r.s, '두 번째 기능도 추가해줘');
  const { path } = await new GitWorkspace(r.s.ctx).ensureWorktree(tk!);
  git(path, 'config', 'user.email', 'dev@localhost');
  git(path, 'config', 'user.name', 'dev');
  return { id: tk!.id, wt: path };
}

function commitFile(wt: string, file: string, text: string): void {
  writeFileSync(join(wt, file), text);
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', `wip: ${file}`);
}

/** 두 티켓이 같은 줄을 고친다. T-2는 통합 브랜치가 생기기 전에 main에서 시작한다 */
async function conflictingTickets(r: Rig): Promise<string> {
  const t2 = await secondTicket(r);
  commitFile(r.wt, 'app.txt', 'line 1 from T-1\n');
  commitFile(t2.wt, 'app.txt', 'line 1 from T-2\n');
  finish(r, 'T-1');
  finish(r, t2.id);
  return t2.id;
}

describe('프로젝트 통합 브랜치 (11장, 2026-10-23)', () => {
  it('끝난 티켓을 로컬 통합 브랜치에 정해진 형식의 커밋 하나로 합친다. 원격에는 아무것도 보내지 않는다', async () => {
    const r = await integrationRig();
    writeFileSync(join(r.wt, 'notes.txt'), 'GPT 개발자는 커밋하지 않는다\n'); // 커밋하지 않은 변경도 담는다
    finish(r, 'T-1');
    const mainBefore = git(r.bare, 'rev-parse', 'main');

    expect(await r.cat.integrateDone()).toBe(1);
    expect(git(r.repo, 'log', INTEG, '--format=%s|%an', '-n', '2').split('\n')).toEqual(['feat(demo): 기능 구현 추가 (T-1)|Git 고양이', 'init|owner']);
    expect(git(r.repo, 'log', INTEG, '-n', '1', '--format=%B')).toContain('AI-Office-Ticket: T-1');
    expect(git(r.repo, 'ls-tree', '--name-only', INTEG).split(/\r?\n/)).toEqual(expect.arrayContaining(['feature.txt', 'notes.txt']));
    const commit = r.s.db.select().from(events).all().filter((e) => e.type === 'git.commit').at(-1)?.payload;
    expect(commit).toMatchObject({ ticketId: 'T-1', target: INTEG });

    // 원격 git은 한 번도 쓰지 않았다: 토큰도, fetch·push도 없다
    expect(r.runs.filter((x) => (x.bin === 'git' && ['fetch', 'ls-remote', 'push', 'clone'].includes(x.args[0]!)) || x.privilegedEnv)).toEqual([]);
    expect(git(r.bare, 'rev-parse', 'main')).toBe(mainBefore);
    expect(git(r.bare, 'branch', '--list')).not.toContain('integration');

    expect(await r.cat.integrateDone()).toBe(0); // 이미 합친 티켓은 다시 합치지 않는다
  });

  it('같은 프로젝트의 새 티켓은 통합 브랜치에서 시작해 앞 티켓 결과를 이어받는다. 리뷰 diff와 푸시 커밋에는 자기 변경만 들어간다', async () => {
    const r = await integrationRig();
    finish(r, 'T-1');
    await r.cat.integrateDone();
    const t2 = await secondTicket(r);
    expect(readFileSync(join(t2.wt, 'feature.txt'), 'utf8')).toContain('step 2'); // T-1 결과

    commitFile(t2.wt, 'second.txt', 'two\n');
    const diff = await new GitWorkspace(r.s.ctx).reviewDiff(ticket(r.s, t2.id));
    expect(diff).toContain('second.txt');
    expect(diff).not.toContain('feature.txt');

    expect(await r.cat.preparePush(t2.id, 'push', 'CEO /push')).toMatchObject({ ok: true });
    expect(pushApproval(r)!.summary).toContain('커밋 1개');
    await approveAndRun(r, 'feature');
    const branch = ticket(r.s, t2.id).branch!;
    expect(git(r.bare, 'diff', '--name-only', `${branch}~1`, branch)).toBe('second.txt');
    expect(git(r.bare, 'log', branch, '--format=%s', '-n', '3').split('\n')).toEqual(['feat(demo): 기능 구현 추가 (T-2)', 'feat(demo): 기능 구현 추가 (T-1)', 'init']);
  });

  it('충돌은 병합 담당이 통합 작업 폴더 안에서 풀고, 코드가 확인한 뒤 커밋 하나로 합친다', async () => {
    const asked: ConflictRequest[] = [];
    const r = await integrationRig({
      resolveConflict: async (req) => {
        asked.push(req);
        writeFileSync(join(req.workdir, 'app.txt'), 'line 1 from T-1 and T-2\n');
        return 'resolved';
      },
    });
    const t2 = await conflictingTickets(r);

    expect(await r.cat.integrateDone()).toBe(2);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ ticket: { id: t2 }, files: ['app.txt'], workdir: integrationPathFor(r.s.config.paths.wt, 'demo') });
    expect(isInside(r.s.config.paths.wt, asked[0]!.workdir)).toBe(true);
    expect(git(r.repo, 'show', `${INTEG}:app.txt`)).toBe('line 1 from T-1 and T-2');
    expect(git(r.repo, 'log', INTEG, '--format=%s', '-n', '3').split('\n')).toEqual(['feat(demo): 기능 구현 추가 (T-2)', 'feat(demo): 기능 구현 추가 (T-1)', 'init']);
  });

  it('충돌 표시가 남으면 합치지 않고 되돌린 뒤 #막힘에 알린다. 그 티켓은 다시 시도하지 않는다', async () => {
    let calls = 0;
    // 아무것도 고치지 않고 풀었다고만 말한다
    const r = await integrationRig({ resolveConflict: async () => (calls++, 'resolved') });
    const t2 = await conflictingTickets(r);

    expect(await r.cat.integrateDone()).toBe(2);
    expect(git(r.repo, 'log', INTEG, '--format=%s', '-n', '1')).toContain('(T-1)');
    expect(gitEvents(r).at(-1)).toMatchObject({ ticketId: t2, ok: false, stage: 'integrate', reason: expect.stringContaining('충돌 표시') });
    expect(git(integrationPathFor(r.s.config.paths.wt, 'demo'), 'status', '--porcelain')).toBe('');
    expect(await r.cat.integrateDone()).toBe(0);
    expect(calls).toBe(1);
  });

  it('합친 상태에서 테스트가 실패하면 통합 브랜치를 되돌린다', async () => {
    const r = await integrationRig();
    commitFile(r.wt, 'BROKEN', 'x\n');
    finish(r, 'T-1');

    expect(await r.cat.integrateDone()).toBe(1);
    expect(git(r.repo, 'rev-parse', INTEG)).toBe(git(r.repo, 'rev-parse', 'main'));
    expect(gitEvents(r).at(-1)).toMatchObject({ ticketId: 'T-1', ok: false, stage: 'integrate', reason: expect.stringContaining('테스트가 실패') });
  });

  it('병합 담당을 기다려야 하면(개발 몫·연결) 되돌려 두고 다음 바퀴에 다시 한다', async () => {
    const answers: ('wait' | 'resolved')[] = ['wait', 'resolved'];
    const r = await integrationRig({
      resolveConflict: async (req) => {
        const a = answers.shift()!;
        if (a === 'resolved') writeFileSync(join(req.workdir, 'app.txt'), 'merged\n');
        return a;
      },
    });
    await conflictingTickets(r);

    expect(await r.cat.integrateDone()).toBe(1); // T-1만. T-2는 기다린다
    expect(git(integrationPathFor(r.s.config.paths.wt, 'demo'), 'status', '--porcelain')).toBe('');
    expect(gitEvents(r).filter((e) => e.stage === 'integrate')).toHaveLength(0);
    expect(await r.cat.integrateDone()).toBe(1);
    expect(git(r.repo, 'show', `${INTEG}:app.txt`)).toBe('merged');
  });

  it('병합 담당은 개발팀장(Claude)이고 통합 작업 폴더에서만 쓰기 권한을 받는다. 개발 몫이 없으면 기다리고, 형식 오류면 실패', async () => {
    const s = setup();
    const workdir = integrationPathFor(s.config.paths.wt, 'demo');
    const req: ConflictRequest = { ticket: { id: 'T-1', title: '기능', type: 'coding', acceptanceCriteria: ['단위 테스트 통과'] }, files: ['app.txt'], workdir };
    expect(await s.engine.resolveMerge(req)).toBe('resolved');
    const call: BrainRequest = s.mock.callsFor('merge')[0]!;
    expect(call.employee.id).toBe(MERGE_RESOLVER_ID);
    expect(call.workdir).toBe(workdir);
    expect(claudeProfileFor(call)).toBe('dev-work');
    // GPT 개발자는 merge 일로는 쓰기를 받지 않는다 (7장 7-3: 쓰기는 자기 티켓 worktree의 work만)
    const devA = s.db.select().from(employees).where(eq(employees.id, 'dev-a')).get()!;
    expect(codexSandboxFor({ employee: devA, task: 'merge', workdir, ticketId: 'T-1' }, s.config.paths.wt)).toBe('read-only');

    blockBudget(s.ctx, 'dev');
    expect(await s.engine.resolveMerge(req)).toBe('wait');
    expect(s.mock.callsFor('merge')).toHaveLength(1);

    const bad = setup({ handlers: { merge: () => ({ nope: true }) } });
    expect(await bad.engine.resolveMerge(req)).toBe('failed');
  });
});
