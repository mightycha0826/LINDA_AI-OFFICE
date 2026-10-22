// discord.js 연결 (9장 회사 시스템 봇). discord.js는 이 파일에서만 쓴다.
// - 인텐트는 Guilds, GuildMessages만. 메시지 내용(Message Content)은 받지 않는다:
//   채팅 글자로는 아무것도 하지 않기 때문이다(결재는 버튼만). 주인 메시지는 "접속 중" 표시와 #비서실 메시지 ID 기록에만 쓴다.
// - 휴대폰 알림 없이 올릴 때는 SuppressNotifications 플래그(@silent).
// - 멘션은 주인 한 명만 허용한다(allowedMentions).
import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  WebhookClient,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type TextChannel,
  type ThreadChannel,
  type Interaction as DiscordInteraction,
} from 'discord.js';
import { getState, setState, type Ctx } from '../context.ts';
import { discordChunks } from './format.ts';
import { resilientMirror } from './mirror-delivery.ts';
import { ensureProjectChannels } from './project-channels.ts';
import { chiefProjectChannelPort } from './chief-authority.ts';
import { findProject, listProjects, setProjectChannel } from '../workspace/projects.ts';
import { roleDiscordPort } from './role-port.ts';
import { SLASH_COMMANDS, type InteractionHandler } from './interactions.ts';
import { onDiscordMessage } from '../chief/order-message.ts';
import { STAFF_BOT_IDS, type StaffBotPort } from './staff-bots.ts';
import { proposalMessage } from './messages.ts';
import { personalNameOf } from '../staff/org.ts';
import { bindProposalReply } from '../core/direct.ts';
import type { StaffMention, StaffReply } from './staff-chat.ts';
import type { Button, ChannelKey, ChannelReplyPort, DiscordPort, InteractionReply, MirrorPort, OutgoingMessage, ProjectChannelPort } from './types.ts';

const STYLE: Record<Button['style'], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

function rows(buttons: Button[][] | undefined): ActionRowBuilder<ButtonBuilder>[] {
  return (buttons ?? [])
    .filter((r) => r.length > 0)
    .map((r) =>
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        r.map((b) => new ButtonBuilder().setCustomId(b.id).setLabel(b.label.slice(0, 80)).setStyle(STYLE[b.style]).setDisabled(!!b.disabled)),
      ),
    );
}

async function syncPrefixes(c: Ctx, ch: TextChannel, messageId: string, chunks: string[]): Promise<void> {
  const prefixIds = getState<string[]>(c, `discord.parts:${messageId}`, []);
  for (let i = 0; i < Math.max(prefixIds.length, chunks.length - 1); i++) {
    const content = i < chunks.length - 1 ? chunks[i]! : '내용이 갱신됐어요. 아래 최신 내용을 확인해 주세요.';
    if (prefixIds[i]) await ch.messages.edit(prefixIds[i]!, { content, components: [], allowedMentions: { parse: [] } });
    else prefixIds.push((await ch.send({ content, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications })).id);
  }
  if (prefixIds.length) setState(c, `discord.parts:${messageId}`, prefixIds);
}

async function respond(c: Ctx, it: ButtonInteraction | ModalSubmitInteraction | ChatInputCommandInteraction, reply: InteractionReply): Promise<void> {
  if (reply.kind === 'ignore') return;
  if (reply.kind === 'modal') {
    if (it.isModalSubmit()) return;
    const modal = new ModalBuilder().setCustomId(reply.customId).setTitle(reply.title.slice(0, 45));
    for (const f of reply.fields) {
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId(f.id).setLabel(f.label.slice(0, 45)).setStyle(f.style === 'short' ? TextInputStyle.Short : TextInputStyle.Paragraph).setRequired(f.required),
        ),
      );
    }
    await it.showModal(modal);
    return;
  }
  if (reply.kind === 'update' && (it.isButton() || (it.isModalSubmit() && it.isFromMessage()))) {
    const chunks = discordChunks(reply.content);
    await it.update({ content: chunks.at(-1)!, components: rows(reply.buttons), allowedMentions: { parse: [] } });
    const ch = (await it.client.channels.fetch(it.channelId!)) as TextChannel;
    await syncPrefixes(c, ch, it.message!.id, chunks);
    return;
  }
  const chunks = discordChunks(reply.content);
  const ephemeral = reply.kind === 'reply' && reply.ephemeral;
  await it.reply({ content: chunks[0]!, allowedMentions: { parse: [] }, ...(reply.kind === 'reply' && reply.buttons ? { components: rows(reply.buttons) } : {}), ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}) });
  for (const content of chunks.slice(1)) await it.followUp({ content, allowedMentions: { parse: [] }, ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}) });
}

