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
} from 'discord.js';
import type { Ctx } from '../context.ts';
import { SLASH_COMMANDS, type InteractionHandler } from './interactions.ts';
import { onDiscordMessage } from '../chief/order-message.ts';
import { STAFF_BOT_IDS, type StaffBotPort } from './staff-bots.ts';
import type { DirectProposal } from '../core/direct.ts';
import type { StaffMention, StaffReply } from './staff-chat.ts';
import type { Button, ChannelKey, ChannelReplyPort, DiscordPort, InteractionReply, MirrorPort, OutgoingMessage, ProjectChannelPort } from './types.ts';

const STYLE: Record<Button['style'], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

const MAX_CONTENT = 1990;
const fit = (s: string) => (s.length > MAX_CONTENT ? `${s.slice(0, MAX_CONTENT)}…` : s);

function rows(buttons: Button[][] | undefined): ActionRowBuilder<ButtonBuilder>[] {
  return (buttons ?? [])
    .filter((r) => r.length > 0)
    .map((r) =>
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        r.map((b) => new ButtonBuilder().setCustomId(b.id).setLabel(b.label.slice(0, 80)).setStyle(STYLE[b.style]).setDisabled(!!b.disabled)),
      ),
    );
}

async function respond(it: ButtonInteraction | ModalSubmitInteraction | ChatInputCommandInteraction, reply: InteractionReply): Promise<void> {
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
    await it.update({ content: fit(reply.content), components: rows(reply.buttons) });
    return;
  }
  const content = fit(reply.kind === 'update' ? reply.content : reply.content);
  await it.reply({ content, ...(reply.kind === 'reply' && reply.buttons ? { components: rows(reply.buttons) } : {}), ...(reply.kind === 'reply' && reply.ephemeral ? { flags: MessageFlags.Ephemeral } : {}) });
}

export interface DiscordBot {
  port: DiscordPort;
  mirror: MirrorPort | null;
  projectChannels: ProjectChannelPort;
  replies: ChannelReplyPort;
  stop(): Promise<void>;
}

