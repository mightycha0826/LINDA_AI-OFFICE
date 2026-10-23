// 데이터 연결 (12장 데이터 흐름): GET /snapshot으로 전체 상태를 받고, GET /events(SSE)로 바뀐 것을 받는다.
// 끊겼다 다시 붙으면 브라우저가 Last-Event-ID를 보내 마지막 순번 다음부터 이어 받는다.
// 목록은 이벤트가 오면 스냅샷을 다시 받아 맞추고(정확성, 0.8초에 한 번으로 묶음), 이벤트는 그대로 애니메이션에 쓴다(움직임).
import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '@ai-office/shared';

export interface LiveEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type Connection = 'loading' | 'live' | 'reconnecting' | 'failed';

export function useOffice(onEvent: (e: LiveEvent) => void) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<Connection>('loading');
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let refreshTimer: number | null = null;

    const load = async () => {
      const res = await fetch('/snapshot', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as Snapshot;
    };
    const refresh = () => {
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(async () => {
        refreshTimer = null;
        try {
          const s = await load();
          if (!closed) setSnapshot(s);
        } catch {
          /* 다음 이벤트 때 다시 */
        }
      }, 800);
    };

    const start = async () => {
      try {
        const s = await load();
        if (closed) return;
        setSnapshot(s);
        source = new EventSource(`/events?after=${s.lastSeq}`);
        // 다시 붙으면 스냅샷도 다시 받아 놓친 것을 맞춘다
        source.onopen = () => {
          setConnection('live');
          refresh();
        };
        source.onerror = () => setConnection('reconnecting');
        source.onmessage = (msg) => {
          const e = JSON.parse(msg.data) as LiveEvent;
          handler.current(e);
          refresh();
        };
        setConnection('live');
      } catch {
        if (!closed) setConnection('failed');
      }
    };
    void start();
    return () => {
      closed = true;
      source?.close();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, []);

  return { snapshot, connection, retry: () => window.location.reload() };
}

export async function fetchTicket(id: string) {
  const res = await fetch(`/tickets/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as TicketDetail;
}

export interface TicketDetail {
  ticket: Snapshot['tickets'][number];
  acceptanceCriteria: { criterion: string; pass: boolean | null; reason?: string }[];
  summary: string | null;
  log: { id: string; at: string; fromId: string; toId: string | null; kind: string; text: string }[];
  minutes: { id: string; kind: string; outcome: string; rounds: { round: number; positions: { employeeId: string; claim: string; needsCeo?: { kind: string; question: string } }[] }[]; nextActions: string[] }[];
  usage: { tokens: number; turns: number; tokenCap: number | null; turnCap: number | null };
}