async function dispatch(c: Ctx, handler: InteractionHandler, it: DiscordInteraction): Promise<void> {
  if (it.isButton()) await respond(c, it, await handler.handle({ type: 'button', userId: it.user.id, customId: it.customId }));
  else if (it.isModalSubmit()) {
    const fields = Object.fromEntries(it.fields.fields.map((f) => [f.customId, 'value' in f ? String(f.value) : '']));
    await respond(c, it, await handler.handle({ type: 'modal', userId: it.user.id, customId: it.customId, fields }));
  } else if (it.isChatInputCommand()) {
    const options = Object.fromEntries(it.options.data.map((x) => [x.name, x.value as string | number | undefined]));
    await respond(c, it, await handler.handle({ type: 'command', userId: it.user.id, name: it.commandName, options, id: it.id, channelId: it.channelId }));
  }
}

async function sendRich(c: Ctx, client: Client, channelId: string, msg: OutgoingMessage): Promise<import('./types.ts').SentMessage> {
  const ch = (await client.channels.fetch(channelId)) as TextChannel;
  const chunks = discordChunks(msg.content);
  const prefixIds: string[] = [];
  for (const content of chunks.slice(0, -1)) {
    const part = await ch.send({ content, allowedMentions: { users: [c.config.ceoDiscordId] }, ...(msg.silent ? { flags: MessageFlags.SuppressNotifications } : {}) });
    prefixIds.push(part.id);
  }
  const sent = await ch.send({ content: chunks.at(-1)!, components: rows(msg.buttons), allowedMentions: { users: [c.config.ceoDiscordId], repliedUser: false }, ...(msg.replyToMessageId ? { reply: { messageReference: msg.replyToMessageId, failIfNotExists: false } } : {}), ...(msg.silent ? { flags: MessageFlags.SuppressNotifications } : {}) });
  if (prefixIds.length) setState(c, `discord.parts:${sent.id}`, prefixIds);
  return { messageId: sent.id, url: sent.url };
}

async function editRich(c: Ctx, client: Client, channelId: string, messageId: string, msg: { content: string; buttons?: Button[][] }): Promise<void> {
  const ch = (await client.channels.fetch(channelId)) as TextChannel;
  const chunks = discordChunks(msg.content);
  await syncPrefixes(c, ch, messageId, chunks);
  await ch.messages.edit(messageId, { content: chunks.at(-1)!, components: rows(msg.buttons), allowedMentions: { parse: [] } });
}

export interface DiscordBot {
  port: DiscordPort;
  mirror: MirrorPort | null;
  projectChannels: ProjectChannelPort;
  replies: ChannelReplyPort;
  setStaffBots(bots: StaffBotPort): void;
  stop(): Promise<void>;
}

