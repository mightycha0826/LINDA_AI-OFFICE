// 17장: 디자인 시스템 lint, 완료 조건 자동 추가, 포인트 시스템 적용, 테스트 러너의 lint
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { planOutput } from '../src/brains/mock.ts';
import { withDesignLint } from '../src/core/plans.ts';
import { applyPointSystem, DEFAULT_POINT_DIR } from '../src/design/apply-point.ts';
import { DS_LINT_CRITERION, lintCode, lintCss, lintDirectory } from '../src/design/ds-lint.ts';
import { projects, tickets } from '../src/db/schema.ts';
import { ProjectTestRunner } from '../src/workspace/test-runner.ts';
import { approvedTickets, setup, tempRoot } from './helpers.ts';

const rules = (ps: { rule: string }[]) => ps.map((p) => p.rule);

describe('디자인 시스템 lint', () => {
  it('hex·rgb·이름 색 직접 입력을 막는다', () => {
    expect(rules(lintCss('a.css', '.x { color: #2f45d8; }'))).toEqual(['color-literal']);
    expect(rules(lintCss('a.css', '.x { background: rgba(0, 0, 0, 0.4); }'))).toEqual(['color-literal']);
    expect(rules(lintCss('a.css', '.x { border: 1px solid red; }'))).toEqual(['color-literal']);
    expect(lintCss('a.css', '.x { color: var(--ink); background: color-mix(in srgb, var(--row), var(--ink) 8%); fill: transparent; }')).toEqual([]);
  });

  it('토큰 글꼴만 쓴다', () => {
    expect(rules(lintCss('a.css', '.x { font-family: Arial, sans-serif; }'))).toEqual(['font-family']);
    expect(rules(lintCss('a.css', '.x { font: 14px serif; }'))).toEqual(['font-family']);
    expect(lintCss('a.css', '.x { font-family: var(--font-sans); } .y { font: inherit; }')).toEqual([]);
  });

  it('간격은 4px 단위', () => {
    expect(rules(lintCss('a.css', '.x { padding: 6px 8px; }'))).toEqual(['spacing-4px']);
    expect(rules(lintCss('a.css', '.x { margin-top: 10px; }'))).toEqual(['spacing-4px']);
    expect(lintCss('a.css', '.x { padding: 8px 12px; gap: var(--space-2); margin: 0 -20px; border: 1px solid var(--track); }')).toEqual([]);
  });

  it('주석 안은 검사하지 않는다', () => {
    expect(lintCss('a.css', '/* 예전 색 #ff0000 */\n.x { color: var(--ink); }')).toEqual([]);
  });

  it('TSX 인라인 스타일도 본다. 일반 코드의 #은 건드리지 않는다', () => {
    expect(rules(lintCode('a.tsx', "<div style={{ color: '#fff' }} />"))).toEqual(['color-literal']);
    expect(rules(lintCode('a.tsx', "<div style={{ fontFamily: 'Arial' }} />"))).toEqual(['font-family']);
    expect(rules(lintCode('a.tsx', "<div style={{ padding: '6px' }} />"))).toEqual(['spacing-4px']);
    expect(lintCode('a.tsx', "const s = `계획서 #P-2`; const t = '#settings'; fill: 'var(--point)'")).toEqual([]);
  });

  it('사무실 화면(office-ui) 자체가 lint를 통과한다', () => {
    const ui = resolve(import.meta.dirname, '..', '..', 'office-ui', 'src');
    expect(lintDirectory(ui)).toEqual([]);
  });
});

describe('완료 조건 자동 추가', () => {
  it('디자인 조합이 있는 계획서의 개발 티켓에만 붙는다', () => {
    expect(withDesignLint(['a'], 'coding', true)).toEqual(['a', DS_LINT_CRITERION]);
    expect(withDesignLint(['a'], 'coding', false)).toEqual(['a']);
    expect(withDesignLint(['a'], 'marketing', true)).toEqual(['a']);
    expect(withDesignLint(['a', DS_LINT_CRITERION], 'coding', true)).toEqual(['a', DS_LINT_CRITERION]);
  });

  it('디자인 시스템 담당이 조합을 고른 계획서를 승인하면 티켓에 조건이 들어간다', async () => {
    const base = planOutput().tickets[0]!;
    const s = setup({ handlers: { plan: () => planOutput({ tempStaff: [{ key: 'ds-1', kind: 'design-system', reason: '화면 만듦' }], tickets: [{ ...base, title: '설정 화면' }] }) } });
    const { tickets: [tk] } = await approvedTickets(s, '설정 화면 만들어줘');
    expect(tk!.acceptanceCriteria).toContain(DS_LINT_CRITERION);
  });
});

describe('포인트 시스템 적용', () => {
  it('worktree에 시스템 파일과 조합을 넣는다. 같은 버전이면 다시 복사하지 않는다', () => {
    const root = tempRoot();
    const first = applyPointSystem(root, { combo: 3, mode: 'dark' });
    expect(first.copied).toEqual(expect.arrayContaining(['tokens.css', 'components/bundle.css', 'components/bundle.js', 'fonts/Paperlogy-Regular.woff2']));
    expect(readFileSync(join(root, 'design-systems', 'point', 'tokens.css'), 'utf8')).toBe(readFileSync(join(DEFAULT_POINT_DIR, 'tokens.css'), 'utf8'));
    const theme = JSON.parse(readFileSync(join(root, 'design-systems', 'point-theme.json'), 'utf8'));
    expect(theme).toMatchObject({ combo: 3, index: 2, mode: 'dark' });
    expect(applyPointSystem(root, { combo: 1, mode: 'light' }).copied).toEqual([]);
  });
});

describe('테스트 러너의 디자인 lint', () => {
  async function runnerCase(css: string) {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    const wt = join(s.config.paths.wt, tk!.id);
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'app.css'), css);
    s.db.update(tickets).set({ worktreePath: wt, acceptanceCriteria: [...tk!.acceptanceCriteria, DS_LINT_CRITERION] }).where(eq(tickets.id, tk!.id)).run();
    s.db.update(projects).set({ testCommand: 'node -e "process.exit(0)"' }).where(eq(projects.id, 'demo')).run();
    return new ProjectTestRunner(s.ctx).run(tk!.id, new AbortController().signal);
  }

  it('lint를 어기면 테스트가 통과해도 실패로 본다', async () => {
    const r = await runnerCase('.x { color: #123456; }');
    expect(r.passed).toBe(false);
    expect(r.summary).toContain('디자인 시스템 lint 실패 1건');
  });

  it('lint를 지키면 통과', async () => {
    const r = await runnerCase('.x { color: var(--ink); }');
    expect(r.passed).toBe(true);
    expect(r.summary).toContain('디자인 시스템 lint 통과');
    expect(existsSync(DEFAULT_POINT_DIR)).toBe(true);
  });
});
