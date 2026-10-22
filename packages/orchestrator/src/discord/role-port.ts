import { getState, setState, type Ctx } from '../context.ts';
import type { StaffBotPort } from './staff-bots.ts';
import type { Button, DiscordPort, OutgoingMessage, SentMessage } from './types.ts';

type Update = { content: string; buttons?: Button[][] };

/** 발신 직원과 실제 채널을 기록해, 재시작·프로젝트 채널 변경 뒤에도 원래 메시지를 수정한다. */
export function roleDiscordPort(c: Ctx, system: {
  send(channelId: string, msg: OutgoingMessage): Promise<SentMessage>;
  edit(channelId: string, messageId: string, msg: Update): Promise<void>;
}, staff: () => StaffBotPort | null): DiscordPort {
  return {
    async send(msg) {
      const channelId = msg.channelId ?? c.config.discord.channels[msg.channel];
      let sent: SentMessage;
      if (msg.employeeId) {
        const bots = staff();
        if (!bots?.has(msg.employeeId) || !bots.send) throw new Error(`담당 직원 봇 연결 대기: ${msg.employeeId}`);
        sent = await bots.send(msg.employeeId, channelId, msg);
      } else sent = await system.send(channelId, msg);
      setState(c, `discord.delivery:${sent.messageId}`, { channelId, employeeId: msg.employeeId ?? null });
      return sent;
    },
    async edit(channel, messageId, msg) {
      const delivery = getState<{ channelId: string; employeeId: string | null } | null>(c, `discord.delivery:${messageId}`, null);
      const channelId = delivery?.channelId ?? c.config.discord.channels[channel];
      if (delivery?.employeeId) {
        const bots = staff();
        if (!bots?.has(delivery.employeeId) || !bots.edit) throw new Error(`담당 직원 봇 연결 대기: ${delivery.employeeId}`);
        return bots.edit(delivery.employeeId, channelId, messageId, msg);
      }
      await system.edit(channelId, messageId, msg);
    },
  };
}
