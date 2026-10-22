import { getState, type Ctx } from '../context.ts';

export const PROJECT_CHANNELS = {
  work: { name: '작업', topic: '/지시로 업무를 맡기거나 담당 직원을 불러 대화하는 곳' },
  planning: { name: '기획', topic: 'PM과 요구사항을 확인하고 질문·답변을 나누는 곳' },
  todo: { name: '할일', topic: '담당 AI의 작업 착수, 재작업, 검토 진행 소식' },
  approvals: { name: '결재함', topic: 'PM 계획서와 Git 고양이의 푸시 요청을 결재하는 곳' },
  completed: { name: '완료', topic: '담당 AI의 작업 완료 보고와 Git 고양이의 푸시 결과' },
  blocked: { name: '막힘', topic: '담당 AI가 추가 방향이나 도움을 요청하는 곳' },
  mirror: { name: '사무실-대화', topic: '이 프로젝트에 참여한 AI들의 작업 대화와 검토 기록' },
} as const;
export type ProjectChannelKind = keyof typeof PROJECT_CHANNELS;
export type ProjectChannelMap = Partial<Record<ProjectChannelKind, string>>;
export const projectChannelsKey = (projectId: string) => `discord.projectChannels:${projectId}`;
export const projectChannelsOf = (c: Ctx, projectId: string): ProjectChannelMap => getState(c, projectChannelsKey(projectId), {});
export const projectChannel = (c: Ctx, projectId: string | null | undefined, kind: ProjectChannelKind): string | undefined => projectId ? projectChannelsOf(c, projectId)[kind] : undefined;

/** 현재 서버 목록을 읽고 없는 채널만 만든다. Discord 어댑터와 가짜 서버가 같은 규칙을 쓴다. */
export async function ensureProjectChannels(port: {
  list(): Promise<{ id: string; name: string; parentId: string | null; category: boolean }[]>;
  category(name: string): Promise<string>;
  text(name: string, categoryId: string, topic: string): Promise<string>;
}, projectId: string, existing: { categoryId?: string | null; channelId?: string | null } = {}): Promise<{ categoryId: string; channelId: string; channels: ProjectChannelMap }> {
  const all = await port.list();
  const categoryId = all.find((ch) => ch.category && ch.id === existing.categoryId)?.id
    ?? all.find((ch) => ch.category && ch.name === projectId)?.id
    ?? await port.category(projectId);
  const channels: ProjectChannelMap = {};
  for (const [kind, spec] of Object.entries(PROJECT_CHANNELS) as [ProjectChannelKind, (typeof PROJECT_CHANNELS)[ProjectChannelKind]][]) {
    const savedWork = kind === 'work' ? all.find((ch) => !ch.category && ch.id === existing.channelId && ch.parentId === categoryId) : undefined;
    channels[kind] = savedWork?.id ?? all.find((ch) => !ch.category && ch.parentId === categoryId && ch.name === spec.name)?.id
      ?? await port.text(spec.name, categoryId, `${projectId} · ${spec.topic}`);
  }
  return { categoryId, channelId: channels.work!, channels };
}
