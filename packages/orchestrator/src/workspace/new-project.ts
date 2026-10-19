// /새프로젝트 (11장 새 프로젝트 만들기, 9장 프로젝트 채널).
// GitHub 비공개 저장소 만들기 → repos\<아이디>로 받아 등록 → Discord 카테고리 <아이디> › #작업 → 안내.
// 저장소는 만들었는데 Discord 단계가 실패했으면, 다시 부를 때 채널만 만든다(저장소를 두 번 만들지 않음).
import type { Ctx } from '../context.ts';
import type { DiscordPort, ProjectChannelPort } from '../discord/types.ts';
import { OfficeError } from '../errors.ts';
import type { CreatedRepo } from '../gitcat/github-repo.ts';
import { findProject, setProjectChannel, validateProjectId } from './projects.ts';

export interface NewProjectInput {
  id: string;
  testCommand?: string;
  description?: string;
}

export interface NewProjectDeps {
  c: Ctx;
  gitcat: {
    createRepo(name: string, description?: string): Promise<CreatedRepo>;
    registerAndClone(p: { id: string; repoUrl: string; testCommand: string; defaultBranch?: string }): Promise<string>;
  };
  /** Discord가 연결되기 전에는 null (main.ts가 봇을 띄운 뒤 채운다) */
  channels: () => ProjectChannelPort | null;
  discord: () => DiscordPort | null;
  log?: (s: string) => void;
}

export const DEFAULT_TEST_COMMAND = 'npm test';

export class NewProjectService {
  private readonly d: NewProjectDeps;

  constructor(d: NewProjectDeps) {
    this.d = d;
  }

  /** 명령 처리에서 뒤로 돌린다. 실패하면 #막힘에 단계와 이유를 올린다 */
  async run(input: NewProjectInput): Promise<void> {
    try {
      // log?.(await …)로 쓰면 log가 없을 때 create 자체가 돌지 않는다
      const done = await this.create(input);
      this.d.log?.(done);
    } catch (err) {
      const text = `**/새프로젝트 ${input.id} 실패**: ${(err as Error).message}`;
      this.d.log?.(text);
      await this.d.discord()?.send({ channel: 'blocked', content: text }).catch(() => undefined);
    }
  }

  async create(input: NewProjectInput): Promise<string> {
    const c = this.d.c;
    const id = input.id.trim();
    const existing = findProject(c, id);
    if (existing?.discordChannelId) throw new OfficeError('project', `이미 있는 프로젝트예요. <#${existing.discordChannelId}>에서 /지시를 쓰세요`);

    let repoLine: string;
    if (existing) {
      // 지난번에 저장소 단계까지만 끝났다. 채널만 만든다
      repoLine = `저장소: ${existing.repoUrl.replace(/\.git$/, '')} (이미 등록됨)`;
    } else {
      validateProjectId(c, id);
      const repo = await step('GitHub 저장소 만들기', () => this.d.gitcat.createRepo(id, input.description?.trim() || undefined));
      const testCommand = input.testCommand?.trim() || DEFAULT_TEST_COMMAND;
      await step('저장소 받기·등록', () => this.d.gitcat.registerAndClone({ id, repoUrl: repo.repoUrl, testCommand, defaultBranch: repo.defaultBranch }));
      repoLine = `저장소: ${repo.htmlUrl} (비공개) · 테스트 명령: \`${testCommand}\``;
    }

    const channels = this.d.channels();
    if (!channels) throw new OfficeError('discord', 'Discord에 연결되지 않아 카테고리를 만들지 못했어요. 연결된 뒤 같은 명령을 다시 쓰면 채널만 만들어요');
    const ch = await step('Discord 카테고리·#작업 만들기', () => channels.createProjectChannels(id));
    setProjectChannel(c, id, ch);
    await step('안내 올리기', () =>
      channels.sendToChannel(
        ch.channelId,
        [`**${id}** 프로젝트 작업 공간이에요.`, repoLine, `여기서 \`/지시\`를 쓰면 이 저장소 일로 등록돼요. 결재·보고·막힘은 공용 채널에 올라오고, 계획서 제목에 \`[${id}]\`가 붙어요.`].join('\n'),
      ),
    );
    return `${id} 프로젝트를 만들었어요 (<#${ch.channelId}>)`;
  }
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new OfficeError('new-project', `${name} 단계에서 멈췄어요: ${(err as Error).message}`);
  }
}
