// 12장 사무실 화면 서버: 보기 전용, Host 검사, 스냅샷 내용, SSE 이어 받기, 말풍선 요약
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snapshot } from '@ai-office/shared';
import { deriveEmployeeStatus } from '@ai-office/shared';
import { emit, inTx } from '../src/context.ts';
import { messageSummary } from '../src/core/guards.ts';
import { screenHandler } from '../src/http/screen-server.ts';
import { parseNvidiaSmi } from '../src/screen/gpu.ts';
import { approvedTickets, orderUntilPlanApproval, setup, tempRoot, type Setup } from './helpers.ts';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function serve(s: Setup) {
  const root = tempRoot();
  const staticDir = join(root, 'dist');
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>office</title>');
  writeFileSync(join(root, 'secret.txt'), 'nope');
  const server = createServer(screenHandler({ c: s.ctx, staticDir, pointDir: join(root, 'point'), assetsDir: join(root, 'assets'), extras: () => ({ startedAt: '2026-10-15T00:00:00Z', gpu: null }), pollMs: 20 }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

function call(port: number, path: string, opts: { method?: string; host?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** SSE에서 이벤트 n개를 받을 때까지 읽는다 */
function readEvents(port: number, path: string, n: number, headers: Record<string, string> = {}) {
  return new Promise<{ id: number; type: string }[]>((resolve, reject) => {
    const got: { id: number; type: string }[] = [];
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        let at: number;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const id = /^id: (\d+)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          if (id && data) got.push({ id: Number(id[1]), type: JSON.parse(data[1]!).type });
          if (got.length >= n) {
            req.destroy();
            resolve(got);
          }
        }
      });
    });
    req.on('error', (e) => (got.length >= n ? undefined : reject(e)));
    req.end();
    setTimeout(() => reject(new Error(`이벤트 ${got.length}/${n}개만 받음`)), 3000);
  });
}

describe('화면 서버는 보기 전용', () => {
  it('GET/HEAD 말고는 405. 쓰기 API가 없다', async () => {
    const port = await serve(setup());
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await call(port, '/snapshot', { method });
      expect(r.status).toBe(405);
      expect(r.headers.allow).toBe('GET, HEAD');
    }
  });

  it('허용하지 않은 Host는 403 (DNS 재바인딩 방지)', async () => {
    const port = await serve(setup());
    expect((await call(port, '/snapshot', { host: 'evil.example.com' })).status).toBe(403);
    expect((await call(port, '/snapshot', { host: `localhost:${port}` })).status).toBe(200);
  });

  it('보안 머리글과 정적 파일 경로 탈출 차단', async () => {
    const port = await serve(setup());
    const r = await call(port, '/');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    // blob:은 VRM 텍스처용으로 이미지·연결에만 (스크립트는 여전히 이 서버 파일만)
    expect(r.headers['content-security-policy']).toContain("script-src 'self';");
    expect(r.headers['content-security-policy']).toContain("img-src 'self' data: blob:;");
    expect(r.headers['x-frame-options']).toBe('DENY');
    const esc = await call(port, '/%2e%2e/secret.txt');
    expect(esc.body).not.toContain('nope');
  });

  it('스냅샷: 직원, 결재 대기, 사용량, 마지막 순번', async () => {
    const s = setup();
    await orderUntilPlanApproval(s);
    const port = await serve(s);
    const snap = JSON.parse((await call(port, '/snapshot')).body) as Snapshot;
    expect(snap.employees.map((e) => e.id)).toEqual(expect.arrayContaining(['developer', 'reviewer', 'git-cat', 'chief-of-staff']));
    expect(snap.approvals).toHaveLength(1);
    expect(snap.approvals[0]!.kind).toBe('plan');
    expect(snap.usage.map((u) => u.budget)).toEqual(['dev', 'research', 'review']);
    expect(snap.lastSeq).toBeGreaterThan(0);
    expect(snap.combo).toBe(1);
    expect(snap.employees.find((e) => e.id === 'developer')!.brainLabel).toBe('Claude');
  });

  it('티켓 상세: 완료 조건과 사용량. 없는 티켓은 404', async () => {
    const s = setup();
    const { tickets: [tk] } = await approvedTickets(s);
    const port = await serve(s);
    const d = JSON.parse((await call(port, `/tickets/${tk!.id}`)).body);
    expect(d.acceptanceCriteria.map((x: { criterion: string }) => x.criterion)).toEqual(tk!.acceptanceCriteria);
    expect(d.usage.tokenCap).toBe(tk!.tokenCap);
    expect((await call(port, '/tickets/T-999')).status).toBe(404);
  });
});

describe('SSE 이벤트', () => {
  it('순번(id)이 붙어 오고, Last-Event-ID 다음부터 이어 받는다', async () => {
    const s = setup();
    const port = await serve(s);
    for (let i = 0; i < 3; i++) inTx(s.ctx, (c) => emit(c, 'model.loaded', { from: 'a', to: `m${i}` }));
    const all = await readEvents(port, '/events', 3);
    expect(all.map((e) => e.type)).toEqual(['model.loaded', 'model.loaded', 'model.loaded']);
    const resumed = await readEvents(port, '/events', 1, { 'last-event-id': String(all[1]!.id) });
    expect(resumed[0]!.id).toBe(all[2]!.id);
  });

  it('?after=로 시작하면 그 뒤에 생긴 이벤트만 받는다', async () => {
    const s = setup();
    const port = await serve(s);
    const before = inTx(s.ctx, (c) => emit(c, 'model.loaded', { from: 'a', to: 'b' }));
    const p = readEvents(port, `/events?after=${before}`, 1);
    setTimeout(() => inTx(s.ctx, (c) => emit(c, 'ceo.presence', { present: true })), 50);
    expect((await p)[0]).toMatchObject({ type: 'ceo.presence' });
  });
});

describe('화면 데이터 규칙', () => {
  it('직원 상태: 막힘 > 회의 > 작업 > 검토 > 일시정지 > 대기', () => {
    const t = (status: string, assigneeId = 'dev', reviewerId = 'rev') => ({ status, assigneeId, reviewerId, pausedFrom: null }) as never;
    expect(deriveEmployeeStatus('dev', [t('in_progress'), t('blocked')])).toBe('blocked');
    expect(deriveEmployeeStatus('rev', [t('in_review')])).toBe('reviewing');
    expect(deriveEmployeeStatus('dev', [t('in_review')])).toBe('idle');
    expect(deriveEmployeeStatus('dev', [t('paused')])).toBe('paused');
    expect(deriveEmployeeStatus('dev', [], '2026-10-15T00:00:00Z')).toBe('away');
  });

  it('말풍선 요약: JSON 출력에서 사람이 읽을 한 줄을 고른다 (40자 이내)', () => {
    expect(messageSummary('{"summary":"로그인 구현","changedFiles":[]}')).toBe('로그인 구현');
    expect(messageSummary('{"verdict":"fail","reason":"테스트 2개 실패"}')).toBe('반려: 테스트 2개 실패');
    expect(messageSummary('{"document":"# 요금 안내\\n본문"}')).toBe('요금 안내');
    expect(messageSummary('그냥 문장입니다')).toBe('그냥 문장입니다');
    expect(messageSummary('가'.repeat(60))).toHaveLength(40);
    expect(messageSummary('{"broken": ')).toBe('{"broken":');
  });

  it('nvidia-smi 출력 읽기', () => {
    expect(parseNvidiaSmi('9876, 16384\n')).toEqual({ usedMB: 9876, totalMB: 16384 });
    expect(parseNvidiaSmi('NVIDIA-SMI has failed')).toBeNull();
  });
});
