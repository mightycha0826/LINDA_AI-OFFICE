// git 없이 경로만 돌려주는 작업 공간. MockLLM 시뮬레이션과 흐름 테스트용.
import { join } from 'node:path';
import type { TicketRow } from '../core/tickets.ts';
import type { ProjectRow } from './projects.ts';
import type { Workspace } from './worktrees.ts';

export class MockWorkspace implements Workspace {
  private readonly root: string;
  readonly created: string[] = [];

  constructor(root: string) {
    this.root = root;
  }

  async ensureWorktree(t: TicketRow) {
    this.created.push(t.id);
    return { path: join(this.root, 'wt', t.id), branch: `feature/${t.id.replace('-', '')}-work` };
  }

  sandbox(name: string) {
    return join(this.root, 'wt', '_sandbox', name);
  }

  async readView(p: ProjectRow) {
    return join(this.root, 'wt', '_read', p.id);
  }

  async reviewDiff() {
    return 'diff --git a/src/feature.ts b/src/feature.ts\n+export const ok = true;';
  }
}
