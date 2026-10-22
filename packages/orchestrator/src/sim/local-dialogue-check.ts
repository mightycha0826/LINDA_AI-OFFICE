// 실제 로컬 모델과 여러 차례 이야기하며 정정·회상·화제 전환·말투 요청이 이어지는지 본다.
// 메모리 DB만 사용하고 Discord 메시지·작업·결재는 만들지 않는다.
import { eq } from 'drizzle-orm';
import { LOCAL_MODEL, StaffChatOutputSchema } from '@ai-office/shared';
import { toJsonSchema } from '../brains/json-schema.ts';
import { ollamaMessages } from '../brains/ollama.ts';
import { systemClock } from '../clock.ts';
import { makeConfig } from '../config.ts';
import type { Ctx } from '../context.ts';
import { openDb } from '../db/client.ts';
import { employees } from '../db/schema.ts';
import { chatInput, type ChatTurn } from '../discord/staff-chat.ts';
import { staffReplyText } from '../discord/format.ts';
import { seedStaff } from '../seed.ts';
import { conversationPrompt } from '../staff/prompts.ts';
import { roleCard } from '../staff/role-cards.ts';

const db = openDb(':memory:');
const c: Ctx = { db, config: makeConfig({ ceoDiscordId: '100000000000000001' }), clock: systemClock };
seedStaff(c);
const scenarios = [
  { id: 'developer', name: '짧게·질문 없이 이어 가기', turns: [
    '오늘 회의만 세 시간 했더니 진이 다 빠졌어.',
    '그냥 푸념이야. 조언이나 질문 말고 두 문장 안에서 편하게 얘기해 줘.',
    '응, 같은 이야기를 계속해서 시간만 갔어.',
  ], check: (text: string, n: number) => n === 0 || text.length <= 220 && !/[?？]/.test(text) },
  { id: 'marketing', name: '정정한 이름과 색 회상', turns: [
    '새 서비스 이름은 달무리, 색은 파랑으로 생각 중이야. 아직 아이디어 이야기만 하는 거야.',
    '색은 파랑이 아니라 청록으로 바꿀래. 아직 만드는 건 아니고 이 대화에서 기억만 해 둬.',
    '아까 내가 정한 이름하고 색이 뭐였지? 짧게 알려 줘.',
  ], check: (text: string, n: number) => n !== 2 || text.includes('달무리') && text.includes('청록') },
  { id: 'dev-a', name: '업무에서 일상으로 화제 전환', turns: [
    '로그인 기능은 나중에 생각할래. 지금은 그냥 주말 산책 이야기나 하자.',
    '바닷가하고 숲 중에 고민이야. 나는 조용한 데를 좋아해.',
    '내가 어떤 곳을 좋아한다고 했지?',
  ], check: (text: string, n: number) => (n === 0 || !text.includes('로그인')) && (n !== 2 || /조용|한적/.test(text)) },
];
let failures = 0;
for (const scenario of scenarios.filter((item) => !process.argv[2] || item.name.includes(process.argv[2]))) {
  const employee = c.db.select().from(employees).where(eq(employees.id, scenario.id)).get()!;
  const recent: ChatTurn[] = [];
  for (const [n, message] of scenario.turns.entries()) {
    const input = chatInput(c, scenario.id, message, recent);
    const prompt = conversationPrompt(roleCard(c, employee, 'chat', StaffChatOutputSchema), input);
    const response = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ model: LOCAL_MODEL, messages: ollamaMessages(prompt), format: toJsonSchema(StaffChatOutputSchema), stream: false, think: false, options: { temperature: 0.4, num_ctx: 65536, num_predict: 700 } }),
    });
    const result = await response.json() as { error?: string; message?: { content?: string } };
    if (!response.ok || result.error) throw new Error(result.error ?? `Ollama ${response.status}`);
    const out = StaffChatOutputSchema.parse(JSON.parse(result.message!.content!));
    const text = staffReplyText(out.text);
    const passed = out.intent === 'chat' && scenario.check(text, n) && !/"(?:text|intent)"\s*:/.test(text);
    if (!passed) failures++;
    console.log(JSON.stringify({ scenario: scenario.name, turn: n + 1, passed, text }));
    recent.push({ at: Date.now(), owner: message, me: text });
  }
}
db.$client.close();
if (failures) process.exitCode = 1;
