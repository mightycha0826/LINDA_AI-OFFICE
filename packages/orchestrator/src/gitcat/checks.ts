// 푸시 전 검사 (11장).
// | 검사 | 실패하면 |
// | 리뷰 통과 여부 | 경고만. 최종 판단은 CEO |
// | 테스트 재실행 | 경고하고 결과를 버튼 메시지에 표시 |
// | 비밀 정보 검사 (gitleaks) | 무조건 차단. 버튼으로도 못 넘어간다. gitleaks가 없어도 차단 |
// | 50MB 이상 파일 | 차단 |
import type { RunOptions, RunResult } from '../brains/process.ts';

export type Runner = (o: RunOptions) => Promise<RunResult>;

export interface CheckResult {
  name: string;
  ok: boolean;
  /** true면 버튼으로도 넘어갈 수 없다 */
  blocking: boolean;
  detail: string;
}

/** base..HEAD 사이 커밋과 커밋하지 않은 변경에 비밀 정보가 있는지 gitleaks로 본다 */
export async function secretScan(run: Runner, o: { cwd: string; bin: string; args: readonly string[]; base: string; timeoutMs: number }): Promise<CheckResult> {
  const r = await run({ bin: o.bin, args: [...o.args, 'git', '--no-banner', '--redact', `--log-opts=${o.base}..HEAD`, '.'], cwd: o.cwd, timeoutMs: o.timeoutMs });
  const dir = await run({ bin: o.bin, args: [...o.args, 'dir', '--no-banner', '--redact', '.'], cwd: o.cwd, timeoutMs: o.timeoutMs });
  if (r.spawnError || dir.spawnError) {
    return { name: '비밀 정보 검사', ok: false, blocking: true, detail: `gitleaks를 실행하지 못해 푸시하지 않아요 (${r.spawnError ?? dir.spawnError})` };
  }
  // gitleaks: 0 = 없음, 1 = 찾음, 그 밖 = 오류. 오류도 차단한다(실패하면 닫힘).
  if (r.code === 0 && dir.code === 0) return { name: '비밀 정보 검사', ok: true, blocking: true, detail: '비밀 정보 없음' };
  const found = r.code === 1 || dir.code === 1;
  return {
    name: '비밀 정보 검사',
    ok: false,
    blocking: true,
    detail: found ? '비밀 정보로 보이는 내용이 있어 푸시하지 않아요 (버튼으로도 넘어갈 수 없어요)' : `gitleaks 오류(종료 코드 ${r.code}/${dir.code})로 푸시하지 않아요`,
  };
}

/** base..HEAD 사이에 들어간 큰 파일(blob) */
export async function largeFiles(run: Runner, o: { cwd: string; base: string; maxBytes: number; timeoutMs: number }): Promise<CheckResult> {
  const objs = await run({ bin: 'git', args: ['rev-list', '--objects', `${o.base}..HEAD`], cwd: o.cwd, timeoutMs: o.timeoutMs });
  const lines = objs.stdout.split('\n').filter(Boolean);
  const big: string[] = [];
  if (lines.length) {
    const batch = await run({
      bin: 'git',
      args: ['cat-file', '--batch-check=%(objecttype) %(objectsize) %(rest)'],
      cwd: o.cwd,
      stdin: lines.map((l) => l.split(' ')[0]).join('\n') + '\n',
      timeoutMs: o.timeoutMs,
    });
    const names = new Map(lines.map((l) => [l.split(' ')[0], l.slice(l.indexOf(' ') + 1)]));
    const ids = lines.map((l) => l.split(' ')[0]!);
    batch.stdout
      .split('\n')
      .filter(Boolean)
      .forEach((row, i) => {
        const [type, size] = row.split(' ');
        if (type === 'blob' && Number(size) >= o.maxBytes) big.push(`${names.get(ids[i]!) ?? ids[i]} (${(Number(size) / 1024 / 1024).toFixed(1)}MB)`);
      });
  }
  return big.length
    ? { name: '큰 파일', ok: false, blocking: true, detail: `${Math.round(o.maxBytes / 1024 / 1024)}MB 이상 파일이 있어 푸시하지 않아요: ${big.join(', ')}` }
    : { name: '큰 파일', ok: true, blocking: true, detail: `${Math.round(o.maxBytes / 1024 / 1024)}MB 이상 파일 없음` };
}

export function summarizeChecks(checks: CheckResult[]): { blocked: boolean; lines: string[] } {
  return {
    blocked: checks.some((c) => !c.ok && c.blocking),
    lines: checks.map((c) => `${c.ok ? '✔' : c.blocking ? '⛔' : '⚠'} ${c.name}: ${c.detail}`),
  };
}
