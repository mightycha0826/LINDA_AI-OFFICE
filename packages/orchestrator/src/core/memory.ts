// 회사 기억 (6장 공통 입력, 2026-10-23 CEO 결정): 사장님이 PM 질문에 답한 내용과 /기억으로 적은 내용을
// 코드가 원문 그대로 남기고, 그 프로젝트 일을 하는 직원 모두에게 함께 보여 준다. AI는 기억을 쓰지도 고치지도 않는다.
import { getState, nowIso, setState, type Ctx } from '../context.ts';
import { assertCeo, OfficeError } from '../errors.ts';

/** 프로젝트가 정해지지 않은 지시의 답과 회사 전체에 해당하는 기억 */
export const COMPANY_SCOPE = 'company';
/** 범위(회사 전체·프로젝트)마다 남기는 최대 개수. 넘으면 오래된 것부터 지운다 */
export const MAX_NOTES_PER_SCOPE = 30;
const MAX_TEXT = 2000;
const KEY = 'memory';

export interface MemoryNote {
  id: number;
  scope: string;
  text: string;
  source: 'answer' | 'ceo';
  orderId?: string;
  at: string;
}

export const allNotes = (c: Ctx): MemoryNote[] => getState<MemoryNote[]>(c, KEY, []);

/** 직원에게 보여 줄 기억: 회사 전체 + 그 프로젝트 (오래된 순) */
export function memoryFor(c: Ctx, projectId: string | null): { text: string; at: string }[] {
  return allNotes(c)
    .filter((n) => n.scope === COMPANY_SCOPE || n.scope === projectId)
    .map((n) => ({ text: n.text, at: n.at }));
}

export function remember(c: Ctx, scope: string, note: { text: string; source: MemoryNote['source']; orderId?: string }): MemoryNote {
  const text = note.text.trim().slice(0, MAX_TEXT);
  if (!text) throw new OfficeError('memory-empty', '기억할 내용을 적어 주세요');
  const notes = allNotes(c);
  const row: MemoryNote = { id: Math.max(0, ...notes.map((n) => n.id)) + 1, scope, text, source: note.source, ...(note.orderId ? { orderId: note.orderId } : {}), at: nowIso(c) };
  const same = notes.filter((n) => n.scope === scope);
  const drop = new Set(same.slice(0, Math.max(0, same.length + 1 - MAX_NOTES_PER_SCOPE)).map((n) => n.id));
  setState(c, KEY, [...notes.filter((n) => !drop.has(n.id)), row]);
  return row;
}

export function forget(c: Ctx, id: number, userId: string): MemoryNote {
  assertCeo(c.config, userId);
  const notes = allNotes(c);
  const row = notes.find((n) => n.id === id);
  if (!row) throw new OfficeError('memory-missing', `기억 ${id}번이 없어요`);
  setState(c, KEY, notes.filter((n) => n.id !== id));
  return row;
}

/** PM 질문 한 차례와 사장님 답변을 기억 한 줄로 */
export function answerNote(questions: string[], answer: string): string {
  return [`PM 질문: ${questions.map((q, i) => `${i + 1}. ${q}`).join(' / ')}`, `사장님 답변: ${answer}`].join('\n');
}
