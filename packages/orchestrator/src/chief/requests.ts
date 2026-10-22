// 비서실장의 확인 버튼 요청 (7장, 2026-10-22 CEO 결정). 비서실장은 요청만 하고, 실행은 사장님이 #결재함 [실행]을 눌러야 한다.
// 실행은 결재 봇(discord/interactions.ts)이 사장님 계정을 확인한 뒤 /새프로젝트·/설정·/파견·#막힘 버튼과 같은 함수로 한다.
// 결재(계획서·푸시)와 PM 질문 답변은 여기서 요청할 수 없다. 사장님이 직접 한다.
// 요청은 system_state에 'chief.request:<id>'로 남고, 알림(discord/notifier.ts)이 아직 안 올린 요청을 찾아 #결재함에 올린다.
// [실행]·[하지 않기]로 한 번만 닫힌다.
import { and, eq, like } from 'drizzle-orm';
import { getState, inTx, newId, nowIso, setState, type Ctx } from '../context.ts';
import { isGuest } from '../core/budget.ts';
import { guestEmployeeId } from '../core/guests.ts';
import { employees, orders, systemState, tickets } from '../db/schema.ts';
import type { Button } from '../discord/types.ts';
import { planBlockedKey } from '../engine/planning.ts';
import { NotFoundError, OfficeError } from '../errors.ts';
import { previewSetting, SETTINGS } from '../settings.ts';
import { findProject, validateProjectId } from '../workspace/projects.ts';
import { DEFAULT_TEST_COMMAND } from '../workspace/new-project.ts';
import type { ChiefRequestKind } from './tool-defs.ts';

export interface ChiefRequestInput {
  kind: ChiefRequestKind;
  target: string;
  value?: string;
  testCommand?: string;
  description?: string;
  reason: string;
}

export interface ChiefRequest extends ChiefRequestInput {
  id: string;
  /** 사장님께 보여 줄 실행 내용 (요청할 때 확인한 것) */
  what: string;
  status: 'pending' | 'done' | 'cancelled';
  createdAt: string;
  /** #결재함에 올린 메시지. 없으면 아직 안 올림 */
  messageId?: string;
}

export const CHIEF_REQUEST_LABEL: Record<ChiefRequestKind, string> = {
  'new-project': '새 프로젝트 만들기',
  setting: '설정 바꾸기',
  'guest-on': '파견 직원 출근',
  'guest-off': '파견 직원 퇴근',
  'retry-ticket': '막힌 티켓 다시 시도',
  'cancel-ticket': '막힌 티켓 취소',
  'retry-plan': '멈춘 계획 작성 다시 시도',
  'cancel-plan': '멈춘 계획 작성 취소',
};

const PREFIX = 'chief.request:';

export function chiefRequestOf(c: Ctx, id: string): ChiefRequest | null {
  return getState<ChiefRequest | null>(c, PREFIX + id, null);
}

