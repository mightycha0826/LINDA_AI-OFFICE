// /새프로젝트 (11장 새 프로젝트 만들기, 9장 프로젝트 채널, 6장 PM 프로젝트 고정).
// GitHub 저장소는 항상 비공개, 토큰은 그 요청에만. 프로젝트 #작업에서 쓴 /지시는 그 프로젝트 일이 된다.
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { planOutput } from '../src/brains/mock.ts';
import { checkPlanRules } from '../src/core/plans.ts';
import { orders, plans, projects } from '../src/db/schema.ts';
import { InteractionHandler } from '../src/discord/interactions.ts';
import type { DiscordPort, OutgoingMessage, ProjectChannelPort } from '../src/discord/types.ts';
import { GitCat } from '../src/gitcat/git-cat.ts';
import { createGithubRepo, NEW_REPO_PRIVATE } from '../src/gitcat/github-repo.ts';
import { NewProjectService } from '../src/workspace/new-project.ts';
import { registerProject } from '../src/workspace/projects.ts';
import { CEO, pendingPlanApproval, setup, STRANGER, type Setup } from './helpers.ts';

const TOKEN = 'github_pat_' + 'x'.repeat(40);

function fakeGithub(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const created = (name: string) => ({ clone_url: `https://github.com/owner/${name}.git`, html_url: `https://github.com/owner/${name}`, default_branch: 'main' });

describe('GitHub 저장소 만들기', () => {
  it('항상 비공개, README 첫 커밋, 토큰은 이 요청 헤더에만', async () => {
    const gh = fakeGithub(201, created('todo-app'));
    const repo = await createGithubRepo({ token: TOKEN, name: 'todo-app', description: '할 일 앱', fetchImpl: gh.fetchImpl });
    expect(repo).toEqual({ repoUrl: 'https://github.com/owner/todo-app.git', htmlUrl: 'https://github.com/owner/todo-app', defaultBranch: 'main' });
    expect(NEW_REPO_PRIVATE).toBe(true);
    const [call] = gh.calls;
    expect(call!.url).toBe('https://api.github.com/user/repos');
    expect(call!.init.method).toBe('POST');
    expect(JSON.parse(String(call!.init.body))).toEqual({ name: 'todo-app', private: true, auto_init: true, description: '할 일 앱' });
    expect((call!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(String(call!.init.body)).not.toContain(TOKEN);
  });

  it('이름 규칙에 맞지 않으면 GitHub에 묻지도 않는다', async () => {
    const gh = fakeGithub(201, created('x'));
    for (const name of ['../evil', 'Todo', 'a b', '', '-x', 'owner/repo']) {
      await expect(createGithubRepo({ token: TOKEN, name, fetchImpl: gh.fetchImpl })).rejects.toThrow(/영문 소문자/);
    }
    expect(gh.calls).toHaveLength(0);
  });

  it('같은 이름이 있으면(422) /프로젝트로 등록하라고, 권한이 없으면(401·403) 토큰을 확인하라고. 토큰은 메시지에 없다', async () => {
    const exists = fakeGithub(422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] });
    await expect(createGithubRepo({ token: TOKEN, name: 'todo', fetchImpl: exists.fetchImpl })).rejects.toThrow(/\/프로젝트로 등록/);
    const denied = fakeGithub(403, { message: 'Resource not accessible by personal access token' });
    const err = (await createGithubRepo({ token: TOKEN, name: 'todo', fetchImpl: denied.fetchImpl }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain('Administration');
    expect(err.message).not.toContain(TOKEN);
  });

  it('Git 고양이는 토큰이 없으면 저장소를 만들지 않는다', async () => {
    const s = setup();
    const gh = fakeGithub(201, created('todo'));
    const cat = new GitCat({ c: s.ctx, tests: { run: async () => ({ passed: true, summary: '' }) }, githubToken: () => undefined, fetchImpl: gh.fetchImpl });
    await expect(cat.createRepo('todo')).rejects.toThrow(/토큰이 없어요/);
    expect(gh.calls).toHaveLength(0);
  });
});

/** 가짜 Git 고양이·Discord: 부른 순서를 남긴다 */
function office(over: { channels?: ProjectChannelPort | null } = {}) {
  const s = setup();
  const trail: string[] = [];
  const sent: OutgoingMessage[] = [];
  const channelPosts: { channelId: string; content: string }[] = [];
  const gitcat = {
    async createRepo(name: string) {
      trail.push(`repo:${name}`);
      return { repoUrl: `https://github.com/owner/${name}.git`, htmlUrl: `https://github.com/owner/${name}`, defaultBranch: 'main' };
    },
    async registerAndClone(p: { id: string; repoUrl: string; testCommand: string; defaultBranch?: string }) {
      trail.push(`clone:${p.id}:${p.testCommand}`);
      registerProject(s.ctx, { ...p, localPath: join(s.config.paths.repos, p.id) });
      return 'ok';
    },
  };
  let seq = 0;
  const channels: ProjectChannelPort = {
    async createProjectChannels(id) {
      trail.push(`channels:${id}`);
      seq++;
      return { categoryId: `70000000000000000${seq}`, channelId: `80000000000000000${seq}` };
    },
    async sendToChannel(channelId, content) {
      channelPosts.push({ channelId, content });
    },
  };
  const discord: DiscordPort = {
    async send(m) {
      sent.push(m);
      return { messageId: '1', url: 'u' };
    },
    async edit() {},
  };
  const svc = new NewProjectService({ c: s.ctx, gitcat, channels: () => (over.channels === undefined ? channels : over.channels), discord: () => discord });
  return { ...s, svc, trail, sent, channelPosts };
}

const project = (s: Setup, id: string) => s.db.select().from(projects).where(eq(projects.id, id)).get();

describe('/새프로젝트', () => {
  it('저장소 만들기 → 받기·등록 → 카테고리·#작업 → 안내 순서로 하고 채널을 프로젝트에 적는다', async () => {
    const s = office();
    const msg = await s.svc.create({ id: 'todo-app', description: '할 일 앱' });
    expect(s.trail).toEqual(['repo:todo-app', 'clone:todo-app:npm test', 'channels:todo-app']);
    expect(project(s, 'todo-app')).toMatchObject({ repoUrl: 'https://github.com/owner/todo-app.git', discordChannelId: '800000000000000001', discordCategoryId: '700000000000000001' });
    expect(s.channelPosts).toEqual([{ channelId: '800000000000000001', content: expect.stringContaining('/지시') }]);
    expect(s.channelPosts[0]!.content).toContain('비공개');
    expect(msg).toContain('<#800000000000000001>');
  });

  it('테스트 명령을 주면 그것으로 등록한다', async () => {
    const s = office();
    await s.svc.create({ id: 'api', testCommand: 'pnpm test' });
    expect(s.trail).toContain('clone:api:pnpm test');
  });

  it('잘못된 아이디나 이미 등록된 아이디는 GitHub에 가기 전에 거부한다', async () => {
    const s = office();
    await expect(s.svc.create({ id: 'Bad Name' })).rejects.toThrow(/영문 소문자/);
    await s.svc.create({ id: 'todo' });
    s.trail.length = 0;
    await expect(s.svc.create({ id: 'todo' })).rejects.toThrow(/이미 있는 프로젝트/);
    expect(s.trail).toEqual([]);
  });

  it('Discord 단계가 실패했으면 다시 쓸 때 채널만 만든다 (저장소를 두 번 만들지 않음)', async () => {
    const down = office({ channels: null });
    await expect(down.svc.create({ id: 'todo' })).rejects.toThrow(/채널만 만들어요/);
    expect(project(down, 'todo')).toMatchObject({ discordChannelId: null });
    // 같은 DB로, Discord가 연결된 뒤 다시
    const trail: string[] = [];
    const retry = new NewProjectService({
      c: down.ctx,
      gitcat: { createRepo: async () => (trail.push('repo'), Promise.reject(new Error('두 번 만들면 안 됨'))), registerAndClone: async () => (trail.push('clone'), 'x') },
      channels: () => ({ createProjectChannels: async () => (trail.push('channels'), { categoryId: '700000000000000009', channelId: '800000000000000009' }), sendToChannel: async () => {} }),
      discord: () => null,
    });
    await retry.create({ id: 'todo' });
    expect(trail).toEqual(['channels']);
    expect(project(down, 'todo')!.discordChannelId).toBe('800000000000000009');
  });

  it('뒤에서 돌다 실패하면 #막힘에 단계와 이유를 올린다', async () => {
    const s = setup();
    const sent: OutgoingMessage[] = [];
    await new NewProjectService({
      c: s.ctx,
      gitcat: { createRepo: async () => Promise.reject(new Error('GitHub 저장소 만들기 실패(500)')), registerAndClone: async () => 'x' },
      channels: () => null,
      discord: () => ({ send: async (m) => (sent.push(m), { messageId: '1', url: 'u' }), edit: async () => {} }),
    }).run({ id: 'todo' });
    expect(sent).toEqual([{ channel: 'blocked', content: expect.stringContaining('GitHub 저장소 만들기 단계에서 멈췄어요') }]);
    expect(project(s, 'todo')).toBeUndefined();
  });
});

describe('프로젝트 #작업 채널의 /지시', () => {
  async function withChannel() {
    const s = office();
    await s.svc.create({ id: 'todo' });
    const runs: string[] = [];
    const handler = new InteractionHandler(s.ctx, s.engine, () => {}, null, { run: async (i: { id: string }) => void runs.push(i.id) } as unknown as NewProjectService);
    const cmd = (name: string, options: Record<string, string>, channelId: string, id: string, userId = CEO) => handler.handle({ type: 'command', userId, name, options, id, channelId });
    return { ...s, handler, runs, cmd, channelId: project(s, 'todo')!.discordChannelId! };
  }

  it('#작업에서 쓴 지시는 그 프로젝트로 고정되고, 다른 채널의 지시는 고정되지 않는다', async () => {
    const s = await withChannel();
    await s.cmd('지시', { 내용: '로그인 기능 추가해줘' }, s.channelId, '1300000000000000201');
    await s.cmd('지시', { 내용: '마케팅 문구 써줘' }, '900000000000000001', '1300000000000000202');
    const all = s.db.select().from(orders).orderBy(orders.id).all();
    expect(all.map((o) => [o.rawText, o.projectId])).toEqual([
      ['로그인 기능 추가해줘', 'todo'],
      ['마케팅 문구 써줘', null],
    ]);
  });

  it('/새프로젝트는 CEO만, 뒤에서 돌린다', async () => {
    const s = await withChannel();
    expect(await s.cmd('새프로젝트', { 아이디: 'blog' }, s.channelId, '1300000000000000203', STRANGER)).toEqual({ kind: 'ignore' });
    const reply = await s.cmd('새프로젝트', { 아이디: 'blog' }, s.channelId, '1300000000000000204');
    expect(reply).toMatchObject({ kind: 'reply', content: expect.stringContaining('만드는 중') });
    expect(s.runs).toEqual(['blog']);
  });

  it('PM에게는 그 프로젝트만 보여 주고, projectId를 비우면 코드가 채운다. 승인해도 지시의 프로젝트는 남는다', async () => {
    const s = setup({ handlers: { plan: () => planOutput({ projectId: undefined }) } });
    registerProject(s.ctx, { id: 'todo', repoUrl: 'https://github.com/owner/todo.git', localPath: join(s.config.paths.repos, 'todo'), testCommand: 'npm test' });
    const { order } = s.engine.submitOrder({ discordMessageId: '1300000000000000301', rawText: '로그인 기능 추가해줘', projectId: 'todo' });
    await s.engine.runUntilIdle();
    const input = s.mock.callsFor('plan')[0]!.input as { projects: { id: string }[]; fixedProjectId: string };
    expect(input.projects.map((p) => p.id)).toEqual(['todo']); // demo는 보이지 않는다
    expect(input.fixedProjectId).toBe('todo');
    expect(s.db.select().from(plans).where(eq(plans.orderId, order.id)).get()!.projectId).toBe('todo');
    const approval = pendingPlanApproval(s)!;
    s.engine.decide({ approvalId: approval.id, discordUserId: CEO, decision: 'approved' });
    expect(s.db.select().from(orders).where(eq(orders.id, order.id)).get()!.projectId).toBe('todo');
  });

  it('프로젝트가 고정된 지시에 다른 프로젝트를 고르면 규칙 위반', () => {
    const s = setup();
    registerProject(s.ctx, { id: 'todo', repoUrl: 'https://github.com/owner/todo.git', localPath: join(s.config.paths.repos, 'todo'), testCommand: 'npm test' });
    expect(checkPlanRules(s.ctx, planOutput({ projectId: 'demo' }), 'todo')).toEqual([expect.stringContaining('todo 프로젝트 채널')]);
    expect(checkPlanRules(s.ctx, planOutput({ projectId: undefined }), 'todo')).toEqual([]);
    expect(checkPlanRules(s.ctx, planOutput({ projectId: 'todo' }), 'todo')).toEqual([]);
    // 고정되지 않은 지시는 예전 규칙 그대로
    expect(checkPlanRules(s.ctx, planOutput({ projectId: undefined }))).toEqual([expect.stringContaining('projectId')]);
  });
});