export async function startDiscordBot(o: { c: Ctx; handler: InteractionHandler; token: string; webhookUrl?: string; log: (s: string) => void }): Promise<DiscordBot> {
  const { c } = o;
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
  const channelId = (k: ChannelKey) => c.config.discord.channels[k];

  client.on(Events.InteractionCreate, async (it) => {
    try {
      if (it.isButton()) await respond(it, await o.handler.handle({ type: 'button', userId: it.user.id, customId: it.customId }));
      else if (it.isModalSubmit()) {
        const fields = Object.fromEntries(it.fields.fields.map((f) => [f.customId, 'value' in f ? String(f.value) : '']));
        await respond(it, await o.handler.handle({ type: 'modal', userId: it.user.id, customId: it.customId, fields }));
      } else if (it.isChatInputCommand()) {
        const options = Object.fromEntries(it.options.data.map((x) => [x.name, x.value as string | number | undefined]));
        await respond(it, await o.handler.handle({ type: 'command', userId: it.user.id, name: it.commandName, options, id: it.id, channelId: it.channelId }));
      }
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
  const port: DiscordPort = {
    async send(msg: OutgoingMessage) {
      const ch = await textChannel(msg.channel);
      const sent = await ch.send({
        content: fit(msg.content),
        components: rows(msg.buttons),
        allowedMentions: { users: [c.config.ceoDiscordId] },
        ...(msg.silent ? { flags: MessageFlags.SuppressNotifications } : {}),
      });
      return { messageId: sent.id, url: sent.url };
    },
    async edit(k, messageId, msg) {
      const ch = await textChannel(k);
      await ch.messages.edit(messageId, { content: fit(msg.content), components: rows(msg.buttons) });
    },
  };

  const webhook = o.webhookUrl ? new WebhookClient({ url: o.webhookUrl }) : null;
  const mirror: MirrorPort | null = webhook
    ? {
        async ensureThread(_ticketId, title) {
          const ch = await textChannel('mirror');
          const thread = await ch.threads.create({ name: title, autoArchiveDuration: 10080 });
          return thread.id;
        },
        async post(threadId, m) {
          await webhook.send({ content: fit(m.content), username: m.username.slice(0, 80), threadId, allowedMentions: { parse: [] } });
        },
      }
    : null;

  // /새프로젝트 작업 공간 (9장). 이미 같은 이름이 있으면 그것을 쓴다(다시 시도해도 하나만)
  const projectChannels: ProjectChannelPort = {
    async createProjectChannels(projectId) {
      const guild = await client.guilds.fetch(c.config.discord.guildId);
      const all = await guild.channels.fetch();
      const category =
        all.find((ch) => ch?.type === ChannelType.GuildCategory && ch.name === projectId) ??
        (await guild.channels.create({ name: projectId, type: ChannelType.GuildCategory }));
      const work =
        all.find((ch) => ch?.type === ChannelType.GuildText && ch.parentId === category.id && ch.name === '작업') ??
        (await guild.channels.create({ name: '작업', type: ChannelType.GuildText, parent: category.id, topic: `${projectId} 저장소 일. 여기서 쓴 /지시는 이 프로젝트 일이 돼요` }));
      return { categoryId: category.id, channelId: work.id };
    },
    async sendToChannel(channelId, content) {
      const ch = (await client.channels.fetch(channelId)) as TextChannel;
      await ch.send({ content: fit(content), allowedMentions: { users: [c.config.ceoDiscordId] } });
    },
  };

  // 직원 직접 지시 (2026-10-21): 주인이 말한 채널 바로 아래에 확인 버튼과 진행 소식. 멘션은 주인 한 명만
  const replies: ChannelReplyPort = {
    async reply(channelId, replyToMessageId, msg) {
      const ch = (await client.channels.fetch(channelId)) as TextChannel | ThreadChannel | null;
      if (!ch?.isTextBased()) throw new Error(`글을 쓸 수 없는 채널: ${channelId}`);
      await ch.send({ content: fit(msg.content), components: rows(msg.buttons), reply: { messageReference: replyToMessageId, failIfNotExists: false }, allowedMentions: { users: [c.config.ceoDiscordId], repliedUser: false } });
    },
    async post(channelId, content) {
      const ch = (await client.channels.fetch(channelId)) as TextChannel | ThreadChannel | null;
      if (!ch?.isTextBased()) throw new Error(`글을 쓸 수 없는 채널: ${channelId}`);
      await ch.send({ content: fit(content), allowedMentions: { parse: [] } });
    },
  };

  return {
    port,
    mirror,
    projectChannels,
    replies,
    async stop() {
      webhook?.destroy();
      await client.destroy();
    },
  };
}

/**
 * 직원 봇 9개 (9장). 거울 글·상태 글, 그리고 주인이 멘션하면 대답(2026-10-20 CEO 결정).
 * 인텐트는 Guilds, GuildMessages. 메시지 내용(Message Content) 권한은 켜지 않는다:
 * Discord는 그 봇을 멘션한 글의 내용만 보내 준다. 답할지는 onMention(StaffChat)이 정한다. 명령·버튼·DM 처리기는 없다.
 * 토큰은 로그에 남기지 않는다. 로그인에 실패한 직원은 빠지고(그 직원 글은 웹훅으로), 나머지는 그대로 뜬다.
 */
export async function startStaffBots(o: {
  tokens: Partial<Record<string, string>>;
  log: (s: string) => void;
  onMention?: (employeeId: string, m: StaffMention) => Promise<StaffReply | null>;
  /** 대답에 지시·수정 제안이 붙었을 때 (LINDA가 확인 버튼을 띄운다) */
  onProposal?: (p: DirectProposal) => Promise<void>;
}): Promise<StaffBotPort> {
  const clients = new Map<string, Client<true>>();
  await Promise.all(
    STAFF_BOT_IDS.map(async (id) => {
      const token = o.tokens[id];
      if (!token) return;
      const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
      if (o.onMention) {
        const onMention = o.onMention;
        client.on(Events.MessageCreate, async (m) => {
          try {
            const mentionsMe = !!client.user && m.mentions.users.has(client.user.id);
            if (!mentionsMe) return;
            const reply = await onMention(id, { guildId: m.guildId, channelId: m.channelId, messageId: m.id, authorId: m.author.id, authorIsBot: m.author.bot, mentionsMe, content: m.content });
            if (!reply) return;
            await m.reply({ content: fit(reply.text), allowedMentions: { parse: [], repliedUser: false } });
            if (reply.proposal) await o.onProposal?.(reply.proposal);
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
    async post(id, threadId, content) {
      const client = clients.get(id);
      if (!client) throw new Error(`직원 봇 없음: ${id}`);
      const ch = (await client.channels.fetch(threadId)) as ThreadChannel | TextChannel | null;
      if (!ch?.isTextBased()) throw new Error(`글을 쓸 수 없는 채널·스레드: ${threadId}`);
      await ch.send({ content: fit(content), allowedMentions: { parse: [] } });
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
