// 가짜 Discord: 보낸 메시지와 수정 내역을 기록한다.
import type { Button, ChannelKey, DiscordPort, MirrorPort, OutgoingMessage } from '../../src/discord/types.ts';

export class FakeDiscord implements DiscordPort {
  readonly sent: (OutgoingMessage & { id: string })[] = [];
  readonly edits: { channel: ChannelKey; messageId: string; content: string; buttons?: Button[][] }[] = [];
  failNext = false;
  private n = 1000;

  async send(msg: OutgoingMessage) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Discord 503');
    }
    const id = String(++this.n);
    this.sent.push({ ...msg, id });
    return { messageId: id, url: `https://discord.com/channels/g/${msg.channel}/${id}` };
  }

  async edit(channel: ChannelKey, messageId: string, msg: { content: string; buttons?: Button[][] }) {
    this.edits.push({ channel, messageId, ...msg });
  }

  in(channel: ChannelKey) {
    return this.sent.filter((m) => m.channel === channel);
  }
}

export class FakeMirror implements MirrorPort {
  readonly threads: { ticketId: string; title: string; id: string }[] = [];
  readonly posts: { threadId: string; username: string; content: string }[] = [];

  async ensureThread(ticketId: string, title: string) {
    const id = `thread-${ticketId}`;
    this.threads.push({ ticketId, title, id });
    return id;
  }

  async post(threadId: string, m: { username: string; content: string }) {
    this.posts.push({ threadId, ...m });
  }
}
