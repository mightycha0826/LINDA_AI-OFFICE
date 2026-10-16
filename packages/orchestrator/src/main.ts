// 오케스트레이터 서비스 (3장). pm2가 띄운다: npm start (또는 ecosystem.config.cjs).
// 설정은 C:\ai-office\data\config.json, 비밀 값은 secrets.json, DB는 office.db (모두 저장소 밖).
import { join } from 'node:path';
import { createBrainRegistry } from './brains/registry.ts';
import { ChiefTools } from './chief/tools.ts';
import { ReportService } from './chief/report-service.ts';
import { systemClock } from './clock.ts';
import { DEFAULTS, loadConfig } from './config.ts';
import { emit, type Ctx } from './context.ts';
import { openDb } from './db/client.ts';
import { startDiscordBot, type DiscordBot } from './discord/bot.ts';
import { InteractionHandler } from './discord/interactions.ts';
import { Mirror } from './discord/mirror.ts';
import { Notifier } from './discord/notifier.ts';
import { refreshPresence } from './discord/presence.ts';
import { Engine } from './engine.ts';
import { startInternalApi } from './http/internal-api.ts';
import { loadSecrets } from './secrets.ts';
import { seedStaff } from './seed.ts';
import { loadSettingOverrides } from './settings.ts';
import { createWeb } from './web/research.ts';
import { ProjectTestRunner } from './workspace/test-runner.ts';
import { GitWorkspace } from './workspace/worktrees.ts';
import { GitCat } from './gitcat/git-cat.ts';

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

const dataDir = process.env.AI_OFFICE_DATA ?? DEFAULTS.paths.data;
const config = loadConfig(join(dataDir, 'config.json'));
const secrets = loadSecrets(dataDir);
const ctx: Ctx = { db: openDb(join(dataDir, 'office.db')), config, clock: systemClock };
seedStaff(ctx);
loadSettingOverrides(ctx);

const { brainFor } = createBrainRegistry(config, { onModelSwitch: (from, to) => emit(ctx, 'model.loaded', { from, to }) });
const workspace = new GitWorkspace(ctx);
const engine = new Engine({ ctx, brainFor, tests: new ProjectTestRunner(ctx), workspace, web: createWeb(config), log });
const gitcat = new GitCat({
  c: ctx,
  tests: new ProjectTestRunner(ctx),
  removeWorktree: (t) => workspace.removeWorktree(t),
  drafter: (info, diffStat) => engine.draftCommit(info, diffStat),
  // 토큰은 푸시하는 순간에만 파일에서 꺼낸다
  githubToken: () => loadSecrets(dataDir).githubToken,
  log,
});

let bot: DiscordBot | null = null;
let notifier: Notifier | null = null;
let mirror: Mirror | null = null;
let reports: ReportService | null = null;
if (secrets.discordToken && config.discord.guildId) {
  bot = await startDiscordBot({ c: ctx, handler: new InteractionHandler(ctx, engine, log, gitcat), token: secrets.discordToken, ...(secrets.mirrorWebhookUrl ? { webhookUrl: secrets.mirrorWebhookUrl } : {}), log });
  notifier = new Notifier(ctx, bot.port, log);
  mirror = bot.mirror ? new Mirror(ctx, bot.mirror, { log }) : null;
  reports = new ReportService(ctx, engine, bot.port);
} else {
  log('Discord 설정(봇 토큰, 서버 ID)이 없어 Discord 없이 시작해요');
}

const api = await startInternalApi({ port: config.internalApi.port, token: secrets.internalApiToken, tools: new ChiefTools(ctx, engine, reports, gitcat), log });
log(`내부 API 127.0.0.1:${config.internalApi.port}`);

/** 같은 일이 겹쳐 돌지 않게 주기적으로 부른다 */
function every(ms: number, name: string, fn: () => Promise<unknown>): NodeJS.Timeout {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      log(`${name} 실패: ${(err as Error).stack ?? err}`);
    } finally {
      running = false;
    }
  }, ms);
}

const timers = [
  every(10_000, '엔진', () => engine.step()),
  every(5_000, '알림', async () => notifier?.tick()),
  every(5_000, 'Git 고양이', () => gitcat.tick()),
  every(config.mirror.flushSec * 1000, '거울', async () => mirror?.flush()),
  every(60_000, '접속 상태·보고', async () => {
    refreshPresence(ctx);
    await reports?.fallbackIfMissing();
  }),
];
log('오케스트레이터 시작');

async function shutdown(): Promise<void> {
  log('끝내는 중…');
  for (const t of timers) clearInterval(t);
  api.close();
  await bot?.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
