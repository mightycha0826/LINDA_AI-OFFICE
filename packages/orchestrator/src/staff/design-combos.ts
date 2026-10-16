// 디자인 시스템 담당에게 넘길 포인트 조합 표 (6장 입력: design-systems/point/README.md의 조합 표).
// 저장소의 읽기 전용 복사본에서 표만 꺼낸다. 표를 코드에 따로 적지 않는다(원본이 바뀌면 같이 바뀌게).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const README = fileURLToPath(new URL('../../../../design-systems/point/README.md', import.meta.url));

let cached: string | null = null;

export function designComboTable(path = README): string {
  if (cached && path === README) return cached;
  if (!existsSync(path)) return '(포인트 디자인 시스템 README를 찾지 못했어요. 조합 번호는 1~10)';
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => /^\|\s*조합\s*\|/.test(l));
  if (start < 0) return '(조합 표를 찾지 못했어요. 조합 번호는 1~10)';
  const table: string[] = [];
  for (const l of lines.slice(start)) {
    if (!l.startsWith('|')) break;
    table.push(l);
  }
  const text = table.join('\n');
  if (path === README) cached = text;
  return text;
}
