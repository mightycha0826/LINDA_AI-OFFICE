// 실제 직원 대화 프롬프트를 로컬 모델에 전달한다. 메모리 DB만 사용하며 Discord나 작업 도구는 실행하지 않는다.
import { eq } from 'drizzle-orm';
import { LOCAL_MODEL, StaffChatOutputSchema } from '@ai-office/shared';
import { toJsonSchema } from '../brains/json-schema.ts';
import { systemClock } from '../clock.ts';
import { makeConfig } from '../config.ts';
import type { Ctx } from '../context.ts';
import { openDb } from '../db/client.ts';
import { employees } from '../db/schema.ts';
import { chatInput } from '../discord/staff-chat.ts';
import { staffReplyText } from '../discord/format.ts';
import { STAFF_BOT_IDS } from '../discord/staff-bots.ts';
import { seedStaff } from '../seed.ts';
import { conversationPrompt } from '../staff/prompts.ts';
import { ollamaMessages } from '../brains/ollama.ts';
import { roleCard } from '../staff/role-cards.ts';
import { staffProposalIntro } from '../staff/voice.ts';

const db = openDb(':memory:');
const c: Ctx = { db, config: makeConfig({ ceoDiscordId: '100000000000000001' }), clock: systemClock };
seedStaff(c);
const cases = [
  ...STAFF_BOT_IDS.map((id) => ({ id, name: `${id} 인사`, message: '안녕. 오늘 좀 피곤해서 그냥 이야기하고 싶어.', intent: 'chat', recent: [] })),
  { id: 'dev-a', name: '아이디어 탐색', message: '로그인도 있으면 좋겠네. 아직 할지는 생각 중이야.', intent: 'chat', recent: [] },
  { id: 'marketing', name: '모호한 업무는 질문', message: '우리 사이트 홍보 글 좀 써줘.', intent: 'chat', recent: [] },
  { id: 'dev-a', name: '대화 범위를 합쳐 제안', message: '실패하면 "이메일과 비밀번호를 확인해 주세요"라고 한국어로 표시해. 이것까지 포함한 내용으로 작업 제안해줘.', intent: 'order', recent: [
    { at: Date.now(), owner: 'demo 프로젝트에 이메일과 비밀번호를 입력하는 로그인 화면을 만들어줘. 실제 서버 연결 없이 화면과 입력 검증만 구현하고, 이메일 빈값과 비밀번호 빈값 검증 테스트가 통과하면 돼.', me: '로그인 실패 시 안내 문구는 어떻게 표시하면 좋을까요?' },
  ] },
];
let failures = 0;
for (const test of cases.filter((item) => !process.argv[2] || item.name.includes(process.argv[2]))) {
  const employee = c.db.select().from(employees).where(eq(employees.id, test.id)).get()!;
  const input = chatInput(c, test.id, test.message, test.recent);
  const prompt = conversationPrompt(roleCard(c, employee, 'chat', StaffChatOutputSchema), input);
  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ model: LOCAL_MODEL, messages: ollamaMessages(prompt), format: toJsonSchema(StaffChatOutputSchema), stream: false, think: false, options: { temperature: 0.4, num_ctx: 65536, num_predict: 700 } }),
  });
  const result = await response.json() as { error?: string; message?: { content?: string } };
  if (!response.ok || result.error) throw new Error(result.error ?? `Ollama ${response.status}`);
  const out = StaffChatOutputSchema.parse(JSON.parse(result.message!.content!));
  const text = out.intent === 'order' || out.intent === 'revise' ? staffProposalIntro(test.id) : staffReplyText(out.text);
  const passed = out.intent === test.intent && !/"(?:intent|text|criteria|request)"\s*:|스키마|도구 호출|JSON|토큰/.test(text)
    && (test.intent !== 'order' || !!out.criteria?.length && /이메일/.test(out.request ?? '') && /실패|안내/.test(out.request ?? ''));
  if (!passed) failures++;
  console.log(JSON.stringify({ case: test.name, passed, intent: out.intent, text, request: out.request }));
}
db.$client.close();
if (failures) process.exitCode = 1;
