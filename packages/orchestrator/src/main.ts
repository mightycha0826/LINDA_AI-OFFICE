// 오케스트레이터 서비스 (3장). pm2가 띄운다: npm start (또는 ecosystem.config.cjs).
// 설정은 C:\ai-office\data\config.json, 비밀 값은 secrets.json, DB는 office.db (모두 저장소 밖).
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrainRegistry } from './brains/registry.ts';
import { ChiefTools } from './chief/tools.ts';
import { ReportService } from './chief/report-service.ts';
import { secretaryChatReader } from './chief/secretary-chat.ts';
import { systemClock } from './clock.ts';
import { DEFAULTS, loadConfig } from './config.ts';
import { emit, type Ctx } from './context.ts';
import { openDb } from './db/client.ts';
import { startDiscordBot, startStaffBots, type DiscordBot } from './discord/bot.ts';
import { directChannelRoute, routeMirror, StaffPresence, type StaffBotPort } from './discord/staff-bots.ts';
import { CHAT_PERSONAS } from './staff/chat-personas.ts';
import { StaffChat } from './discord/staff-chat.ts';
import { pruneStaffConversations } from './discord/chat-memory.ts';
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
import { loadChiefDiscordToken } from './discord/chief-authority.ts';
import { seedStaff } from './seed.ts';
import { loadGuestRegistry, syncGuests } from './core/guests.ts';
import { backfillRepeatCounts } from './core/repeat-guard.ts';
import { loadSettingOverrides } from './settings.ts';
import { createWeb } from './web/research.ts';
import { ProjectTestRunner } from './workspace/test-runner.ts';
import { GitWorkspace } from './workspace/worktrees.ts';
import { GitCat } from './gitcat/git-cat.ts';
import { NewProjectService } from './workspace/new-project.ts';
import { listProjects } from './workspace/projects.ts';
import { DiffSummarySchema, ExplainOutputSchema, InterpretOutputSchema } from '@ai-office/shared';

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

const dataDir = process.env.AI_OFFICE_DATA ?? DEFAULTS.paths.data;
const config = loadConfig(join(dataDir, 'config.json'));
const secrets = loadSecrets(dataDir);
const ctx: Ctx = { db: openDb(join(dataDir, 'office.db')), config, clock: systemClock };
seedStaff(ctx);
// 파견 직원(친구 계정, 8장): data/guests.json 명단을 직원 표에 맞춘다. 새 계정은 퇴근 상태로 들어온다
try {
  syncGuests(ctx, loadGuestRegistry(dataDir));
} catch (err) {
  log(`파견 명단을 읽지 못했어요(파견 직원 없이 시작): ${(err as Error).message}`);
}
loadSettingOverrides(ctx);
// 같은 반려 반복 막기(5장, 2026-10-23): 업데이트 전부터 돌던 티켓의 횟수를 기존 기록으로 한 번 채운다
for (const f of backfillRepeatCounts(ctx)) log(`같은 반려 횟수를 기록으로 채움: ${f.ticketId} 같은 묶음 ${f.sameFailCount}회 · 한 조건 최대 ${f.maxStreak}회 연속`);

const { brainFor } = createBrainRegistry(config, { onModelSwitch: (from, to) => emit(ctx, 'model.loaded', { from, to }) });
const workspace = new GitWorkspace(ctx);
// 헤르메스(백서진) 봇 인증: 프로젝트 채널 관리와, PM이 읽을 #비서실 대화 (6장)
const chiefToken = loadChiefDiscordToken(config.hermes.homeDir);
const engine = new Engine({ ctx, brainFor, tests: new ProjectTestRunner(ctx), workspace, web: createWeb(config), log, ...(chiefToken ? { readSecretaryChat: secretaryChatReader(ctx, chiefToken) } : {}) });
const gitcat = new GitCat({
  c: ctx,
  tests: new ProjectTestRunner(ctx),
  removeWorktree: (t) => workspace.removeWorktree(t),
  drafter: (info, diffStat) => engine.draftCommit(info, diffStat),
  // 병합 담당(개발팀장): 프로젝트 통합 브랜치 충돌 풀기 (11장, 2026-10-23)
  resolveConflict: (r) => engine.resolveMerge(r),
  // 변경 요약가 (16장 7-5): 푸시 결재 메시지에 붙일 요약
  summarizeDiff: async (ticket, diff) => (await engine.callAs('diff-summarizer', 'summarize', DiffSummarySchema, { ticket, diff }, { workdir: `summarize-${ticket.id}` }))?.lines ?? null,
  // 토큰은 푸시하는 순간에만 파일에서 꺼낸다
  githubToken: () => loadSecrets(dataDir).githubToken,
  log,
});

