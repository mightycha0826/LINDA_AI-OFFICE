// 가짜 `codex exec`. 읽기 전용이나 네트워크를 끈 쓰기 모드(7-3 개발자)가 아니면 실패한다. 마지막 메시지를 -o 파일에 쓰고 JSONL 이벤트를 낸다.
// FAKE_MODE: ok(기본) | limit | offline | crash
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argValue, log, outputFor, readStdin } from './fake-common.mjs';

const argv = process.argv.slice(2);
const stdin = argv.at(-1) === '-' ? readStdin() : argv.at(-1);
const schemaPath = argValue(argv, '--output-schema');
const schema = schemaPath ? JSON.parse(readFileSync(schemaPath, 'utf8')) : {};
log({ bin: 'codex', argv, cwd: process.cwd(), envKeys: Object.keys(process.env), stdin, schema });

const sandbox = argValue(argv, '--sandbox');
const writeOk = sandbox === 'workspace-write' && argv.includes('sandbox_workspace_write.network_access=false');
if (sandbox !== 'read-only' && !writeOk) {
  process.stderr.write(`fake-codex: 허용되지 않은 샌드박스로 실행됨 (${sandbox})\n`);
  process.exit(3);
}
const mode = process.env.FAKE_MODE ?? 'ok';
if (mode === 'crash') process.exit(2);
if (mode === 'offline') {
  process.stderr.write('stream error: error sending request: connection refused (os error 10061)\n');
  process.exit(1);
}
if (mode === 'limit') {
  process.stdout.write(JSON.stringify({ type: 'error', message: "You've hit your usage limit. Try again later." }) + '\n');
  process.exit(1);
}

const output = outputFor(schema, stdin);
// 쓰기 모드의 개발자 작업이면 작업 폴더에 파일을 하나 만든다 (파일을 고친 흉내)
if (writeOk && 'changedFiles' in output) writeFileSync(join(process.cwd(), 'feature.txt'), 'ok\n');
// 엄격 모드처럼 선택 속성도 null로 채워 보낸다
if (output.criteria) output.criteria = output.criteria.map((c) => ({ reason: null, ...c }));
if ('verdict' in output && !('reasonCategory' in output)) output.reasonCategory = null;
writeFileSync(argValue(argv, '-o'), JSON.stringify(output));
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 120 } }) + '\n');
