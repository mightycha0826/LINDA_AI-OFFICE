// 오케스트레이터가 직접 돌리는 테스트 (6장 리뷰어: "개발자의 말이 아니라 등록된 testCommand로 직접 돌린 결과만").
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.ts';
import type { TestResult, TestRunner } from '../brains/brain.ts';
import { tail } from '../brains/classify.ts';
import { runProcess } from '../brains/process.ts';
import { tickets } from '../db/schema.ts';
import { DS_LINT_CRITERION, formatProblems, lintDirectory } from '../design/ds-lint.ts';
import { assertInside } from './paths.ts';
import { projectOfOrder, type ProjectRow } from './projects.ts';

/** 등록된 testCommand를 그 폴더에서 돌린다. 판정은 종료 코드로만 (티켓 worktree, 통합 브랜치 폴더) */
export async function runTestCommand(c: Ctx, project: ProjectRow, cwd: string, signal?: AbortSignal, run = runProcess): Promise<TestResult> {
  const r = await run({ bin: project.testCommand, args: [], shell: true, cwd, timeoutMs: c.config.tests.timeoutMin * 60_000, ...(signal ? { signal } : {}) });
  if (r.aborted) throw new DOMException('정지됨', 'AbortError');
  const output = tail(`${r.stdout}\n${r.stderr}`.trim(), 4000);
  if (r.timedOut) return { passed: false, summary: `시간 초과(${c.config.tests.timeoutMin}분): ${project.testCommand}\n${output}` };
  return { passed: r.code === 0, summary: `${project.testCommand} → 종료 코드 ${r.code}\n${output}` };
}

export class ProjectTestRunner implements TestRunner {
  private readonly c: Ctx;

  constructor(c: Ctx) {
    this.c = c;
  }

  async run(ticketId: string, signal: AbortSignal): Promise<TestResult> {
    const tk = this.c.db.select().from(tickets).where(eq(tickets.id, ticketId)).get();
    const project = tk && projectOfOrder(this.c, tk.orderId);
    if (!tk?.worktreePath || !project) return { passed: false, summary: 'worktree나 등록된 프로젝트가 없어 테스트를 돌리지 못했어요' };
    const cwd = assertInside(this.c.config.paths.wt, tk.worktreePath, `테스트(${ticketId})`);
    const tests = await runTestCommand(this.c, project, cwd, signal);
    // 디자인 조합이 붙은 UI 티켓: 디자인 시스템 lint도 오케스트레이터가 직접 돌린다 (17장)
    if (!tk.acceptanceCriteria.includes(DS_LINT_CRITERION)) return tests;
    const problems = lintDirectory(cwd);
    const lint = problems.length ? `디자인 시스템 lint 실패 ${problems.length}건\n${formatProblems(problems)}` : '디자인 시스템 lint 통과';
    return { passed: tests.passed && problems.length === 0, summary: `${tests.summary}\n\n${lint}` };
  }
}
