// /설정 (9장 슬래시 명령어). 한도 비율, 보고 시간, 부재 전환 시간, 티켓 상한을 바꾼다.
// 값은 설정 검사(Zod)를 통과해야 반영되고, DB에 남아 재시작 뒤에도 유지된다.
import { z } from 'zod';
import { ConfigSchema, deepMerge, type Config } from './config.ts';
import { emit, getState, inTx, setState, type Ctx } from './context.ts';
import { OfficeError } from './errors.ts';

type Patch = Record<string, unknown>;

interface SettingSpec {
  label: string;
  parse: (raw: string) => Patch;
  show: (c: Config) => string;
}

const num = (raw: string) => {
  const n = Number(raw.trim().replace(/%$/, ''));
  if (!Number.isFinite(n)) throw new OfficeError('setting', `숫자가 아니에요: ${raw}`);
  return n;
};

export const SETTINGS: Record<string, SettingSpec> = {
  'absence-minutes': { label: '부재 전환 시간(분)', parse: (r) => ({ absenceMinutes: num(r) }), show: (c) => `${c.absenceMinutes}분` },
  'report-times': {
    label: '정기 보고 시각 (예: 08:00,18:00,22:00)',
    parse: (r) => ({ schedule: { checkTimes: r.split(',').map((s) => s.trim()).filter(Boolean) } }),
    show: (c) => c.schedule.checkTimes.join(', '),
  },
  'claude-dev-5h': { label: 'Claude 개발 몫 (5시간 %)', parse: (r) => ({ limits: { claude: { fiveHour: { dev: num(r) } } } }), show: (c) => `${c.limits.claude.fiveHour.dev}%` },
  'claude-research-5h': { label: 'Claude 기획 몫·PM (5시간 %)', parse: (r) => ({ limits: { claude: { fiveHour: { research: num(r) } } } }), show: (c) => `${c.limits.claude.fiveHour.research}%` },
  'claude-dev-week': { label: 'Claude 개발 몫 (주간 %)', parse: (r) => ({ limits: { claude: { weekly: { dev: num(r) } } } }), show: (c) => `${c.limits.claude.weekly.dev}%` },
  'claude-research-week': { label: 'Claude 기획 몫·PM (주간 %)', parse: (r) => ({ limits: { claude: { weekly: { research: num(r) } } } }), show: (c) => `${c.limits.claude.weekly.research}%` },
  'gpt-5h': { label: 'GPT 몫 (5시간 %)', parse: (r) => ({ limits: { gpt: { fiveHour: { review: num(r) } } } }), show: (c) => `${c.limits.gpt.fiveHour.review}%` },
  'gpt-week': { label: 'GPT 몫 (주간 %)', parse: (r) => ({ limits: { gpt: { weekly: { review: num(r) } } } }), show: (c) => `${c.limits.gpt.weekly.review}%` },
  'ticket-max-turns': { label: '티켓 턴 상한', parse: (r) => ({ ticketCaps: { maxTurns: num(r) } }), show: (c) => `${c.ticketCaps.maxTurns}턴` },
  'ticket-token-multiplier': { label: '티켓 토큰 상한 배수', parse: (r) => ({ ticketCaps: { tokenMultiplier: num(r) } }), show: (c) => `${c.ticketCaps.tokenMultiplier}배` },
};

/** 설정 객체를 그 자리에서 바꾼다. 모든 Ctx가 같은 객체를 보므로 바로 반영된다. */
function replaceInPlace(target: Config, next: Config): void {
  for (const k of Object.keys(next) as (keyof Config)[]) (target as Record<string, unknown>)[k] = next[k];
}

const OVERRIDES = 'configOverrides';

export function applySetting(c: Ctx, key: string, raw: string): string {
  const { spec, patch, next } = checkSetting(c, key, raw);
  const before = spec.show(c.config);
  inTx(c, (t) => {
    setState(t, OVERRIDES, deepMerge(getState(t, OVERRIDES, {}), patch));
    emit(t, 'usage.updated', { setting: key, before, after: spec.show(next) });
  });
  replaceInPlace(c.config, next);
  return `${spec.label}: ${before} → ${spec.show(c.config)}`;
}

/** 바꾸지 않고 "항목: 지금 → 새 값"만 보여 준다 (비서실장 확인 요청, chief/requests.ts). 반영할 수 없는 값이면 오류 */
export function previewSetting(c: Ctx, key: string, raw: string): string {
  const { spec, next } = checkSetting(c, key, raw);
  return `${spec.label}: ${spec.show(c.config)} → ${spec.show(next)}`;
}

function checkSetting(c: Ctx, key: string, raw: string): { spec: SettingSpec; patch: Patch; next: Config } {
  const spec = Object.hasOwn(SETTINGS, key) ? SETTINGS[key] : undefined;
  if (!spec) throw new OfficeError('setting', `모르는 항목이에요: ${key}`);
  const patch = spec.parse(raw);
  const result = ConfigSchema.safeParse(deepMerge(c.config, patch));
  if (!result.success) throw new OfficeError('setting', `반영하지 않았어요: ${z.prettifyError(result.error)}`);
  return { spec, patch, next: result.data };
}

/** 시작할 때 DB에 남은 /설정 값을 설정 파일 값 위에 덮는다. 검사를 통과하지 못하면 무시한다. */
export function loadSettingOverrides(c: Ctx): void {
  const over = getState<Patch>(c, OVERRIDES, {});
  const result = ConfigSchema.safeParse(deepMerge(c.config, over));
  if (result.success) replaceInPlace(c.config, result.data);
}
