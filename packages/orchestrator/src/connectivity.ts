// 인터넷 끊김 (3장 실행 위치, 10장 점검 시간 밖 자동 안전 정지).
// 끊기면 클라우드 직원(Claude, GPT) 티켓만 paused(offline). 로컬 직원은 계속 일한다. 연결되면 이어간다.
import { and, eq } from 'drizzle-orm';
import { emit, getState, inTx, isStopped, setState, type Ctx } from './context.ts';
import { applyTicketEvent } from './core/tickets.ts';
import { tickets } from './db/schema.ts';

export type Probe = () => Promise<boolean>;

/** 설정의 주소 중 하나라도 HTTPS 응답(상태 코드 상관없음)이 오면 연결된 것으로 본다. */
export function httpProbe(urls: readonly string[], timeoutMs: number): Probe {
  return async () => {
    for (const url of urls) {
      try {
        await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
        return true;
      } catch {
        /* 다음 주소 */
      }
    }
    return false;
  };
}

export class Connectivity {
  private readonly c: Ctx;
  private readonly probe: Probe;

  constructor(c: Ctx, probe?: Probe) {
    this.c = c;
    this.probe = probe ?? httpProbe(c.config.connectivity.probeUrls, c.config.connectivity.probeTimeoutSec * 1000);
  }

  isOnline(): boolean {
    return getState(this.c, 'online', true);
  }

  markOffline(reason: string): void {
    if (!this.isOnline()) return;
    inTx(this.c, (t) => {
      setState(t, 'online', false);
      emit(t, 'system.paused', { by: 'connectivity', reason });
    });
  }

  /** 끊겨 있으면 다시 확인하고, 연결되면 offline으로 멈춘 티켓을 이어간다. 이어간 티켓을 돌려준다. */
  async refresh(): Promise<string[]> {
    if (this.isOnline()) return [];
    if (!(await this.probe())) return [];
    return inTx(this.c, (t) => {
      setState(t, 'online', true);
      emit(t, 'system.resumed', { by: 'connectivity' });
      if (isStopped(t)) return [];
      const waiting = t.db.select().from(tickets).where(and(eq(tickets.status, 'paused'), eq(tickets.pauseReason, 'offline'))).all();
      for (const tk of waiting) applyTicketEvent(t, tk.id, { type: 'system.resume', cause: 'online' }, { kind: 'orchestrator' });
      return waiting.map((tk) => tk.id);
    });
  }
}