function pendingChiefRequests(c: Ctx): ChiefRequest[] {
  return c.db
    .select()
    .from(systemState)
    .where(like(systemState.key, `${PREFIX}%`))
    .all()
    .map((r) => r.value as ChiefRequest)
    .filter((r) => r.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 아직 #결재함에 올리지 않은 요청 (알림이 올린다) */
export function unpostedChiefRequests(c: Ctx): ChiefRequest[] {
  return pendingChiefRequests(c).filter((r) => !r.messageId);
}

export function markChiefRequestPosted(c: Ctx, id: string, messageId: string): void {
  inTx(c, (t) => {
    const req = chiefRequestOf(t, id);
    if (req) setState(t, PREFIX + id, { ...req, messageId });
  });
}

/**
 * 비서실장 요청을 받는다. 지금 실행할 수 있는 일인지 먼저 확인하고(안 되면 이유를 돌려준다), #결재함에 버튼을 띄우게 한다.
 * 같은 요청이 이미 기다리고 있으면 새로 만들지 않는다.
 */
export function requestChiefAction(c: Ctx, input: ChiefRequestInput): { requested: boolean; requestId?: string; note: string } {
  let checked: { target: string; what: string };
  try {
    checked = check(c, input);
  } catch (err) {
    if (err instanceof OfficeError) return { requested: false, note: err.message };
    throw err;
  }
  const same = pendingChiefRequests(c).find((r) => r.kind === input.kind && r.target === checked.target && (r.value ?? '') === (input.value ?? ''));
  if (same) return { requested: true, requestId: same.id, note: '이미 결재함에 같은 확인 버튼이 있어요. 사장님이 누르면 실행돼요' };
  const req: ChiefRequest = { ...input, target: checked.target, id: newId(), what: checked.what, status: 'pending', createdAt: nowIso(c) };
  setState(c, PREFIX + req.id, req);
  return { requested: true, requestId: req.id, note: '결재함에 확인 버튼을 띄웠어요. 사장님이 [실행]을 눌러야 실행돼요' };
}

/** 지금 실행할 수 있는 요청인지 본다. 대상(정리한 이름)과 사장님께 보여 줄 내용을 돌려준다 */
function check(c: Ctx, r: ChiefRequestInput): { target: string; what: string } {
  switch (r.kind) {
    case 'new-project': {
      const id = r.target.trim();
      const existing = findProject(c, id);
      if (existing?.discordChannelId) throw new OfficeError('project', `이미 있는 프로젝트예요: ${id}`);
      // 저장소까지만 만들어진 프로젝트는 채널만 만든다 (workspace/new-project.ts)
      if (!existing) validateProjectId(c, id);
      const what = existing
        ? `**${id}** Discord 작업 채널 만들기 (저장소는 이미 등록됨)`
        : `**${id}** GitHub 비공개 저장소와 Discord 작업 채널 만들기 · 테스트 명령 \`${r.testCommand || DEFAULT_TEST_COMMAND}\``;
      return { target: id, what };
    }
    case 'setting': {
      if (!Object.hasOwn(SETTINGS, r.target)) throw new OfficeError('setting', `모르는 설정 항목이에요: ${r.target}. 쓸 수 있는 항목: ${Object.keys(SETTINGS).join(', ')}`);
      if (!r.value) throw new OfficeError('setting', '바꿀 값(value)을 적어 주세요');
      return { target: r.target, what: previewSetting(c, r.target, r.value) };
    }
    case 'guest-on':
    case 'guest-off': {
      const e = c.db.select().from(employees).where(eq(employees.id, guestEmployeeId(r.target))).get();
      if (!e || !isGuest(e)) throw new NotFoundError(`파견 직원 ${r.target}`);
      return { target: r.target, what: `${e.displayName} ${r.kind === 'guest-on' ? '출근' : '퇴근'}` };
    }
    case 'retry-ticket':
    case 'cancel-ticket': {
      const id = r.target.trim().toUpperCase();
      const t = c.db.select().from(tickets).where(eq(tickets.id, id)).get();
      if (!t) throw new NotFoundError(`티켓 ${id}`);
      if (t.status !== 'blocked') throw new OfficeError('not-blocked', `${id}는 막힌 상태가 아니에요(${t.status})`);
      return { target: id, what: `**${t.id} ${t.title}** ${r.kind === 'retry-ticket' ? '다시 시도' : '취소'}` };
    }
    case 'retry-plan':
    case 'cancel-plan': {
      const id = r.target.trim().toUpperCase();
      const o = c.db.select().from(orders).where(and(eq(orders.id, id), eq(orders.status, 'planning'))).get();
      if (!o || !getState<unknown>(c, planBlockedKey(id), null)) throw new OfficeError('not-blocked', `${id}는 계획 작성이 멈춘 지시가 아니에요`);
      return { target: id, what: `**${o.id}** 계획 작성 ${r.kind === 'retry-plan' ? '다시 시도' : '취소'}\n> ${o.rawText.slice(0, 200)}` };
    }
  }
}

/** 아직 기다리는 요청인지 본다. 이미 처리됐으면 오류 (두 번 누르기) */
export function assertChiefRequestPending(req: ChiefRequest): void {
  if (req.status !== 'pending') throw new OfficeError('request-closed', '이미 처리된 요청이에요');
}

/** 요청을 닫는다. 한 번만 닫힌다 */
export function closeChiefRequest(c: Ctx, id: string, status: 'done' | 'cancelled'): ChiefRequest {
  return inTx(c, (t) => {
    const req = chiefRequestOf(t, id);
    if (!req) throw new NotFoundError(`비서실장 요청 ${id}`);
    assertChiefRequestPending(req);
    const closed = { ...req, status };
    setState(t, PREFIX + id, closed);
    return closed;
  });
}

export function chiefRequestHead(r: ChiefRequest): string {
  return `**비서실장 요청 · ${CHIEF_REQUEST_LABEL[r.kind]}**`;
}

/** #결재함 메시지: 무엇을 하는지, 비서실장이 전한 말, [실행] [하지 않기] */
export function chiefRequestMessage(r: ChiefRequest): { content: string; buttons: Button[][] } {
  return {
    content: [chiefRequestHead(r), r.what, r.reason ? `비서실장 전달: ${r.reason}` : null, '[실행]을 누르기 전에는 아무것도 바뀌지 않아요.'].filter(Boolean).join('\n'),
    buttons: [[{ id: `cr:${r.id}:ok`, label: '실행', style: 'primary' }, { id: `cr:${r.id}:no`, label: '하지 않기', style: 'secondary' }]],
  };
}
