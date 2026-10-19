// 오케스트레이터 서비스 (3장). pm2가 띄운다: npm start (또는 ecosystem.config.cjs).
// 설정은 C:\ai-office\data\config.json, 비밀 값은 secrets.json, DB는 office.db (모두 저장소 밖).
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { defaultScreenDirs, startScreenServer } from './http/screen-server.ts';
import { gpuReader } from './screen/gpu.ts';
import { backupHermes } from './retro/hermes-backup.ts';
import { RetroService } from './retro/service.ts';
import { loadSecrets } from './secrets.ts';
import { seedStaff } from './seed.ts';
import { loadSettingOverrides } from './settings.ts';
import { createWeb } from './web/research.ts';
import { ProjectTestRunner } from './workspace/test-runner.ts';
import { GitWorkspace } from './workspace/worktrees.ts';
import { GitCat } from './gitcat/git-cat.ts';
import { NewProjectService } from './workspace/new-project.ts';

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
// /새프로젝트 (11장): 봇은 명령 처리기가 있어야 뜨므로, 채널 포트는 봇이 뜬 뒤에 꺼내 쓴다
const newProjects = new NewProjectService({ c: ctx, gitcat, channels: () => bot?.projectChannels ?? null, discord: () => bot?.port ?? null, log });
if (secrets.discordToken && config.discord.guildId) {
  bot = await startDiscordBot({ c: ctx, handler: new InteractionHandler(ctx, engine, log, gitcat, newProjects), token: secrets.discordToken, ...(secrets.mirrorWebhookUrl ? { webhookUrl: secrets.mirrorWebhookUrl } : {}), log });
  notifier = new Notifier(ctx, bot.port, log);
  mirror = bot.mirror ? new Mirror(ctx, bot.mirror, { log }) : null;
  reports = new ReportService(ctx, engine, bot.port);
} else {
  log('Discord 설정(봇 토큰, 서버 ID)이 없어 Discord 없이 시작해요');
}

const api = await startInternalApi({ port: config.internalApi.port, token: secrets.internalApiToken, tools: new ChiefTools(ctx, engine, reports, gitcat), log });
log(`내부 API 127.0.0.1:${config.internalApi.port}`);

// 사무실 화면 (12장): localhost와 설정한 Tailscale 주소에서만 연다. 보기 전용.
const startedAt = new Date().toISOString();
const readGpu = gpuReader();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const screens = await startScreenServer({ c: ctx, ...defaultScreenDirs(repoRoot), extras: async () => ({ startedAt, gpu: await readGpu() }), log });
log(`사무실 화면 ${config.screen.hosts.map((h) => `http://${h}:${config.screen.port}`).join(', ')}`);

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

const retro = new RetroService(ctx, engine, log);

const timers = [
  every(10_000, '엔진', () => engine.step()),
  every(5_000, '알림', async () => notifier?.tick()),
  every(5_000, 'Git 고양이', () => gitcat.tick()),
  every(config.mirror.flushSec * 1000, '거울', async () => mirror?.flush()),
  // 회고와 학습 (14장): 티켓 회고, 같은 분류 3회 자동 트리거, 일요일 주간 회고, 규칙 후보 관문·결재
  every(60_000, '회고', () => retro.tick()),
  // 헤르메스 기억·스킬 매일 백업 (그날 이미 했으면 건너뜀)
  every(3_600_000, '헤르메스 백업', async () => {
    const r = backupHermes(config, new Date());
    if (r.copied.length) log(`헤르메스 백업 ${r.date}: ${r.copied.join(', ')}`);
  }),
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
  for (const s of screens) s.close();
  await bot?.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
