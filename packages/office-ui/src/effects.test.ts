// React 효과(useEffect)는 정리 함수 말고는 아무것도 돌려주면 안 된다.
// `useEffect(() => el.scrollIntoView())`처럼 쓰면 최신 Chrome에서 Promise가 돌아와, 탭을 닫을 때 화면 전체가 멈춘다 (2026-10-21).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? sources(join(dir, d.name)) : /\.tsx?$/.test(d.name) && !d.name.endsWith('.test.ts') ? [join(dir, d.name)] : []));
}

describe('화면 코드 규칙', () => {
  it('useEffect·useLayoutEffect의 화살표 함수는 중괄호로 감싼다 (값을 돌려주지 않게)', () => {
    const bad = sources(import.meta.dirname).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ f, i: i + 1, line }))
        .filter(({ line }) => /use(Layout)?Effect\(\s*\(\)\s*=>\s*[^{\s]/.test(line)),
    );
    expect(bad.map((b) => `${b.f}:${b.i} ${b.line.trim()}`)).toEqual([]);
  });
});