export async function startDiscordBot(o: { c: Ctx; handler: InteractionHandler; token: string; chiefToken?: string; webhookUrl?: string; log: (s: string) => void }): Promise<DiscordBot> {
  const { c } = o;
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
  if (o.chiefToken && o.chiefToken === o.token) throw new Error('비서실장과 LINDA는 서로 다른 봇 인증을 사용해야 해요.');
  const channelManager = chiefProjectChannelPort(c.config.discord.guildId, o.chiefToken);
  o.log(o.chiefToken ? 'Discord 채널 관리 담당: 백서진(비서실장)' : '비서실장 채널 관리 인증이 없어 새 채널 생성은 대기해요');
  const channelId = (k: ChannelKey) => c.config.discord.channels[k];
  let staffBots: StaffBotPort | null = null;

  client.on(Events.InteractionCreate, async (it) => {
    try {
      await dispatch(c, o.handler, it);
    } catch (err) {
      o.log(`Discord 상호작용 처리 실패: ${(err as Error).stack ?? err}`);
    }
  });

  // 주인의 메시지는 "CEO 접속 중" 표시와 #비서실 마지막 메시지 ID 기록에만 쓴다. 내용은 받지도 읽지도 않는다.
  client.on(Events.MessageCreate, (m) => {
    onDiscordMessage(c, { guildId: m.guildId, channelId: m.channelId, authorId: m.author.id, messageId: m.id });
  });

  client.once(Events.ClientReady, async (ready) => {
    o.log(`Discord 봇 연결: ${ready.user.tag}`);
    const body = SLASH_COMMANDS.map((cmd) => {
      const b = new SlashCommandBuilder().setName(cmd.name).setDescription(cmd.description);
      for (const opt of cmd.options) {
        b.addStringOption((x) => {
          x.setName(opt.name).setDescription(opt.description).setRequired(opt.required);
          if (opt.choices) x.addChoices(...opt.choices.slice(0, 25));
          return x;
        });
      }
      return b.toJSON();
    });
    await new REST().setToken(o.token).put(Routes.applicationGuildCommands(ready.user.id, c.config.discord.guildId), { body });
  });

  await client.login(o.token);

  const textChannel = async (k: ChannelKey) => (await client.channels.fetch(channelId(k))) as TextChannel;
  const port = roleDiscordPort(c, {
    send: (destination, msg) => sendRich(c, client, destination, msg),
    edit: (destination, messageId, msg) => editRich(c, client, destination, messageId, msg),
  }, () => staffBots);

  const webhook = o.webhookUrl ? new WebhookClient({ url: o.webhookUrl }) : null;
  const nativeMirror: MirrorPort = {
    async ensureThread(_ticketId, title) {
      const ch = await textChannel('mirror');
      const thread = await ch.threads.create({ name: title, autoArchiveDuration: 10080 });
      return thread.id;
    },
    async post(threadId, message) {
      const ch = (await client.channels.fetch(threadId)) as ThreadChannel;
      for (const content of discordChunks(`**${message.username}**\n\n${message.content}`)) await ch.send({ content, allowedMentions: { parse: [] } });
    },
  };
  const hookMirror: MirrorPort | null = webhook
    ? {
        ensureThread: nativeMirror.ensureThread,
        async post(threadId, m) {
          for (const content of discordChunks(m.content)) await webhook.send({ content, username: m.username.slice(0, 80), threadId, allowedMentions: { parse: [] } });
        },
      }
    : null;
  const mirror = channelId('mirror') ? resilientMirror(hookMirror, nativeMirror, o.log) : null;

  // 한 프로젝트에 동시에 생성 요청이 와도 카테고리와 채널은 한 번만 만든다.
  const provisioning = new Map<string, Promise<{ categoryId: string; channelId: string; channels: import('./project-channels.ts').ProjectChannelMap }>>();
  const projectChannels: ProjectChannelPort = {
    async createProjectChannels(projectId) {
      if (provisioning.has(projectId)) return provisioning.get(projectId)!;
      const job = (async () => {
        const project = findProject(c, projectId);
        const result = await ensureProjectChannels(channelManager, projectId, { categoryId: project?.discordCategoryId ?? null, channelId: project?.discordChannelId ?? null });
        if (project) setProjectChannel(c, projectId, result);
        return result;
      })();
      provisioning.set(projectId, job);
      try { return await job; } finally { provisioning.delete(projectId); }
    },
    async sendToChannel(channelId, content, employeeId) {
      await port.send({ channel: 'secretary', channelId, content, ...(employeeId ? { employeeId } : {}) });
    },
  };
  client.on(Events.ChannelCreate, async (channel) => {
    if (channel.type !== ChannelType.GuildCategory || channel.guild.id !== c.config.discord.guildId) return;
    const project = listProjects(c).find((p) => p.discordCategoryId === channel.id || p.id === channel.name);
    if (!project) return;
    try { await projectChannels.createProjectChannels(project.id); }
    catch (err) { o.log(`프로젝트 채널 구성 실패(${project.id}): ${(err as Error).message}`); }
  });

  // 직원 직접 지시 (2026-10-21): 주인이 말한 채널 바로 아래에 확인 버튼과 진행 소식. 멘션은 주인 한 명만
  const replies: ChannelReplyPort = {
    async reply(channelId, replyToMessageId, msg) {
      if (msg.employeeId) {
        await port.send({ channel: 'secretary', channelId, replyToMessageId, ...msg });
        return;
      }
      const ch = (await client.channels.fetch(channelId)) as TextChannel | ThreadChannel | null;
      if (!ch?.isTextBased()) throw new Error(`글을 쓸 수 없는 채널: ${channelId}`);
      const chunks = discordChunks(msg.content);
      for (let i = 0; i < chunks.length; i++) await ch.send({ content: chunks[i]!, components: i === chunks.length - 1 ? rows(msg.buttons) : [], reply: { messageReference: replyToMessageId, failIfNotExists: false }, allowedMentions: { users: [c.config.ceoDiscordId], repliedUser: false } });
    },
    async post(channelId, content) {
      const ch = (await client.channels.fetch(channelId)) as TextChannel | ThreadChannel | null;
      if (!ch?.isTextBased()) throw new Error(`글을 쓸 수 없는 채널: ${channelId}`);
      for (const part of discordChunks(content)) await ch.send({ content: part, allowedMentions: { parse: [] } });
    },
  };

  return {
    port,
    mirror,
    projectChannels,
    replies,
    setStaffBots(bots) { staffBots = bots; },
    async stop() {
      webhook?.destroy();
      await client.destroy();
    },
  };
}

/**
 * 직원 봇 9개 (9장). 거울 글·상태 글, 그리고 주인이 멘션하면 대답(2026-10-20 CEO 결정).
 * 인텐트는 Guilds, GuildMessages. 메시지 내용(Message Content) 권한은 켜지 않는다:
 * Discord는 그 봇을 멘션한 글의 내용만 보내 준다. 답할지는 onMention(StaffChat)이 정한다.
 * 직원이 올린 질문·결재·제안 버튼도 공통 CEO 권한 검사기로 처리한다. 명령 등록과 DM 처리는 하지 않는다.
 * 토큰은 로그에 남기지 않는다. 로그인에 실패한 직원은 빠지고(그 직원 글은 웹훅으로), 나머지는 그대로 뜬다.
 */
