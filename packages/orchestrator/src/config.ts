// 회사 설정. 한도 비율(8장), 티켓 상한(5장), 핑퐁 기준 등. `/설정`이 바꾸는 값들이다.
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const pct = z.number().min(0).max(100);
const count = z.number().int().positive();

export const ConfigSchema = z
  .object({
    /** 결재를 인정하는 유일한 Discord 계정 (7장, 9장) */
    ceoDiscordId: z.string().regex(/^\d{17,20}$/, 'Discord 사용자 ID(숫자 17~20자리)여야 한다'),
    limits: z.object({
      claude: z.object({
        fiveHour: z.object({ dev: pct, research: pct }),
        weekly: z.object({ dev: pct, research: pct }),
      }),
      gpt: z.object({
        fiveHour: z.object({ review: pct }),
        weekly: z.object({ review: pct }),
      }),
    }),
    ticketCaps: z.object({
      /** 토큰 상한 = PM 예상치 × 배수 (최소 minTokens) */
      tokenMultiplier: z.number().positive(),
      minTokens: count,
      maxTurns: count,
    }),
    /** 같은 담당자·검토자 쌍이 상태 변화 없이 연속으로 주고받으면 차단할 메시지 수 */
    pingpongLimit: z.number().int().min(2),
    meetingMaxRounds: count,
    /** 관문 반려 최대 횟수. 넘으면 반대 의견을 붙여 CEO에게 올린다 */
    maxGateRejections: count,
    /** 부재 모드 전환 시간(분), 10장 */
    absenceMinutes: count,
  })
  .superRefine((c, ctx) => {
    const { claude, gpt } = c.limits;
    if (claude.fiveHour.dev + claude.fiveHour.research > 100) ctx.addIssue({ code: 'custom', message: 'Claude 5시간 몫 합이 100%를 넘는다' });
    if (claude.weekly.dev + claude.weekly.research > 100) ctx.addIssue({ code: 'custom', message: 'Claude 주간 몫 합이 100%를 넘는다' });
    if (gpt.fiveHour.review > 100 || gpt.weekly.review > 100) ctx.addIssue({ code: 'custom', message: 'GPT 몫이 100%를 넘는다' });
  });
export type Config = z.infer<typeof ConfigSchema>;

/** 설계 문서의 기본값. ceoDiscordId는 기본값이 없다. */
export const DEFAULTS: Omit<Config, 'ceoDiscordId'> = {
  limits: {
    // 회사 전체 5시간 70% = 개발 55 + 리서치 15, 주간 50% = 79:21 비율 (8장)
    claude: { fiveHour: { dev: 55, research: 15 }, weekly: { dev: 39.5, research: 10.5 } },
    gpt: { fiveHour: { review: 70 }, weekly: { review: 50 } },
  },
  ticketCaps: { tokenMultiplier: 2, minTokens: 20_000, maxTurns: 40 },
  pingpongLimit: 3,
  meetingMaxRounds: 2,
  maxGateRejections: 2,
  absenceMinutes: 20,
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (!over) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' ? merge(b, v as DeepPartial<typeof b>) : v;
  }
  return out as T;
}

export function makeConfig(over: DeepPartial<Config> & { ceoDiscordId: string }): Config {
  return ConfigSchema.parse(merge({ ...DEFAULTS, ceoDiscordId: over.ceoDiscordId }, over));
}

/** JSON 설정 파일을 읽어 기본값 위에 덮는다. 형식이 틀리면 시작하지 않는다. */
export function loadConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as DeepPartial<Config>;
  const result = ConfigSchema.safeParse(merge({ ...DEFAULTS, ceoDiscordId: '' }, raw));
  if (!result.success) throw new Error(`설정 파일 오류 (${path}):\n${z.prettifyError(result.error)}`);
  return result.data;
}
