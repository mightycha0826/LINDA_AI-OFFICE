// 작업 공간 (7장 격리, 11장): 실제 git 저장소로 worktree 만들기·비밀 파일 검사·push 주소 잠금·테스트 실행기.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess } from '../src/brains/process.ts';
import { OfficeError } from '../src/errors.ts';
import { assertInside, isInside, worktreePathFor } from '../src/workspace/paths.ts';
import { getProject, registerProject } from '../src/workspace/projects.ts';
import { ProjectTestRunner } from '../src/workspace/test-runner.ts';
import { branchFor, GitWorkspace, PUSH_BLOCKED_URL, SecretInWorktreeError } from '../src/workspace/worktrees.ts';
import { approvedTickets, setup, ticket } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** helpers의 demo 프로젝트 자리에 실제 git 저장소를 만든다. */
function initRepo(s: ReturnType<typeof setup>, files: Record<string, string> = {}) {
  const repo = getProject(s.ctx, 'demo').localPath;
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@localhost');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/owner/demo.git');
  return repo;
}

describe('경로 격리', () => {
  it('작업 공간 밖, 상위 폴더 탈출, 다른 드라이브를 막는다', () => {
    expect(isInside('C:\\ai-office\\wt', 'C:\\ai-office\\wt\\T-1')).toBe(true);
    expect(isInside('C:\\ai-office\\wt', 'C:\\ai-office\\wt\\..\\repos')).toBe(false);
    expect(isInside('C:\\ai-office\\wt', 'D:\\ai-office\\wt\\T-1')).toBe(false);
    expect(isInside('C:\\ai-office\\wt', 'C:\\ai-office\\wt-evil\\T-1')).toBe(false);
    expect(() => assertInside('C:\\ai-office\\wt', 'C:\\ai-office\\wt', 'x')).toThrow(OfficeError);
    expect(() => worktreePathFor('C:\\ai-office\\wt', '..\\..\\Windows')).toThrow(OfficeError);
  });

  it('프로젝트는 repos 아래, GitHub 주소만 등록된다', () => {
    const s = setup();
    expect(() => registerProject(s.ctx, { id: 'x', repoUrl: 'https://github.com/a/b', localPath: 'C:\\Windows\\x', testCommand: 'npm test' })).toThrow(/repos/);
    expect(() => registerProject(s.ctx, { id: 'y', repoUrl: 'https://evil.example/a/b', localPath: join(s.config.paths.repos, 'y'), testCommand: 'npm test' })).toThrow(/GitHub/);
  });

  it('브랜치 이름: feature/T12-<짧은 설명>', () => {
    expect(branchFor({ id: 'T-12', title: 'Login API 추가' })).toBe('feature/T12-login-api');
    expect(branchFor({ id: 'T-3', title: '로그인 기능' })).toBe('feature/T3-work');
  });
});

