// 임시 직원 (DESIGN.md 2장, 6장, 13장).
// - PM이 계획서 tempStaff에 요청하고, 티켓 담당자에 "temp:<key>"로 적는다.
// - CEO가 계획서를 승인하면 고용된다(방문증을 걸고 문으로 들어옴). 맡은 티켓이 모두 끝나면 나간다.
// - 디자인 시스템 담당만 예외: 계획 단계에서 불려와 조합을 고르고 바로 나간다.
// - 파일 수정·명령 실행 권한이 없다. 코딩 티켓과 검토는 맡지 않는다. 계획서당 최대 3명.
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { LOCAL_MODEL, type Brain, type TempBrain, type TempKind, type TempStaffRequest, type TicketType } from '@ai-office/shared';
import { emit, nowIso, type Ctx } from '../context.ts';
import type { EmployeeRow } from '../core/budget.ts';
import { employees, tickets } from '../db/schema.ts';

export const TEMP_PREFIX = 'temp:';
/** 공용 임시 직원 스프라이트 세트 (13장: assets/characters/temp-1 …) */
export const TEMP_SPRITE_SETS = ['temp-1', 'temp-2', 'temp-3', 'temp-4'] as const;

interface TempKindSpec {
  title: string;
  /** 출력 형식을 따르는 상시 직원 (6장: 작가는 마케팅 형식, 리서처는 경영전략 형식) */
  basedOn: 'marketing' | 'strategy' | null;
  canSearchWeb: boolean;
  /** 맡을 수 있는 티켓 종류 */
  ticketTypes: readonly TicketType[];
  does: string[];
  never: string[];
}

export const TEMP_KIND_SPECS: Record<TempKind, TempKindSpec> = {
  writer: {
    title: '작가',
    basedOn: 'marketing',
    canSearchWeb: true,
    ticketTypes: ['writing', 'marketing'],
    does: ['글과 문구 초안을 쓴다', '주장마다 근거 링크를 단다. 근거가 없으면 noSource: true로 드러낸다'],
    never: ['근거 없는 주장을 감추지 않는다'],
  },
  designer: {
    title: '디자이너',
    basedOn: 'marketing',
    canSearchWeb: false,
    ticketTypes: ['writing', 'marketing'],
    does: ['화면·자료의 구성안과 문구 배치를 글로 쓴다'],
    never: ['이미지를 만들지 않는다 (범위 밖)'],
  },
  researcher: {
    title: '리서처',
    basedOn: 'strategy',
    canSearchWeb: true,
    ticketTypes: ['research', 'strategy', 'writing'],
    does: ['자료를 조사하고 정리한다', '주장마다 근거 링크를 단다. 근거가 없으면 noSource: true로 드러낸다'],
    never: ['근거 없는 수치를 지어내지 않는다'],
  },
  'design-system': {
    title: '디자인 시스템 담당',
    basedOn: null,
    canSearchWeb: false,
    ticketTypes: [],
    does: ['지시와 계획서를 보고 포인트 디자인 시스템 조합(1~10) 하나를 이유와 함께 고른다'],
    never: ['새 색이나 새 글꼴을 만들지 않는다', '시스템을 고치지 않는다'],
  },
};

export function tempRef(key: string): string {
  return `${TEMP_PREFIX}${key}`;
}

export function isTempRef(id: string): boolean {
  return id.startsWith(TEMP_PREFIX);
}

/** 계획서 단계의 임시 직원 두뇌. 디자인 시스템 담당은 항상 로컬 (6장: Claude 한도를 쓰지 않음, 7-2부터 Gemma). */
export function tempBrain(req: Pick<TempStaffRequest, 'kind' | 'brain'>): Brain {
  // 7-2 전 계획서에 남은 qwen3:14b·gemma4:12b도 지금의 로컬 두뇌로 읽는다
  const asked = req.brain as string | undefined;
  const b: TempBrain = req.kind === 'design-system' || !asked || asked !== 'claude' ? LOCAL_MODEL : 'claude';
  // Claude를 쓰는 임시 직원은 개발자 몫에서 깎인다 (budgetOf가 isTemporary를 보고 dev로 돌린다)
  return b === 'claude' ? { provider: 'claude-code', budget: 'dev' } : { provider: 'ollama', model: b };
}

/** 고용된 임시 직원 ID: tmp-o3-writer-1 */
export function tempEmployeeId(orderId: string, key: string): string {
  return `tmp-${orderId.toLowerCase().replace(/[^a-z0-9]/g, '')}-${key}`;
}

