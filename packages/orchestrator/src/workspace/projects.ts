// 프로젝트 등록 (11장). 회사는 등록된 저장소만 건드린다. Discord 명령은 4단계에서 붙인다.
import { eq } from 'drizzle-orm';
import { inTx, type Ctx } from '../context.ts';
import { projects } from '../db/schema.ts';
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
  if (c.db.select().from(projects).where(eq(projects.id, p.id)).get()) throw new OfficeError('project', `이미 등록된 프로젝트예요: ${p.id}`);
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(p.id)) throw new OfficeError('project', `프로젝트 ID는 영문 소문자·숫자·-만 써요: ${p.id}`);
  if (!isInside(c.config.paths.repos, p.localPath)) {
    throw new OfficeError('project', `저장소는 ${c.config.paths.repos} 아래에만 둬요: ${p.localPath}`);
  }
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?$/.test(p.repoUrl)) throw new OfficeError('project', `GitHub 저장소 주소가 아니에요: ${p.repoUrl}`);
  if (!p.testCommand.trim()) throw new OfficeError('project', '테스트 명령이 비어 있어요');
}

export function getProject(c: Ctx, id: string): ProjectRow {
  const row = c.db.select().from(projects).where(eq(projects.id, id)).get();
  if (!row) throw new NotFoundError(`프로젝트 ${id}`);
  return row;
}

export function listProjects(c: Ctx): ProjectRow[] {
  return c.db.select().from(projects).all();
}
