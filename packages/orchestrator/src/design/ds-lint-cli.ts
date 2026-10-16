// npm run lint:ds [폴더…] — 디자인 시스템 lint. 문제가 있으면 종료 코드 1.
import { resolve } from 'node:path';
import { formatProblems, lintDirectory } from './ds-lint.ts';

const dirs = process.argv.slice(2);
if (dirs.length === 0) dirs.push('packages/office-ui/src');
let total = 0;
for (const d of dirs) {
  const ps = lintDirectory(resolve(d));
  total += ps.length;
  console.log(ps.length ? `${d}: ${ps.length}건\n${formatProblems(ps)}` : `${d}: 통과`);
}
process.exit(total ? 1 : 0);