function pickSprite(c: Ctx): string {
  const inUse = new Set(
    c.db
      .select({ s: employees.spriteSet })
      .from(employees)
      .where(and(eq(employees.isTemporary, true), isNull(employees.leftAt)))
      .all()
      .map((r) => r.s),
  );
  return TEMP_SPRITE_SETS.find((s) => !inUse.has(s)) ?? TEMP_SPRITE_SETS[inUse.size % TEMP_SPRITE_SETS.length]!;
}

/** 임시 직원을 들인다. 이미 있으면(같은 지시·같은 key) 그대로 둔다. */
export function hireTemp(c: Ctx, orderId: string, req: TempStaffRequest): EmployeeRow {
  const id = tempEmployeeId(orderId, req.key);
  const existing = c.db.select().from(employees).where(eq(employees.id, id)).get();
  if (existing) return existing;
  const spec = TEMP_KIND_SPECS[req.kind];
  const row = c.db
    .insert(employees)
    .values({
      id,
      displayName: spec.title,
      role: 'temp',
      department: '임시',
      brain: tempBrain(req),
      spriteSet: pickSprite(c),
      status: 'idle',
      canSearchWeb: spec.canSearchWeb,
      isTemporary: true,
      tempKind: req.kind,
      orderId,
    })
    .returning()
    .get();
  // 화면: 방문증을 걸고 문으로 들어온다 (12장)
  emit(c, 'employee.move', { employeeId: id, to: 'door', direction: 'in', visitor: true, kind: req.kind });
  return row;
}

export function dismissTemp(c: Ctx, employeeId: string): void {
  const now = nowIso(c);
  const changed = c.db
    .update(employees)
    .set({ leftAt: now, status: 'idle' })
    .where(and(eq(employees.id, employeeId), eq(employees.isTemporary, true), isNull(employees.leftAt)))
    .run();
  if (changed.changes === 1) emit(c, 'employee.move', { employeeId, to: 'door', direction: 'out', visitor: true });
}

/** 맡은 티켓이 모두 끝난(done, cancelled) 임시 직원을 내보낸다. */
export function dismissFinishedTemps(c: Ctx, orderId: string): string[] {
  const temps = c.db
    .select()
    .from(employees)
    .where(and(eq(employees.orderId, orderId), eq(employees.isTemporary, true), isNull(employees.leftAt)))
    .all();
  const left: string[] = [];
  for (const t of temps) {
    const open = c.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.assigneeId, t.id), inArray(tickets.status, ['planned', 'in_progress', 'in_review', 'rework', 'meeting', 'blocked', 'awaiting_approval', 'paused'])))
      .get();
    if (open) continue;
    dismissTemp(c, t.id);
    left.push(t.id);
  }
  return left;
}

/** 지시가 끝나거나 반려되면 남은 임시 직원을 모두 내보낸다. */
export function dismissAllTemps(c: Ctx, orderId: string): void {
  for (const t of c.db.select().from(employees).where(and(eq(employees.orderId, orderId), eq(employees.isTemporary, true), isNull(employees.leftAt))).all()) {
    dismissTemp(c, t.id);
  }
}

/** 계획서의 임시 직원 규칙 (2장, 2.5단계 결정 E). 문제 목록을 돌려준다. */
export function checkTempRules(
  requests: TempStaffRequest[],
  tickets_: { title: string; type: TicketType; assignee: string; reviewer: string }[],
  reviewerModel: (reviewerId: string) => string | null,
): string[] {
  const problems: string[] = [];
  const byKey = new Map<string, TempStaffRequest>();
  for (const r of requests) {
    if (byKey.has(r.key)) problems.push(`임시 직원 key가 겹침: ${r.key}`);
    byKey.set(r.key, r);
  }
  tickets_.forEach((t, i) => {
    const label = `티켓 ${i + 1}(${t.title})`;
    if (isTempRef(t.reviewer)) problems.push(`${label}: 임시 직원은 검토를 맡지 않음`);
    if (!isTempRef(t.assignee)) return;
    const req = byKey.get(t.assignee.slice(TEMP_PREFIX.length));
    if (!req) {
      problems.push(`${label}: tempStaff에 없는 임시 직원 ${t.assignee}`);
      return;
    }
    const spec = TEMP_KIND_SPECS[req.kind];
    if (!spec.ticketTypes.includes(t.type)) problems.push(`${label}: ${spec.title}은(는) ${t.type} 티켓을 맡지 않음`);
    const b = tempBrain(req);
    const model = b.provider === 'ollama' ? b.model : 'claude';
    const rModel = reviewerModel(t.reviewer);
    if (rModel && rModel === model) problems.push(`${label}: 담당 임시 직원과 검토자(${t.reviewer})가 같은 모델(${model})임`);
  });
  return problems;
}

export function needsDesignCombo(requests: TempStaffRequest[]): boolean {
  return requests.some((r) => r.kind === 'design-system');
}
