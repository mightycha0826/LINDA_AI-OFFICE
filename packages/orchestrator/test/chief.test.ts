// 비서실장 도구와 내부 API (6장, 3단계 결정 A·C).
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ChiefTools } from '../src/chief/tools.ts';
import { TOOL_NAMES } from '../src/chief/tool-defs.ts';
import { approvals, orders, tickets } from '../src/db/schema.ts';
import { startInternalApi } from '../src/http/internal-api.ts';
import { buildMcpServer } from '../src/mcp/server.ts';
import { approvedTickets, setup } from './helpers.ts';

const TOKEN = 'a'.repeat(64);
let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function api(s: ReturnType<typeof setup>) {
  // 빈 포트를 하나 얻은 뒤 그 포트로 연다 (Host 검사에 포트가 들어간다)
  const probe = await startInternalApi({ port: 0, token: TOKEN, tools: new ChiefTools(s.ctx, s.engine, null) });
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  server = await startInternalApi({ port, token: TOKEN, tools: new ChiefTools(s.ctx, s.engine, null) });
  const base = `http://127.0.0.1:${port}`;
  const call = (name: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/tools/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify(body) });
  return { base, port, call };
}

describe('내부 API', () => {
  it('토큰이 없거나 틀리면 401, Host가 다르면 403 (브라우저에서 오는 요청 차단)', async () => {
    const s = setup();
    const { base, call, port } = await api(s);
    expect((await fetch(`${base}/tools/get_status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await call('get_status', {}, { authorization: 'Bearer wrong' })).status).toBe(401);
    // DNS 재바인딩: 다른 이름으로 들어온 요청
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/tools/get_status', method: 'POST', headers: { host: `evil.example:${port}`, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } }, (res) => resolve(res.statusCode ?? 0));
      req.end('{}');
    });
    expect(status).toBe(403);
    expect((await call('get_status', {})).status).toBe(200);
  });

  it('지시 등록은 Discord 메시지 ID가 있어야 하고, 같은 메시지로는 한 번만', async () => {
    const s = setup();
    const { call } = await api(s);
    expect((await call('create_order', { rawText: '로그인 추가해줘' })).status).toBe(400);
    const r1 = (await (await call('create_order', { rawText: '로그인 추가해줘', discordMessageId: '1300000000000000042' })).json()) as { result: { created: boolean } };
    const r2 = (await (await call('create_order', { rawText: '로그인 추가해줘', discordMessageId: '1300000000000000042' })).json()) as { result: { created: boolean } };
    expect([r1.result.created, r2.result.created]).toEqual([true, false]);
    expect(s.db.select().from(orders).all()).toHaveLength(1);
  });

  it('확인 요청은 결재함에 버튼(대기 중 결재)만 만든다. 실행은 없다', async () => {
    const s = setup();
    await approvedTickets(s);
    s.db.update(tickets).set({ branch: 'feature/T1-x' }).where(eq(tickets.id, 'T-1')).run();
    const { call } = await api(s);
    const res = (await (await call('request_confirmation', { kind: 'main-merge', targetId: 'T-1', reason: 'CEO가 main에 push하라고 함' })).json()) as { result: { requested: boolean } };
    expect(res.result.requested).toBe(true);
    const a = s.db.select().from(approvals).where(eq(approvals.kind, 'push')).get()!;
    expect(a).toMatchObject({ status: 'pending', decidedByDiscordId: null });
    expect(a.summary).toContain('main 병합');
    // 비서실장 도구로는 결재를 결정할 길이 없다
    const denied = await call('decide_approval', { approvalId: a.id });
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: string }).error).toContain('없는 도구');
    expect(s.db.select().from(approvals).where(eq(approvals.id, a.id)).get()!.status).toBe('pending');
  });

  it('보고 제출은 Discord가 없으면 올리지 않는다고 알려 준다', async () => {
    const s = setup();
    const { call } = await api(s);
    const res = (await (await call('submit_report', { text: '보고' })).json()) as { result: { posted: boolean } };
    expect(res.result.posted).toBe(false);
  });

  it('읽기 도구', async () => {
    const s = setup();
    await approvedTickets(s);
    const { call } = await api(s);
    const status = (await (await call('get_status', {})).json()) as { result: { inProgress: unknown[]; ceoPresence: string } };
    expect(status.result).toMatchObject({ inProgress: [{ id: 'T-1' }], ceoPresence: 'away' });
    const ticket = (await (await call('get_ticket', { ticketId: 'T-1' })).json()) as { result: { acceptanceCriteria: string[] } };
    expect(ticket.result.acceptanceCriteria).toEqual(['단위 테스트 통과']);
    expect((await call('get_ticket', { ticketId: '../etc' })).status).toBe(400);
  });
});

describe('MCP 서버 (헤르메스가 띄움)', () => {
  it('도구 8개를 알리고, 호출은 내부 API로 넘긴다 (DB를 직접 열지 않음)', async () => {
    const s = setup();
    const { base } = await api(s);
    const mcp = buildMcpServer({ apiBase: base, token: TOKEN });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverT);
    const client = new Client({ name: 'hermes-test', version: '0' });
    await client.connect(clientT);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(TOOL_NAMES).toHaveLength(8);

    const res = await client.callTool({ name: 'create_order', arguments: { rawText: '비밀번호 찾기 추가해줘', discordMessageId: '1300000000000000077' } });
    expect(res.isError).toBeFalsy();
    expect(s.db.select().from(orders).get()!.rawText).toBe('비밀번호 찾기 추가해줘');

    const bad = await client.callTool({ name: 'request_confirmation', arguments: { kind: 'delete', targetId: 'T-1', reason: 'x' } });
    expect(bad.isError).toBe(true); // 이 도구로 삭제는 요청할 수 없다
    await client.close();
  });

  it('토큰이 틀리면 오류로 돌려준다', async () => {
    const s = setup();
    const { base } = await api(s);
    const mcp = buildMcpServer({ apiBase: base, token: 'b'.repeat(64) });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverT);
    const client = new Client({ name: 'hermes-test', version: '0' });
    await client.connect(clientT);
    const res = await client.callTool({ name: 'get_status', arguments: {} });
    expect(res.isError).toBe(true);
    await client.close();
  });
});
