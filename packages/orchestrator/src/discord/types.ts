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

/** #사무실-대화 거울 (9장 ⑦). 직원 봇이 있으면 그 봇으로, 없으면 웹훅에 직원 이름을 붙여 올린다 */
export interface MirrorPort {
  ensureThread(ticketId: string, title: string): Promise<string>;
  /** employeeId: 보낸 직원. 직원 봇으로 보낼지 정할 때 쓴다(회의록·회사 시스템은 없음) */
  post(threadId: string, m: { username: string; content: string; employeeId?: string }): Promise<void>;
}

/**
 * 직원 직접 지시 (9장, 2026-10-21): 주인이 직원 봇을 멘션한 그 채널에 시스템 봇(LINDA)이 바로 아래로 답한다.
 * 확인 버튼([맡기고 시작] 등)과 진행 소식을 올린다. 스레드는 열지 않는다
 */
export interface ChannelReplyPort {
  reply(channelId: string, replyToMessageId: string, msg: { content: string; buttons?: Button[][] }): Promise<void>;
  post(channelId: string, content: string): Promise<void>;
}

/** /새프로젝트의 Discord 작업 공간: 카테고리 <프로젝트> › #작업 (9장). 시스템 봇에 채널 관리 권한이 필요하다 */
export interface ProjectChannelPort {
  /** 같은 이름의 카테고리·#작업이 이미 있으면 그것을 돌려준다(다시 시도해도 두 개 생기지 않음) */
  createProjectChannels(projectId: string): Promise<{ categoryId: string; channelId: string }>;
  sendToChannel(channelId: string, content: string): Promise<void>;
}

/** 봇이 받은 상호작용. 클릭한 사람의 Discord ID가 항상 함께 온다 */
export type Interaction =
  | { type: 'button'; userId: string; customId: string }
  | { type: 'modal'; userId: string; customId: string; fields: Record<string, string> }
  /**
   * id: Discord 상호작용 ID(스노플레이크). /지시는 이 값을 지시 번호의 중복 방지 키로 쓴다.
   * channelId: 명령을 쓴 채널. 프로젝트 #작업 채널이면 /지시가 그 프로젝트 일이 된다
   */
  | { type: 'command'; userId: string; name: string; options: Record<string, string | number | undefined>; id?: string; channelId?: string };

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
