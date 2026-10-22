import type { MirrorPort } from './types.ts';

/** 웹훅이 만료되어도 한 이벤트에서 전체 거울이 멈추지 않게 시스템 봇으로 전환한다. */
export function resilientMirror(primary: MirrorPort | null, fallback: MirrorPort, log: (s: string) => void = () => {}): MirrorPort {
  let usePrimary = primary !== null;
  return {
    ensureThread: (ticketId, title) => fallback.ensureThread(ticketId, title),
    async post(threadId, message) {
      if (usePrimary && primary) {
        try {
          await primary.post(threadId, message);
          return;
        } catch {
          usePrimary = false;
          log('거울 웹훅 전송 실패: 연결된 시스템 봇으로 전환해요');
        }
      }
      await fallback.post(threadId, message);
    },
  };
}
