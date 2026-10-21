// 사무실 화면 서버 (12장). 보기 전용이다.
// - GET/HEAD만 받는다. 쓰기 API는 없다. 결재와 푸시는 Discord에서만.
// - localhost와 설정한 Tailscale 주소에서만 연다. Host 머리글도 확인한다(DNS 재바인딩 방지).
// - GET /snapshot: 현재 전체 상태, GET /events: SSE(순번 = events.seq, Last-Event-ID로 이어 받기),
//   GET /tickets/<id>: 티켓 상세. 나머지는 화면 파일(office-ui/dist), /point/는 포인트 디자인 시스템, /assets/는 캐릭터 그림·증명사진.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { gt } from 'drizzle-orm';
import type { Ctx } from '../context.ts';
import { events } from '../db/schema.ts';
import type { Snapshot } from '@ai-office/shared';
import { buildSnapshot, buildTicketDetail, type SnapshotExtras } from '../screen/snapshot.ts';
import { isInside } from '../workspace/paths.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.vrm': 'model/gltf-binary',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    // blob:은 VRM 안의 텍스처를 읽을 때 브라우저가 페이지 안에서 만드는 주소 (13장 3D 캐릭터)
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' blob:; frame-ancestors 'none'",
};

export interface ScreenServerOptions {
  c: Ctx;
  /** office-ui 빌드 결과 */
  staticDir: string;
  /** design-systems/point */
  pointDir: string;
  /** assets (characters/<세트>/…, portraits/<직원 ID>.webp, models/<직원 ID>.vrm) */
  assetsDir: string;
  extras: () => Promise<SnapshotExtras> | SnapshotExtras;
  /** SSE가 새 이벤트를 확인하는 간격 */
  pollMs?: number;
  log?: (s: string) => void;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

const PORTRAIT_EXTS = ['.webp', '.png', '.jpg', '.jpeg'] as const;

/** 증명사진 (13장): assets/portraits/<직원 ID>.(webp|png|jpg) 중 처음 찾은 것의 주소 */
export function portraitOf(assetsDir: string, employeeId: string): string | null {
  if (!/^[\w-]+$/.test(employeeId)) return null;
  for (const ext of PORTRAIT_EXTS) {
    if (existsSync(join(assetsDir, 'portraits', employeeId + ext))) return `/assets/portraits/${employeeId}${ext}`;
  }
  return null;
}

/** 3D 캐릭터 (13장): assets/models/<직원 ID>.vrm이 있으면 그 주소 */
export function modelOf(assetsDir: string, employeeId: string): string | null {
  if (!/^[\w-]+$/.test(employeeId)) return null;
  return existsSync(join(assetsDir, 'models', employeeId + '.vrm')) ? `/assets/models/${employeeId}.vrm` : null;
}

function withAssets(snap: Snapshot, assetsDir: string): Snapshot {
  return { ...snap, employees: snap.employees.map((e) => ({ ...e, portrait: portraitOf(assetsDir, e.id), model: modelOf(assetsDir, e.id) })) };
}

function sendFile(res: ServerResponse, root: string, rel: string, head: boolean): boolean {
  const file = resolve(root, '.' + rel);
  if (!isInside(root, file) || !existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY_HEADERS });
  res.end(head ? undefined : readFileSync(file));
  return true;
}

export function screenHandler(o: ScreenServerOptions) {
  const pollMs = o.pollMs ?? 1000;
  const allowed = () => new Set([...o.c.config.screen.allowedHostnames, ...o.c.config.screen.hosts].map((h) => h.toLowerCase()));

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const hostname = String(req.headers.host ?? '')
        .replace(/:\d+$/, '')
        .replace(/^\[|\]$/g, '')
        .toLowerCase();
      if (!allowed().has(hostname)) return sendJson(res, 403, { error: 'host' });
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', ...SECURITY_HEADERS });
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://screen');
      const path = decodeURIComponent(url.pathname);

      if (path === '/snapshot') return sendJson(res, 200, withAssets(buildSnapshot(o.c, await o.extras()), o.assetsDir));
      const tm = /^\/tickets\/(T-\d+)$/.exec(path);
      if (tm) {
        const d = buildTicketDetail(o.c, tm[1]!);
        return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'not-found' });
      }
      if (path === '/events') return sse(req, res, url);
      if (path.startsWith('/point/') && sendFile(res, o.pointDir, path.slice('/point'.length), req.method === 'HEAD')) return;
      if (path.startsWith('/assets/') && sendFile(res, o.assetsDir, path.slice('/assets'.length), req.method === 'HEAD')) return;
      if (path !== '/' && sendFile(res, o.staticDir, path, req.method === 'HEAD')) return;
      // 한 페이지 앱: 나머지는 index.html
      if (sendFile(res, o.staticDir, '/index.html', req.method === 'HEAD')) return;
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('화면 파일이 없어요. npm run build:screen을 먼저 실행해 주세요');
    } catch (err) {
      o.log?.(`화면 서버 오류: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
    }
  };

  /** SSE: 끊겼다 다시 붙으면 Last-Event-ID 다음부터 이어 보낸다 (12장 데이터 흐름 3) */
  function sse(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const fromHeader = Number(req.headers['last-event-id']);
    const fromQuery = Number(url.searchParams.get('after'));
    let cursor = Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : Number.isFinite(fromQuery) && fromQuery > 0 ? fromQuery : 0;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', ...SECURITY_HEADERS });
    res.write('retry: 3000\n\n');
    const push = () => {
      const rows = o.c.db.select().from(events).where(gt(events.seq, cursor)).orderBy(events.seq).limit(500).all();
      for (const e of rows) {
        res.write(`id: ${e.seq}\ndata: ${JSON.stringify({ seq: e.seq, type: e.type, payload: e.payload, createdAt: e.createdAt })}\n\n`);
        cursor = e.seq;
      }
    };
    push();
    const poll = setInterval(push, pollMs);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(poll);
      clearInterval(ping);
    });
  }
}

export async function startScreenServer(o: ScreenServerOptions): Promise<Server[]> {
  const handler = screenHandler(o);
  const servers: Server[] = [];
  for (const host of o.c.config.screen.hosts) {
    const server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(o.c.config.screen.port, host, () => resolveListen());
    });
    servers.push(server);
  }
  return servers;
}

/** 저장소 안 기본 위치 */
export function defaultScreenDirs(repoRoot: string) {
  return {
    staticDir: join(repoRoot, 'packages', 'office-ui', 'dist'),
    pointDir: join(repoRoot, 'design-systems', 'point'),
    assetsDir: join(repoRoot, 'assets'),
  };
}
