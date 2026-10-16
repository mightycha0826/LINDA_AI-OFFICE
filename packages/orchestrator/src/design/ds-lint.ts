// 디자인 시스템 lint (17장 적용 방법 4): 토큰에 없는 색(hex·rgb 직접 입력), 다른 글꼴, 4px 단위가 아닌 간격을 금지한다.
// 사무실 화면(office-ui)과, 디자인 조합이 붙은 계획서의 개발 티켓 worktree에 똑같이 쓴다.
// AI가 "지켰다"고 말하는 것으로 끝내지 않고 코드가 검사한다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

/** 디자인 조합이 붙은 계획서의 개발 티켓에 자동으로 붙는 완료 조건 */
export const DS_LINT_CRITERION = '디자인 시스템 lint 통과';

export interface LintProblem {
  file: string;
  line: number;
  rule: 'color-literal' | 'font-family' | 'spacing-4px';
  text: string;
}

const CSS_EXT = new Set(['.css', '.scss', '.svelte', '.vue']);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'design-systems', 'coverage', '.svelte-kit']);

const COLOR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i;
const HEX = /#[0-9a-f]{3,8}\b/i;
const NAMED = /\b(?:color|background(?:-color)?|fill|stroke|border(?:-[a-z]+)*|outline(?:-color)?|box-shadow|text-decoration-color)\s*:\s*[^;]*\b(?:white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|brown|navy|teal)\b/i;
const SPACING_PROP = /(?:^|[\s;{])(?:margin|padding|gap|row-gap|column-gap|inset)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?\s*:\s*([^;}]+)/gi;
const FONT_FAMILY = /font-family\s*:\s*([^;}]+)/i;
const FONT_SHORTHAND = /(?:^|[\s;{])font\s*:\s*([^;}]+)/i;
const OK_FONT = /^(?:var\(--font-[a-z-]+\)|inherit)(?:\s*!important)?$/i;

function stripCssComments(text: string): string {
  // 줄 번호를 지키려고 주석 안의 글자만 공백으로 바꾼다
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

export function lintCss(file: string, text: string): LintProblem[] {
  const out: LintProblem[] = [];
  stripCssComments(text)
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      const push = (rule: LintProblem['rule']) => out.push({ file, line: i + 1, rule, text: line });
      if (HEX.test(line) || COLOR_FN.test(line) || NAMED.test(line)) push('color-literal');
      const ff = line.match(FONT_FAMILY);
      if (ff && !OK_FONT.test(ff[1]!.trim())) push('font-family');
      const fs = !ff && line.match(FONT_SHORTHAND);
      if (fs && !/^inherit(?:\s*!important)?$/i.test(fs[1]!.trim())) push('font-family');
      const off = [...line.matchAll(SPACING_PROP)].some((sp) => [...sp[1]!.matchAll(/(-?\d+(?:\.\d+)?)px/g)].some((m) => Math.abs(Number(m[1])) % 4 !== 0));
      if (off) push('spacing-4px');
    });
  return out;
}

/** TS/TSX: 인라인 스타일과 문자열 속 색·글꼴만 본다 (일반 코드의 '#' 등은 건드리지 않는다) */
export function lintCode(file: string, text: string): LintProblem[] {
  const out: LintProblem[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    const push = (rule: LintProblem['rule']) => out.push({ file, line: i + 1, rule, text: line });
    if (/['"`]\s*#[0-9a-f]{3,8}\s*['"`]/i.test(line) || /['"`][^'"`]*\b(?:rgba?|hsla?)\(\s*\d/i.test(line)) push('color-literal');
    const ff = line.match(/fontFamily\s*:\s*['"`]([^'"`]+)['"`]/);
    if (ff && !OK_FONT.test(ff[1]!.trim())) push('font-family');
    for (const m of line.matchAll(/\b(?:margin|padding|gap)(?:Top|Right|Bottom|Left|Inline|Block)?\s*:\s*['"`]([^'"`]+)['"`]/g)) {
      if ([...m[1]!.matchAll(/(-?\d+(?:\.\d+)?)px/g)].some((x) => Math.abs(Number(x[1])) % 4 !== 0)) push('spacing-4px');
    }
  });
  return out;
}

export function lintFile(file: string, text: string): LintProblem[] {
  const ext = extname(file).toLowerCase();
  if (CSS_EXT.has(ext)) return lintCss(file, text);
  if (CODE_EXT.has(ext)) return lintCode(file, text);
  return [];
}

/** 폴더 전체 (node_modules, dist, design-systems는 건너뛴다) */
export function lintDirectory(root: string): LintProblem[] {
  const out: LintProblem[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name) && !name.startsWith('.')) walk(p);
      } else if (st.size < 1_000_000) {
        out.push(...lintFile(relative(root, p).replaceAll('\\', '/'), readFileSync(p, 'utf8')));
      }
    }
  };
  walk(root);
  return out;
}

export function formatProblems(ps: LintProblem[], max = 30): string {
  const names = { 'color-literal': '토큰에 없는 색', 'font-family': '다른 글꼴', 'spacing-4px': '4px 단위가 아닌 간격' };
  const lines = ps.slice(0, max).map((p) => `${p.file}:${p.line} ${names[p.rule]} — ${p.text.slice(0, 120)}`);
  if (ps.length > max) lines.push(`… 외 ${ps.length - max}건`);
  return lines.join('\n');
}
