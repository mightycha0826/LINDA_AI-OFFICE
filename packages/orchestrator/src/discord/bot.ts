// discord.js 연결 (9장 회사 시스템 봇). discord.js는 이 파일에서만 쓴다.
// - 인텐트는 Guilds, GuildMessages만. 메시지 내용(Message Content)은 받지 않는다:
//   채팅 글자로는 아무것도 하지 않기 때문이다(결재는 버튼만). 주인 메시지는 "접속 중" 표시에만 쓴다.
// - 휴대폰 알림 없이 올릴 때는 SuppressNotifications 플래그(@silent).
// - 멘션은 주인 한 명만 허용한다(allowedMentions).
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
} from 'discord.js';
import type { Ctx } from '../context.ts';
import { SLASH_COMMANDS, type InteractionHandler } from './interactions.ts';
import { markCeoActive } from './presence.ts';
import type { Button, ChannelKey, DiscordPort, InteractionReply, MirrorPort, OutgoingMessage } from './types.ts';

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
  await it.reply({ content, ...(reply.kind === 'reply' && reply.ephemeral ? { flags: MessageFlags.Ephemeral } : {}) });
}

export interface DiscordBot {
  port: DiscordPort;
  mirror: MirrorPort | null;
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
        await respond(it, await o.handler.handle({ type: 'command', userId: it.user.id, name: it.commandName, options, id: it.id }));
      }
    } catch (err) {
      o.log(`Discord 상호작용 처리 실패: ${(err as Error).stack ?? err}`);
    }
  });

  // 주인의 메시지는 "CEO 접속 중" 표시에만 쓴다. 내용은 받지도 읽지도 않는다.
  client.on(Events.MessageCreate, (m) => {
    if (m.guildId === c.config.discord.guildId && m.author.id === c.config.ceoDiscordId) markCeoActive(c);
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

  return {
    port,
    mirror,
    async stop() {
      webhook?.destroy();
      await client.destroy();
    },
  };
}
