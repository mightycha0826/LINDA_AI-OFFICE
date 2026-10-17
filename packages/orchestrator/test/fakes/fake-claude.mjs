// 가짜 `claude -p`. 받은 인자·폴더·환경 변수 이름·설정 파일을 기록하고 Claude Code와 같은 모양의 JSON을 낸다.
// FAKE_MODE: ok(기본) | limit | offline | crash | slow | flaky(첫 호출만 crash)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argValue, log, outputFor, readStdin, sleep } from './fake-common.mjs';

const argv = process.argv.slice(2);
const stdin = readStdin();
const settingsPath = argValue(argv, '--settings');
const promptPath = argValue(argv, '--append-system-prompt-file');
log({
  bin: 'claude',
  argv,
  cwd: process.cwd(),
  envKeys: Object.keys(process.env),
  gitHelper: [process.env.GIT_CONFIG_KEY_0, process.env.GIT_CONFIG_VALUE_0],
  stdin,
  settings: settingsPath && existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : null,
  systemPrompt: promptPath && existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : null,
});

let mode = process.env.FAKE_MODE ?? 'ok';
if (mode === 'flaky' && process.env.FAKE_STATE) {
  const n = existsSync(process.env.FAKE_STATE) ? Number(readFileSync(process.env.FAKE_STATE, 'utf8')) : 0;
  writeFileSync(process.env.FAKE_STATE, String(n + 1));
  mode = n === 0 ? 'crash' : 'ok';
}

if (mode === 'slow') await sleep(30_000);
if (mode === 'crash') {
  process.stderr.write('segfault-ish: boom\n');
  process.exit(2);
}
if (mode === 'offline') {
  process.stderr.write('Error: getaddrinfo ENOTFOUND api.anthropic.com\n');
  process.exit(1);
}
const stream = argValue(argv, '--output-format') === 'stream-json';
/** stream-json이면 실제 CLI처럼 줄마다 이벤트를 내고, 마지막 줄이 결과다 */
function emit(result, rate = { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1792150800 }, seven_day: { utilization: 0.18, resetsAt: 1792468800 } } }) {
  if (!stream) return process.stdout.write(JSON.stringify(result));
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: rate }) + '\n');
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (mode === 'limit') {
  emit({ type: 'result', subtype: 'error', is_error: true, result: 'Claude usage limit reached. Your limit will reset at 2026-10-15T15:00:00Z' }, { status: 'rejected', unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1792150800 } } });
  process.exit(1);
}

const schema = JSON.parse(argValue(argv, '--json-schema') ?? '{}');
const output = outputFor(schema, stdin);
// 개발자 작업이면 worktree에 파일을 하나 만든다 (도구로 파일을 고친 흉내)
if (argValue(argv, '--tools')?.includes('Write') && 'changedFiles' in output) writeFileSync(join(process.cwd(), 'feature.txt'), 'ok\n');
emit({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: JSON.stringify(output),
  structured_output: output,
  usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
  permission_denials: [],
});
