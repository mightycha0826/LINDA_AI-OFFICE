// 프로젝트 등록 (11장). 회사는 등록된 저장소만 건드린다. Discord 명령은 4단계에서 붙인다.
import { eq } from 'drizzle-orm';
import { inTx, type Ctx } from '../context.ts';
import { orders, projects } from '../db/schema.ts';
import { NotFoundError, OfficeError } from '../errors.ts';
import { isInside } from './paths.ts';

export type ProjectRow = typeof projects.$inferSelect;

export interface ProjectInput {
  id: string;
  repoUrl: string;
  localPath: string;
  defaultBranch?: string;
  testCommand: string;
}

export function registerProject(c: Ctx, p: ProjectInput): ProjectRow {
  validateProject(c, p);
  return inTx(c, (t) =>
    t.db
      .insert(projects)
      .values({ id: p.id, repoUrl: p.repoUrl, localPath: p.localPath, defaultBranch: p.defaultBranch ?? 'main', testCommand: p.testCommand })
      .returning()
      .get(),
  );
}

/** 등록 규칙 검사만 한다 (저장소를 받아 오기 전에 부른다) */
export function validateProject(c: Ctx, p: ProjectInput): void {
  validateProjectId(c, p.id);
  if (!isInside(c.config.paths.repos, p.localPath)) {
    throw new OfficeError('project', `저장소는 ${c.config.paths.repos} 아래에만 둬요: ${p.localPath}`);
  }
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?$/.test(p.repoUrl)) throw new OfficeError('project', `GitHub 저장소 주소가 아니에요: ${p.repoUrl}`);
  if (!p.testCommand.trim()) throw new OfficeError('project', '테스트 명령이 비어 있어요');
}

/** 프로젝트 ID 규칙. GitHub 저장소 이름과 Discord 카테고리 이름으로도 쓰므로 만들기 전에 먼저 검사한다 */
export function validateProjectId(c: Ctx, id: string): void {
  if (c.db.select().from(projects).where(eq(projects.id, id)).get()) throw new OfficeError('project', `이미 등록된 프로젝트예요: ${id}`);
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) throw new OfficeError('project', `프로젝트 ID는 영문 소문자·숫자·-만 써요: ${id}`);
}

export function findProject(c: Ctx, id: string): ProjectRow | null {
  return c.db.select().from(projects).where(eq(projects.id, id)).get() ?? null;
}

/** 프로젝트 #작업 채널에서 온 입력이면 그 프로젝트 (9장) */
export function projectByChannel(c: Ctx, channelId: string | undefined): ProjectRow | null {
  if (!channelId) return null;
  return c.db.select().from(projects).where(eq(projects.discordChannelId, channelId)).get() ?? null;
}

export function setProjectChannel(c: Ctx, id: string, ch: { categoryId: string; channelId: string }): void {
  c.db.update(projects).set({ discordCategoryId: ch.categoryId, discordChannelId: ch.channelId }).where(eq(projects.id, id)).run();
}

export function getProject(c: Ctx, id: string): ProjectRow {
  const row = c.db.select().from(projects).where(eq(projects.id, id)).get();
  if (!row) throw new NotFoundError(`프로젝트 ${id}`);
  return row;
}

/** 지시(티켓)의 프로젝트. 프로젝트 없는 지시면 null */
export function projectOfOrder(c: Ctx, orderId: string): ProjectRow | null {
  const order = c.db.select().from(orders).where(eq(orders.id, orderId)).get();
  return order?.projectId ? getProject(c, order.projectId) : null;
}

export function listProjects(c: Ctx): ProjectRow[] {
  return c.db.select().from(projects).all();
}