let bot: DiscordBot | null = null;
let notifier: Notifier | null = null;
let mirror: Mirror | null = null;
let reports: ReportService | null = null;
let staffBots: StaffBotPort | null = null;
let presence: StaffPresence | null = null;
// /새프로젝트 (11장): 봇은 명령 처리기가 있어야 뜨므로, 채널 포트는 봇이 뜬 뒤에 꺼내 쓴다
const newProjects = new NewProjectService({ c: ctx, gitcat, channels: () => bot?.projectChannels ?? null, discord: () => bot?.port ?? null, log });
if (secrets.discordToken && config.discord.guildId) {
  bot = await startDiscordBot({ c: ctx, handler: new InteractionHandler(ctx, engine, log, gitcat, newProjects), token: secrets.discordToken, ...(chiefToken ? { chiefToken } : {}), ...(secrets.mirrorWebhookUrl ? { webhookUrl: secrets.mirrorWebhookUrl } : {}), log });
  // 막힘 해설가·거울 통역사 (16장 7-5). 실패하면 해설·통역 없이 원래대로
  notifier = new Notifier(ctx, bot.port, log, async (notice) => (await engine.callAs('explainer', 'explain', ExplainOutputSchema, { notice }, { workdir: 'explain' }))?.lines ?? null);
  // 직원 봇 9개 (9장). 토큰이 있는 직원만 뜨고, 없거나 실패한 직원의 거울 글은 웹훅으로. 주인이 멘션하면 로컬 Gemma로 대답
  if (secrets.staffBotTokens && Object.keys(secrets.staffBotTokens).length) {
    const chat = new StaffChat(ctx, (id, input) => engine.chatAs(id, input), log);
    staffBots = await startStaffBots({
      tokens: secrets.staffBotTokens,
      c: ctx,
      handler: new InteractionHandler(ctx, engine, log, gitcat, newProjects),
      log,
      onMention: (id, m) => chat.answer(id, m),
    });
    bot.setStaffBots(staffBots);
    presence = new StaffPresence(ctx, staffBots);
  }
  // 기존 프로젝트에도 필요한 채널을 보충한다. 이미 있는 채널은 그대로 사용한다.
  for (const project of listProjects(ctx).filter((p) => p.discordCategoryId || p.discordChannelId)) {
    try { await bot.projectChannels.createProjectChannels(project.id); }
    catch (err) { log(`프로젝트 채널 구성 실패(${project.id}): ${(err as Error).message}`); }
  }
  mirror = bot.mirror
    ? new Mirror(ctx, staffBots ? routeMirror(bot.mirror, staffBots, log) : bot.mirror, {
        log,
        interpret: async (from, content, employeeId) => (await engine.callAs('interpreter', 'interpret', InterpretOutputSchema, { from, content, tone: CHAT_PERSONAS[employeeId as keyof typeof CHAT_PERSONAS]?.tone }, { workdir: 'interpret' }))?.text ?? null,
        // 직원 직접 지시로 시작한 일은 주인이 말한 채널 바로 아래에 (2026-10-21)
        direct: directChannelRoute(staffBots, bot.replies, log),
      })
    : null;
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
  // 재시작해도 마지막 점검부터 30분 간격을 지킨다(내부에 영속 시각 가드).
  every(60_000, '30분 한도 점검', async () => engine.recoverQuotas()),
  every(5_000, '알림', async () => notifier?.tick()),
  every(5_000, 'Git 고양이', () => gitcat.tick()),
  // 끝난 티켓을 프로젝트 통합 브랜치에 차례로 합친다 (로컬만, 11장). 충돌을 푸는 동안에도 푸시 결재는 따로 돈다
  every(10_000, '통합 브랜치', () => gitcat.integrateDone()),
  every(config.mirror.flushSec * 1000, '거울', async () => mirror?.flush()),
  // 회고와 학습 (14장): 티켓 회고, 같은 분류 3회 자동 트리거, 일요일 주간 회고, 규칙 후보 관문·결재
  every(60_000, '회고', () => retro.tick()),
  // 헤르메스 기억·스킬 매일 백업 (그날 이미 했으면 건너뜀)
  every(3_600_000, '헤르메스 백업', async () => {
    const r = backupHermes(config, new Date());
    if (r.copied.length) log(`헤르메스 백업 ${r.date}: ${r.copied.join(', ')}`);
  }),
  every(30_000, '직원 봇 상태', async () => presence?.tick()),
  every(60_000, '지난 대화 정리', async () => pruneStaffConversations(ctx)),
  every(60_000, '접속 상태·보고', async () => {
    refreshPresence(ctx);
    await reports?.fallbackIfMissing();
  }),
];
engine.recoverQuotas();
log('오케스트레이터 시작');

async function shutdown(): Promise<void> {
  log('끝내는 중…');
  for (const t of timers) clearInterval(t);
  api.close();
  for (const s of screens) s.close();
  await staffBots?.stop();
  await bot?.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
