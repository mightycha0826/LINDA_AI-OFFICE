// 비서실장 MCP 서버 → 오케스트레이터 내부 API (3단계 결정 C).
// MCP 서버는 별도 프로세스라 DB에 직접 쓰지 않는다. DB 쓰기는 오케스트레이터 하나만 한다 (3장).
// - 127.0.0.1에서만 연다. Host 머리글도 확인한다(브라우저 DNS 재바인딩 방지).
// - 토큰이 맞아야 한다(웹페이지가 localhost로 보내는 요청 차단). 비교는 시간 차이가 나지 않게.
// - POST /tools/<이름> 하나뿐이다. 도구 목록은 chief/tool-defs.ts.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { OfficeError } from '../errors.ts';

export interface ToolRunner {
  call(name: string, args: unknown): Promise<unknown>;
}

const MAX_BODY = 64 * 1024;

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new OfficeError('too-large', '요청이 너무 커요');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function startInternalApi(o: { port: number; token: string; tools: ToolRunner; log?: (s: string) => void }): Promise<Server> {
  const allowedHosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`]);
  const server = createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(String(req.headers.host ?? ''))) return send(res, 403, { error: 'host' });
      if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
      const auth = String(req.headers.authorization ?? '');
      if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), o.token)) return send(res, 401, { error: 'unauthorized' });
      const m = /^\/tools\/([a-z_]+)$/.exec(req.url ?? '');
      if (req.method !== 'POST' || !m) return send(res, 404, { error: 'not-found' });
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'json-only' });
      const body = await readBody(req);
      const args = body ? (JSON.parse(body) as unknown) : {};
      const result = await o.tools.call(m[1]!, args);
      return send(res, 200, { result });
    } catch (err) {
      const e = err as Error;
      if (err instanceof OfficeError || e instanceof SyntaxError) return send(res, 400, { error: e.message });
      o.log?.(`내부 API 오류: ${e.stack ?? e.message}`);
      return send(res, 500, { error: 'internal' });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, '127.0.0.1', () => resolve(server));
  });
}
