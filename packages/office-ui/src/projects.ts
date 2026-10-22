// 프로젝트별 묶음 (12장 업무 탭 "프로젝트별 보기", 2026-10-22 CEO 요청: 티켓만 늘어서 있어 알아보기 어렵다).
// 프로젝트 → 지시 → 티켓. 화면 그림 없이 스냅샷만 보고 계산해 시험할 수 있게 컴포넌트와 나눴다.
import { currentTicketOf, type ScreenOrder, type ScreenTicket, type Snapshot, type TicketStatus } from '@ai-office/shared';

/** 묶음 안 티켓 순서: 막힘 → 검토 중 → 진행 중 → 멈춤 → 대기 → 완료 */
const ORDER: Record<TicketStatus, number> = {
  blocked: 0,
  in_review: 1,
  awaiting_approval: 1,
  in_progress: 2,
  rework: 2,
  meeting: 2,
  paused: 3,
  planned: 4,
  done: 5,
  cancelled: 6,
};

const ACTIVE = new Set<TicketStatus>(['in_progress', 'rework', 'in_review', 'meeting', 'awaiting_approval']);

export interface OrderGroup {
  order: ScreenOrder;
  tickets: ScreenTicket[];
}

export interface ProjectGroup {
  /** 프로젝트 ID. 프로젝트 없는 지시들의 묶음이면 null */
  projectId: string | null;
  orders: OrderGroup[];
  counts: { active: number; blocked: number; done: number; total: number };
}

/** 지시 정보가 스냅샷에 없을 때(오래된 화면 서버 등) 쓰는 자리표시 */
const unknownOrder = (id: string, projectId: string | null): ScreenOrder => ({ id, projectId, text: '', createdAt: '' });

/**
 * 티켓을 프로젝트 → 지시로 묶는다. 막힘이 있는 프로젝트가 위, 그다음 최근 지시가 있는 프로젝트.
 * 프로젝트 없는 지시는 맨 끝 한 묶음(projectId null). 지시는 최근 것이 위.
 */
export function projectGroups(snapshot: Pick<Snapshot, 'tickets' | 'orders'>, tickets: ScreenTicket[] = snapshot.tickets): ProjectGroup[] {
  const orders = new Map(snapshot.orders.map((o) => [o.id, o]));
  const byProject = new Map<string | null, Map<string, ScreenTicket[]>>();
  for (const t of tickets) {
    const key = t.projectId ?? null;
    const os = byProject.get(key) ?? new Map<string, ScreenTicket[]>();
    os.set(t.orderId, [...(os.get(t.orderId) ?? []), t]);
    byProject.set(key, os);
  }
  const groups: ProjectGroup[] = [...byProject].map(([projectId, os]) => {
    const orderGroups = [...os]
      .map(([orderId, ts]) => ({
        order: orders.get(orderId) ?? unknownOrder(orderId, projectId),
        tickets: [...ts].sort((a, b) => ORDER[a.status] - ORDER[b.status] || ticketNo(a.id) - ticketNo(b.id)),
      }))
      .sort((a, b) => (a.order.createdAt === b.order.createdAt ? ticketNo(b.order.id) - ticketNo(a.order.id) : a.order.createdAt < b.order.createdAt ? 1 : -1));
    const all = orderGroups.flatMap((g) => g.tickets);
    return {
      projectId,
      orders: orderGroups,
      counts: {
        active: all.filter((t) => ACTIVE.has(t.status)).length,
        blocked: all.filter((t) => t.status === 'blocked').length,
        done: all.filter((t) => t.status === 'done').length,
        total: all.length,
      },
    };
  });
  const latest = (g: ProjectGroup) => g.orders[0]?.order.createdAt ?? '';
  return groups.sort((a, b) => {
    if ((a.projectId === null) !== (b.projectId === null)) return a.projectId === null ? 1 : -1;
    if ((a.counts.blocked > 0) !== (b.counts.blocked > 0)) return a.counts.blocked > 0 ? -1 : 1;
    return latest(a) < latest(b) ? 1 : latest(a) > latest(b) ? -1 : 0;
  });
}

/** 그 직원이 지금 맡은 티켓의 프로젝트 (이름표·목록의 프로젝트 칩). 맡은 일이 없거나 프로젝트 없는 지시면 null */
export function projectOf(employeeId: string, tickets: ScreenTicket[]): string | null {
  return currentTicketOf(employeeId, tickets)?.projectId ?? null;
}

function ticketNo(id: string): number {
  return Number(id.replace(/^\D+-/, '')) || 0;
}
