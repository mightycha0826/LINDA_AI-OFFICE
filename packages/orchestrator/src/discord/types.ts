// Discord 경계 (9장). 회사 로직은 이 타입만 보고, discord.js는 bot.ts 한 곳에서만 쓴다.
// 그래서 실제 Discord 없이 가짜 포트로 결재·알림·거울 규칙을 테스트할 수 있다.

export type ChannelKey = 'secretary' | 'approvals' | 'reports' | 'blocked' | 'mirror';

export interface Button {
  id: string;
  label: string;
  style: 'primary' | 'secondary' | 'success' | 'danger';
  disabled?: boolean;
}

export interface OutgoingMessage {
  channel: ChannelKey;
  content: string;
  buttons?: Button[][];
  /** 휴대폰 알림 없이 올린다 (Discord @silent). 점검 시간 밖에는 이렇게 올린다 (10장) */
  silent?: boolean;
}

export interface SentMessage {
  messageId: string;
  url: string;
}

export interface DiscordPort {
  send(msg: OutgoingMessage): Promise<SentMessage>;
  edit(channel: ChannelKey, messageId: string, msg: { content: string; buttons?: Button[][] }): Promise<void>;
}

/** #사무실-대화 거울 (9장 ⑦). 웹훅으로 메시지마다 직원 이름을 붙인다 */
export interface MirrorPort {
  ensureThread(ticketId: string, title: string): Promise<string>;
  post(threadId: string, m: { username: string; content: string }): Promise<void>;
}

/** 봇이 받은 상호작용. 클릭한 사람의 Discord ID가 항상 함께 온다 */
export type Interaction =
  | { type: 'button'; userId: string; customId: string }
  | { type: 'modal'; userId: string; customId: string; fields: Record<string, string> }
  /** id: Discord 상호작용 ID(스노플레이크). /지시는 이 값을 지시 번호의 중복 방지 키로 쓴다 */
  | { type: 'command'; userId: string; name: string; options: Record<string, string | number | undefined>; id?: string };

export interface ModalField {
  id: string;
  label: string;
  style: 'short' | 'paragraph';
  required: boolean;
}

export type InteractionReply =
  /** CEO가 아니면 아무것도 하지 않는다 (9장: 무시하고 로그만) */
  | { kind: 'ignore' }
  | { kind: 'reply'; content: string; ephemeral: boolean }
  | { kind: 'modal'; customId: string; title: string; fields: ModalField[] }
  /** 버튼이 달린 원래 메시지를 고친다 (결정 뒤 버튼 비활성화 등) */
  | { kind: 'update'; content: string; buttons: Button[][] };
