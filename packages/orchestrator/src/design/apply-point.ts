// 포인트 디자인 시스템 적용 (17장 "적용 방법 (스크립트가 한다)").
// 디자인 조합이 붙은 계획서의 UI 티켓 worktree에 시스템 파일을 복사하고, 고른 조합을 point-theme.json으로 남긴다.
// 개발자는 이 파일들을 불러 쓰기만 한다. 시스템 자체는 고치지 않는다(읽기 전용, lint도 이 폴더는 건너뛴다).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DesignComboOutput } from '@ai-office/shared';

/** 회사 저장소의 design-systems/point */
export const DEFAULT_POINT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'design-systems', 'point');

const FILES = ['README.md', 'VERSION', 'tokens.css', 'tokens.json', 'components/bundle.css', 'components/bundle.js', 'components/index.d.ts'];

export interface PointTheme {
  combo: number;
  /** Point.theme()에 넘기는 번호 (조합 1 = 0) */
  index: number;
  mode: 'light' | 'dark';
  version: string;
}

export function applyPointSystem(targetRoot: string, design: Pick<DesignComboOutput, 'combo' | 'mode'>, sourceDir = DEFAULT_POINT_DIR): { copied: string[]; theme: PointTheme } {
  const dest = join(targetRoot, 'design-systems', 'point');
  const version = readFileSync(join(sourceDir, 'VERSION'), 'utf8').trim();
  const copied: string[] = [];
  const have = existsSync(join(dest, 'VERSION')) ? readFileSync(join(dest, 'VERSION'), 'utf8').trim() : null;
  if (have !== version) {
    for (const f of FILES) {
      if (!existsSync(join(sourceDir, f))) continue;
      mkdirSync(dirname(join(dest, f)), { recursive: true });
      copyFileSync(join(sourceDir, f), join(dest, f));
      copied.push(f);
    }
    const fonts = join(sourceDir, 'fonts');
    if (existsSync(fonts)) {
      mkdirSync(join(dest, 'fonts'), { recursive: true });
      for (const f of readdirSync(fonts)) {
        copyFileSync(join(fonts, f), join(dest, 'fonts', f));
        copied.push(`fonts/${f}`);
      }
    }
  }
  const theme: PointTheme = { combo: design.combo, index: design.combo - 1, mode: design.mode, version };
  writeFileSync(join(targetRoot, 'design-systems', 'point-theme.json'), `${JSON.stringify(theme, null, 2)}\n`, 'utf8');
  return { copied, theme };
}