describe('티켓 worktree', () => {
  it('<wt>\\T-1에 브랜치를 만들고, 권한 설정을 넣되 커밋되지 않게 하고, push 주소를 막는다', async () => {
    const s = setup();
    const repo = initRepo(s);
    const { tickets: [tk] } = await approvedTickets(s);
    const ws = new GitWorkspace(s.ctx);
    const { path, branch } = await ws.ensureWorktree(tk!);

    expect(path).toBe(join(s.config.paths.wt, 'T-1'));
    expect(branch).toBe('feature/T1-work');
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/T1-work');
    expect(ticket(s, tk!.id)).toMatchObject({ worktreePath: path, branch });
    // 권한 설정은 있고, git status에는 안 보인다
    expect(JSON.parse(readFileSync(join(path, '.claude', 'settings.json'), 'utf8')).permissions.deny).toContain('Bash(git push *)');
    expect(git(path, 'status', '--porcelain')).toBe('');
    // 등록 저장소의 push 주소가 막혀 있어 worktree에서 git push가 나가지 않는다
    expect(git(repo, 'config', 'remote.origin.pushurl')).toBe(PUSH_BLOCKED_URL);
    const push = await runProcess({ bin: 'git', args: ['push', 'origin', 'HEAD'], cwd: path, timeoutMs: 30_000 });
    expect(push.code).not.toBe(0);
    // 두 번 불러도 같은 worktree
    expect(await ws.ensureWorktree(ticket(s, tk!.id))).toEqual({ path, branch });
  });

  it('비밀 파일이 있으면 일을 시작하지 않는다 (.env.example은 괜찮다)', async () => {
    const s = setup();
    initRepo(s, { '.env': 'SECRET=1', '.env.example': 'SECRET=' });
    const { tickets: [tk] } = await approvedTickets(s);
    const err = await new GitWorkspace(s.ctx).ensureWorktree(tk!).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretInWorktreeError);
    expect((err as SecretInWorktreeError).files).toEqual(['.env']);
  });

  it('엔진: 비밀 파일 때문에 worktree를 못 쓰면 티켓을 멈추고(system-error) 이유를 남긴다', async () => {
    const s = setup();
    initRepo(s, { 'deploy.pem': 'key' });
    const { Engine } = await import('../src/engine.ts');
    const engine = new Engine({ ctx: s.ctx, brainFor: () => s.mock, tests: { run: async () => ({ passed: true, summary: '' }) }, workspace: new GitWorkspace(s.ctx), connectivity: s.engine.connectivity });
    const { tickets: [tk] } = await approvedTickets(s);
    await engine.runUntilIdle();
    expect(ticket(s, tk!.id)).toMatchObject({ status: 'paused', pauseReason: 'system-error' });
    expect(s.mock.callsFor('work')).toHaveLength(0);
  });

  it('리뷰어용 diff에는 커밋한 변경과 새 파일이 들어간다', async () => {
    const s = setup();
    initRepo(s);
    const { tickets: [tk] } = await approvedTickets(s);
    const ws = new GitWorkspace(s.ctx);
    const { path } = await ws.ensureWorktree(tk!);
    writeFileSync(join(path, 'a.ts'), 'export const a = 1;\n');
    git(path, 'add', 'a.ts');
    git(path, 'commit', '-q', '-m', 'wip: a');
    writeFileSync(join(path, 'b.ts'), 'export const b = 2;\n');
    const diff = await ws.reviewDiff(ticket(s, tk!.id));
    expect(diff).toContain('export const a = 1');
    expect(diff).toContain('b.ts');
    expect(diff).not.toContain('.claude');
  });

  it('worktree를 지워도 브랜치는 남는다 (4단계 Git 고양이가 푸시 뒤 부른다)', async () => {
    const s = setup();
    const repo = initRepo(s);
    const { tickets: [tk] } = await approvedTickets(s);
    const ws = new GitWorkspace(s.ctx);
    const { path, branch } = await ws.ensureWorktree(tk!);
    await ws.removeWorktree(ticket(s, tk!.id));
    expect(existsSync(path)).toBe(false);
    expect(git(repo, 'branch', '--list', branch)).toContain(branch);
  });
});

describe('오케스트레이터가 직접 돌리는 테스트', () => {
  it('등록된 testCommand를 worktree에서 돌린다. 개발자의 말이 아니라 종료 코드로 판정한다', async () => {
    const s = setup();
    initRepo(s, { 'check.js': "require('fs').existsSync('ok.txt') ? process.exit(0) : (console.log('ok.txt 없음'), process.exit(1));\n" });
    s.db.$client.prepare(`UPDATE projects SET test_command = 'node check.js' WHERE id = 'demo'`).run();
    const { tickets: [tk] } = await approvedTickets(s);
    const { path } = await new GitWorkspace(s.ctx).ensureWorktree(tk!);
    const runner = new ProjectTestRunner(s.ctx);
    const fail = await runner.run(tk!.id, new AbortController().signal);
    expect(fail).toMatchObject({ passed: false, summary: expect.stringContaining('ok.txt 없음') });
    writeFileSync(join(path, 'ok.txt'), '');
    expect(await runner.run(tk!.id, new AbortController().signal)).toMatchObject({ passed: true });
  });
});
