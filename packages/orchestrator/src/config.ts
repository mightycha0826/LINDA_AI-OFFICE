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
    /** 작업 공간 (3장: C:\ai-office\ 아래에만 둔다) */
    paths: z.object({
      /** 티켓 worktree와 샌드박스. AI 직원은 이 안에서만 일한다 (7장) */
      wt: z.string().min(1),
      /** 오케스트레이터 전용 파일(프롬프트, 스키마, 설정). worktree 밖이라 AI가 고칠 수 없다 */
      data: z.string().min(1),
      /** 등록된 저장소 (11장: C:\ai-office\repos\<id>) */
      repos: z.string().min(1),
    }),
    ollama: z.object({
      host: z.url(),
      numCtx: count,
      timeoutSec: count,
      keepAlive: z.string(),
      /** GPU 대기열: 이보다 오래 기다린 요청은 모델이 달라도 먼저 처리한다 */
      maxWaitSec: count,
    }),
    claude: z.object({
      bin: z.string().min(1),
      /** 테스트에서 가짜 CLI를 node로 띄울 때 쓰는 앞 인자 */
      binArgs: z.array(z.string()),
      timeoutMin: count,
      maxTurns: count,
    }),
    codex: z.object({
      bin: z.string().min(1),
      binArgs: z.array(z.string()),
      timeoutMin: count,
      /** 0단계 #6에서 확인: 프롬프트를 stdin으로 넘길지 인자로 넘길지 */
      promptVia: z.enum(['stdin', 'arg']),
    }),
    tests: z.object({ timeoutMin: count }),
    /**
     * 토큰 → 한도 % 환산 계수 (8장 측정 방식). 0단계 #5 전까지는 임시값이고,
     * 처음 1~2주 동안 실제 사용량 화면과 비교해 맞춘다. 화면과 보고에는 항상 "추정치"로 표시한다.
     */
    calibration: z.object({
      claude: z.object({ tokensPerFiveHourPct: count, tokensPerWeeklyPct: count }),
      gpt: z.object({ tokensPerFiveHourPct: count, tokensPerWeeklyPct: count }),
    }),
    /** 로컬 메타검색 (15장). 127.0.0.1에서만 띄운다 */
    searxng: z.object({
      host: z.url(),
      maxPerMinute: count,
      timeoutSec: count,
      resultsPerQuery: count,
    }),
    /** 근거 링크 가져오기 상한 (2.5단계 결정 F) */
    web: z.object({
      maxBytes: count,
      timeoutSec: count,
      maxCharsPerPage: count,
      maxLinksPerTicket: count,
    }),
    connectivity: z.object({
      /** 클라우드 두뇌가 닿는지 확인할 주소 */
      probeUrls: z.array(z.url()).min(1),
      probeTimeoutSec: count,
    }),
    /** Discord (9장). 채널은 ID로 적는다. 봇 토큰과 웹훅 주소는 secrets.json에 둔다 */
    discord: z.object({
      guildId: z.string(),
      channels: z.object({
        secretary: z.string(),
        approvals: z.string(),
        reports: z.string(),
        blocked: z.string(),
        mirror: z.string(),
      }),
    }),
    /** 정기 점검과 알림 (10장) */
    schedule: z.object({
      timezone: z.string(),
      /** 정기 점검(보고) 시각 HH:MM */
      checkTimes: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1),
      /** 점검 시각부터 이 시간 동안은 즉시 알림을 보낸다 */
      checkWindowMin: count,
      /** 비서실장 보고를 기다리는 시간. 넘으면 시스템 봇이 데이터만으로 보고한다 */
      reportGraceMin: count,
      /** 한 시간에 보내는 즉시 알림(멘션) 상한 */
      maxImmediatePerHour: count,
    }),
    /** 비서실장 MCP 서버가 쓰는 내부 API. 127.0.0.1에서만 연다 */
    internalApi: z.object({ port: z.number().int().min(1024).max(65535) }),
    /** 사무실 화면 주소 (Discord 메시지의 "화면에서 보기" 링크). 5단계 전에는 비워 둔다 */
    screenUrl: z.string(),
    /** 거울 채널 묶어 보내기 간격과 한 메시지 길이 상한 (9장 ⑦) */
    mirror: z.object({ flushSec: count, maxChars: count }),
    /** Git 고양이 (11장) */
    gitcat: z.object({
      authorName: z.string().min(1),
      authorEmail: z.string().min(3),
      /** 이보다 큰 파일이 들어 있으면 푸시하지 않는다 */
      maxFileMB: count,
      gitleaksBin: z.string().min(1),
      gitleaksArgs: z.array(z.string()),
      timeoutMin: count,
    }),
    /** 사무실 화면 (12장). 보기 전용. localhost와 Tailscale 주소에서만 연다 */
    screen: z.object({
      port: z.number().int().min(1024).max(65535),
      /** 열 주소. 127.0.0.1 말고는 Tailscale 주소(100.x.y.z)만 적는다 */
      hosts: z.array(z.string().min(1)).min(1),
      /** 브라우저가 보내는 Host 이름으로 허용할 것 (예: Tailscale MagicDNS 이름) */
      allowedHostnames: z.array(z.string()),
      /** 포인트 디자인 시스템 조합 1~10 (17장). 5단계 시작 때 CEO에게 묻고, 답이 없으면 1 */
      combo: z.number().int().min(1).max(10),
      companyName: z.string().min(1),
    }),
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
  paths: { wt: 'C:\\ai-office\\wt', data: 'C:\\ai-office\\data', repos: 'C:\\ai-office\\repos' },
  ollama: { host: 'http://127.0.0.1:11434', numCtx: 16_384, timeoutSec: 600, keepAlive: '30m', maxWaitSec: 120 },
  claude: { bin: 'claude', binArgs: [], timeoutMin: 30, maxTurns: 40 },
  codex: { bin: 'codex', binArgs: [], timeoutMin: 15, promptVia: 'stdin' },
  tests: { timeoutMin: 15 },
  // 임시값. 0단계 #5와 첫 1~2주 운영으로 보정한다.
  calibration: {
    claude: { tokensPerFiveHourPct: 20_000, tokensPerWeeklyPct: 100_000 },
    gpt: { tokensPerFiveHourPct: 20_000, tokensPerWeeklyPct: 100_000 },
  },
  searxng: { host: 'http://127.0.0.1:8888', maxPerMinute: 10, timeoutSec: 15, resultsPerQuery: 6 },
  web: { maxBytes: 2 * 1024 * 1024, timeoutSec: 10, maxCharsPerPage: 8000, maxLinksPerTicket: 15 },
  connectivity: { probeUrls: ['https://api.anthropic.com', 'https://api.openai.com'], probeTimeoutSec: 5 },
  discord: { guildId: '', channels: { secretary: '', approvals: '', reports: '', blocked: '', mirror: '' } },
  schedule: { timezone: 'Asia/Seoul', checkTimes: ['08:00', '18:00', '22:00'], checkWindowMin: 30, reportGraceMin: 10, maxImmediatePerHour: 6 },
  internalApi: { port: 8790 },
  screenUrl: '',
  mirror: { flushSec: 5, maxChars: 300 },
  gitcat: { authorName: 'Git 고양이', authorEmail: 'git-cat@ai-office.local', maxFileMB: 50, gitleaksBin: 'gitleaks', gitleaksArgs: [], timeoutMin: 20 },
  screen: { port: 8780, hosts: ['127.0.0.1'], allowedHostnames: ['localhost', '127.0.0.1'], combo: 1, companyName: 'AI 사무실' },
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
