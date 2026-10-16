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
import { GitCat } from '../src/gitcat/git-cat.ts';
import { approvals, events, projects } from '../src/db/schema.ts';
import { GitWorkspace } from '../src/workspace/worktrees.ts';
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
async function rig(opts: { maxFileMB?: number; gitleaksBin?: string } = {}): Promise<Rig> {
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
    writeFileSync(join(r.wt, 'config.txt'), 'aws=AKIAABCDEFGHIJKLMNOP\n');
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
