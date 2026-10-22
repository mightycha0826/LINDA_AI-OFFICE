// 업무 탭 프로젝트별 보기 (12장, 2026-10-22 CEO 요청): 프로젝트 → 지시 → 티켓 묶음과 순서
import { describe, expect, it } from 'vitest';
import type { ScreenOrder, ScreenTicket } from '@ai-office/shared';
import { projectGroups, projectOf } from './projects.ts';

const ticket = (id: string, status: ScreenTicket['status'], orderId: string, projectId: string | null, assigneeId = 'dev-a'): ScreenTicket => ({
  id,
  orderId,
  projectId,
  title: id,
  type: 'coding',
  status,
  pausedFrom: null,
  pauseReason: null,
  assigneeId,
  reviewerId: 'reviewer',
  reworkCount: 0,
  needsCeoApproval: false,
  branch: null,
  startedAt: null,
  finishedAt: null,
  tokensUsed: 0,
  turnsUsed: 0,
  lowPrecision: false,
});
const order = (id: string, projectId: string | null, createdAt: string): ScreenOrder => ({ id, projectId, text: `${id} 지시`, createdAt });

describe('프로젝트별 묶음', () => {
  it('프로젝트 → 지시로 묶고, 프로젝트 없는 지시는 맨 끝', () => {
    const tickets = [ticket('T-1', 'in_progress', 'O-1', 'shop'), ticket('T-2', 'done', 'O-2', null), ticket('T-3', 'planned', 'O-3', 'blog'), ticket('T-4', 'in_review', 'O-1', 'shop')];
    const orders = [order('O-1', 'shop', '2026-10-20T00:00:00Z'), order('O-2', null, '2026-10-22T00:00:00Z'), order('O-3', 'blog', '2026-10-21T00:00:00Z')];
    const g = projectGroups({ tickets, orders });
    // 막힘이 없으면 최근 지시가 있는 프로젝트가 위 (blog 10-21 > shop 10-20), 프로젝트 없음은 더 최근이어도 끝
    expect(g.map((x) => x.projectId)).toEqual(['blog', 'shop', null]);
    expect(g[1]!.orders.map((o) => o.order.id)).toEqual(['O-1']);
    expect(g[1]!.orders[0]!.tickets.map((t) => t.id)).toEqual(['T-4', 'T-1']);
    expect(g[1]!.counts).toEqual({ active: 2, blocked: 0, done: 0, total: 2 });
  });

  it('막힘이 있는 프로젝트가 맨 위, 지시 안 티켓은 막힘 → 검토 → 진행 → 멈춤 → 대기 → 완료', () => {
    const tickets = [
      ticket('T-10', 'done', 'O-5', 'old'),
      ticket('T-11', 'planned', 'O-5', 'old'),
      ticket('T-12', 'paused', 'O-5', 'old'),
      ticket('T-13', 'in_progress', 'O-5', 'old'),
      ticket('T-14', 'in_review', 'O-5', 'old'),
      ticket('T-15', 'blocked', 'O-5', 'old'),
      ticket('T-20', 'in_progress', 'O-6', 'new'),
    ];
    const orders = [order('O-5', 'old', '2026-10-01T00:00:00Z'), order('O-6', 'new', '2026-10-22T00:00:00Z')];
    const g = projectGroups({ tickets, orders });
    expect(g.map((x) => x.projectId)).toEqual(['old', 'new']);
    expect(g[0]!.orders[0]!.tickets.map((t) => t.status)).toEqual(['blocked', 'in_review', 'in_progress', 'paused', 'planned', 'done']);
    expect(g[0]!.counts).toEqual({ active: 2, blocked: 1, done: 1, total: 6 });
  });

  it('한 프로젝트 안 지시는 최근 것이 위, 같은 시각이면 번호가 큰 것이 위', () => {
    const tickets = [ticket('T-1', 'in_progress', 'O-2', 'shop'), ticket('T-2', 'in_progress', 'O-10', 'shop'), ticket('T-3', 'in_progress', 'O-9', 'shop')];
    const at = '2026-10-22T00:00:00Z';
    const g = projectGroups({ tickets, orders: [order('O-2', 'shop', '2026-10-23T00:00:00Z'), order('O-9', 'shop', at), order('O-10', 'shop', at)] });
    expect(g[0]!.orders.map((o) => o.order.id)).toEqual(['O-2', 'O-10', 'O-9']);
  });

  it('지시 정보가 없어도 묶음은 만든다 (글은 비어 있음)', () => {
    const g = projectGroups({ tickets: [ticket('T-1', 'in_progress', 'O-7', 'shop')], orders: [] });
    expect(g[0]!.orders[0]!.order).toEqual({ id: 'O-7', projectId: 'shop', text: '', createdAt: '' });
  });
});

describe('직원의 지금 프로젝트 (이름표 칩)', () => {
  it('지금 맡은 티켓의 프로젝트, 일이 없거나 프로젝트 없는 지시면 null', () => {
    const tickets = [ticket('T-1', 'in_progress', 'O-1', 'shop', 'dev-a'), ticket('T-2', 'in_progress', 'O-2', null, 'dev-b')];
    expect(projectOf('dev-a', tickets)).toBe('shop');
    expect(projectOf('dev-b', tickets)).toBeNull();
    expect(projectOf('pm', tickets)).toBeNull();
  });
});
