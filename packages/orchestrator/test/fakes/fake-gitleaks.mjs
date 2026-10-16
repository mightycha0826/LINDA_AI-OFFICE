// 가짜 gitleaks. `git --log-opts=a..b .`은 그 범위 커밋 내용을, `dir .`은 작업 폴더 파일을 본다.
// 비밀처럼 보이는 문자열(AWS 키, GitHub 토큰)이 있으면 종료 코드 1, 없으면 0.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SECRET = /AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}/;
const args = process.argv.slice(2);
let text = '';
if (args[0] === 'git') {
  const range = args.find((a) => a.startsWith('--log-opts='))?.slice('--log-opts='.length) ?? 'HEAD';
  text = execFileSync('git', ['log', '-p', range], { encoding: 'utf8' });
} else if (args[0] === 'dir') {
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (e === '.git' || e === 'node_modules') continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else text += readFileSync(p, 'utf8');
    }
  };
  walk(process.cwd());
} else {
  process.exit(2);
}
process.exit(SECRET.test(text) ? 1 : 0);