export async function startStaffBots(o: {
  tokens: Partial<Record<string, string>>;
  log: (s: string) => void;
  c?: Ctx;
  handler?: InteractionHandler;
  onMention?: (employeeId: string, m: StaffMention) => Promise<StaffReply | null>;
}): Promise<StaffBotPort> {
  const clients = new Map<string, Client<true>>();
  await Promise.all(
    STAFF_BOT_IDS.map(async (id) => {
      const token = o.tokens[id];
      if (!token) return;
      const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
      if (o.c && o.handler) {
        const context = o.c;
        const handler = o.handler;
        client.on(Events.InteractionCreate, async (it) => {
          if (!it.isButton() && !it.isModalSubmit()) return;
          try { await dispatch(context, handler, it); }
          catch (err) { o.log(`직원 봇 버튼 처리 실패(${id}): ${(err as Error).message}`); }
        });
      }
      if (o.onMention) {
        const onMention = o.onMention;
        client.on(Events.MessageCreate, async (m) => {
          try {
            const mentionsMe = !!client.user && m.mentions.users.has(client.user.id);
            if (m.author.bot || !m.content || (o.c && m.author.id !== o.c.config.ceoDiscordId)) return;
            const referenced = !mentionsMe && m.reference?.messageId ? await m.fetchReference().catch(() => null) : null;
            const repliesToMe = !!client.user && referenced?.author.id === client.user.id;
            if (!mentionsMe && !repliesToMe) return;
            const reply = await onMention(id, { guildId: m.guildId, channelId: m.channelId, messageId: m.id, authorId: m.author.id, authorIsBot: m.author.bot, mentionsMe, repliesToMe, ...(m.reference?.messageId ? { replyToMessageId: m.reference.messageId } : {}), content: m.content });
            if (!reply) return;
            const proposal = reply.proposal ? proposalMessage(reply.proposal, personalNameOf(id) ?? id) : null;
            const chunks = discordChunks([reply.text, proposal?.content].filter(Boolean).join('\n\n'), 1900, false);
            for (let i = 0; i < chunks.length; i++) {
              const sent = await m.reply({ content: chunks[i]!, failIfNotExists: false, components: i === chunks.length - 1 ? rows(proposal?.buttons) : [], allowedMentions: { parse: [], repliedUser: false } });
              if (o.c && reply.proposal) bindProposalReply(o.c, sent.id, reply.proposal.id);
            }
          } catch (err) {
            o.log(`직원 봇 대답 실패(${id}): ${(err as Error).message}`);
          }
        });
      }
      try {
        const ready = new Promise<Client<true>>((resolve, reject) => {
          client.once(Events.ClientReady, resolve);
          setTimeout(() => reject(new Error('30초 안에 연결되지 않음')), 30_000).unref();
        });
        await client.login(token);
        const c = await ready;
        clients.set(id, c);
        o.log(`직원 봇 연결: ${id} (${c.user.tag})`);
      } catch (err) {
        o.log(`직원 봇 로그인 실패: ${id} (${(err as Error).name})`);
        await client.destroy();
      }
    }),
  );
  return {
    has: (id) => clients.has(id),
    async send(id, channelId, message) {
      const client = clients.get(id);
      if (!client || !o.c) throw new Error(`직원 봇 없음: ${id}`);
      return sendRich(o.c, client, channelId, { ...message, employeeId: id });
    },
    async edit(id, channelId, messageId, message) {
      const client = clients.get(id);
      if (!client || !o.c) throw new Error(`직원 봇 없음: ${id}`);
      await editRich(o.c, client, channelId, messageId, message);
    },
    async post(id, threadId, content) {
      const client = clients.get(id);
      if (!client) throw new Error(`직원 봇 없음: ${id}`);
      const ch = (await client.channels.fetch(threadId)) as ThreadChannel | TextChannel | null;
      if (!ch?.isTextBased()) throw new Error(`글을 쓸 수 없는 채널·스레드: ${threadId}`);
      for (const part of discordChunks(content)) await ch.send({ content: part, allowedMentions: { parse: [] } });
    },
    userIdOf: (id) => clients.get(id)?.user.id ?? null,
    async setStatus(id, text) {
      clients.get(id)?.user.setPresence({ status: text === '대기 중' ? 'idle' : 'online', activities: [{ name: text, state: text, type: ActivityType.Custom }] });
    },
    async stop() {
      await Promise.all([...clients.values()].map((c) => c.destroy()));
      clients.clear();
    },
  };
}
