// 실제 로컬 모델로 대화 의도 구분을 확인한다. 도구를 설명만 하고 실행하지 않아 지시·메시지를 만들지 않는다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LOCAL_MODEL } from '@ai-office/shared';
import { TOOL_DEFS } from '../chief/tool-defs.ts';
import { toJsonSchema } from '../brains/json-schema.ts';

const soul = readFileSync(fileURLToPath(new URL('../../../../docs/HERMES-SOUL.md', import.meta.url)), 'utf8');
const tools = Object.entries(TOOL_DEFS).map(([name, def]) => ({ type: 'function', function: { name, description: def.description, parameters: toJsonSchema(def.input) } }));
const proposalId = '80ea8325-1147-4f73-9168-94126dde1234';
const cases = [
  { name: '인사', messages: [{ role: 'user', content: '서진아 안녕, 오늘 기분 어때?' }], allowed: [] },
  { name: '고민', messages: [{ role: 'user', content: '오늘은 너무 피곤하네. 그냥 좀 이야기하고 싶어.' }], allowed: [] },
  { name: '아이디어 탐색', messages: [{ role: 'user', content: '변환기 앱에 로그인도 있으면 좋겠네. 아직 할지 말지 생각 중이야.' }], allowed: [] },
  { name: '업무 의도 확인 또는 제안', messages: [{ role: 'user', content: 'demo 프로젝트에 로그인 기능을 만들어줘. 이메일과 비밀번호로 로그인하면 돼.' }], allowed: ['create_order'], mayClarify: true },
  { name: '확인 후 동의', messages: [
    { role: 'user', content: 'demo에 이메일 로그인 기능 만들어줘' },
    { role: 'assistant', content: `등록 제안 ID는 ${proposalId}입니다. 이메일 로그인 기능을 추가하는 내용으로 이해했어요. 사장님, 이 내용으로 지시를 추가할까요?` },
    { role: 'user', content: '응, 그 내용으로 지시 등록해줘.' },
  ], allowed: ['respond_order_proposal'] },
];
let failures = 0;
for (const test of cases) {
  const started = Date.now();
  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: LOCAL_MODEL, messages: [{ role: 'system', content: soul }, ...test.messages], tools, stream: false, think: false, options: { temperature: 0.2, num_ctx: 65536, num_predict: 500 } }),
    signal: AbortSignal.timeout(120_000),
  });
  const result = await response.json() as { error?: string; message?: { content?: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] } };
  if (!response.ok || result.error) throw new Error(result.error ?? `Ollama ${response.status}`);
  const calls = result.message?.tool_calls ?? [];
  const names = calls.map((call) => call.function.name);
  const valid = test.allowed.length
    ? (names.length === 1 && names[0] === test.allowed[0] && (names[0] !== 'respond_order_proposal' || (calls[0]!.function.arguments.decision === 'register' && calls[0]!.function.arguments.proposalId === proposalId)))
      || (test.mayClarify === true && !names.length && !!result.message?.content?.includes('?'))
    : !names.length;
  if (!valid) failures++;
  console.log(JSON.stringify({ case: test.name, passed: valid, tools: names, text: result.message?.content?.slice(0, 500), seconds: Math.round((Date.now() - started) / 1000) }));
}
if (failures) process.exitCode = 1;
