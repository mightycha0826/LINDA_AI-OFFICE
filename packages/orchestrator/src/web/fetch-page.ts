// 근거 링크 페이지 가져오기 (15장 근거 규칙, 2.5단계 결정 F).
// AI가 적은 주소를 오케스트레이터가 직접 가져오므로, 이 PC나 내부망의 서비스를 찌르지 못하게 막는다.
// - http(s)만. 주소 안 사용자 정보(user:pass@) 금지.
// - 내부 주소 차단: localhost, 사설 IP, 링크 로컬(클라우드 메타데이터 포함), Tailscale 대역(100.64/10), IPv6 내부 대역.
//   DNS 이름은 실제로 연결하는 순간의 조회 결과로 검사한다(조회 뒤 주소를 바꾸는 우회 방지). 리디렉션도 매번 검사한다.
// - 크기·시간 상한, HTML은 글자만 남긴다.
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT · Tailscale
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // 링크 로컬 · 클라우드 메타데이터
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}

export function isBlockedAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) return BLOCKED.check(mapped[1]!, 'ipv4');
  const v = isIP(addr);
  if (v === 4) return BLOCKED.check(addr, 'ipv4');
  if (v === 6) return BLOCKED.check(addr, 'ipv6');
  return true; // IP가 아니면 여기 오지 않아야 한다
}

export interface FetchedPage {
  url: string;
  finalUrl?: string;
  ok: boolean;
  status?: number;
  title?: string;
  text?: string;
  truncated?: boolean;
  error?: string;
}

export interface FetchPageOptions {
  timeoutMs: number;
  maxBytes: number;
  maxChars: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  /** 테스트에서만: 이 주소·포트는 내부 주소여도 허용 */
  allowAddress?: (ip: string, port: number) => boolean;
}

class BlockedError extends Error {}

const TEXT_TYPES = /^(text\/html|text\/plain|application\/xhtml\+xml|application\/json)\b/i;

function defaultPort(u: URL): number {
  return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
}

/** 연결 직전 DNS 조회 결과를 검사하는 lookup */
function guardedLookup(port: number, allow: FetchPageOptions['allowAddress']) {
  return (hostname: string, options: LookupOptions, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err, '');
      const list = addrs as LookupAddress[];
      const bad = list.find((a) => isBlockedAddress(a.address) && !allow?.(a.address, port));
      if (bad || list.length === 0) return cb(new BlockedError(`내부 주소라 가져오지 않았어요: ${hostname} → ${bad?.address ?? '없음'}`) as NodeJS.ErrnoException, '');
      if (options.all) return cb(null, list);
      return cb(null, list[0]!.address, list[0]!.family);
    });
  };
}

interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

function requestOnce(u: URL, o: FetchPageOptions): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const port = defaultPort(u);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      {
        method: 'GET',
        headers: { 'user-agent': 'ai-office-research/0.1', accept: 'text/html,text/plain;q=0.9,*/*;q=0.1', 'accept-encoding': 'identity' },
        lookup: guardedLookup(port, o.allowAddress) as never,
        timeout: o.timeoutMs,
        ...(o.signal ? { signal: o.signal } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (d: Buffer) => {
          if (truncated) return;
          size += d.length;
          if (size > o.maxBytes) {
            chunks.push(d.subarray(0, d.length - (size - o.maxBytes)));
            truncated = true;
            res.destroy();
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated });
            return;
          }
          chunks.push(d);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated }));
        res.on('error', (e) => (truncated ? undefined : reject(e)));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`시간 초과(${o.timeoutMs / 1000}초)`)));
    req.on('error', reject);
    req.end();
  });
}

function decode(body: Buffer, contentType: string): string {
  const head = body.subarray(0, 2048).toString('latin1');
  const label =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(label.toLowerCase()).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', ndash: '–', mdash: '—' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '');
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|head|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { title, text };
}

export async function fetchPage(rawUrl: string, o: FetchPageOptions): Promise<FetchedPage> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return { url: rawUrl, ok: false, error: '주소 형식이 아니에요' };
  }
  const maxRedirects = o.maxRedirects ?? 3;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') return { url: rawUrl, ok: false, error: `http(s)만 가져와요: ${current.protocol}` };
    if (current.username || current.password) return { url: rawUrl, ok: false, error: '주소에 사용자 정보가 들어 있어요' };
    const host = current.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return { url: rawUrl, ok: false, error: `내부 주소라 가져오지 않았어요: ${host}` };
    // IP를 직접 적으면 DNS 조회를 건너뛰므로 여기서 검사한다
    if (isIP(host) && isBlockedAddress(host) && !o.allowAddress?.(host, defaultPort(current))) {
      return { url: rawUrl, ok: false, error: `내부 주소라 가져오지 않았어요: ${host}` };
    }

    let raw: Raw;
    try {
      raw = await requestOnce(current, o);
    } catch (err) {
      const e = err as Error & { cause?: unknown };
      const msg = e instanceof BlockedError || e.cause instanceof BlockedError ? e.message : `가져오지 못했어요: ${e.message}`;
      return { url: rawUrl, ok: false, error: msg };
    }
    const location = raw.headers.location;
    if (raw.status >= 300 && raw.status < 400 && location) {
      current = new URL(location, current);
      continue;
    }
    const contentType = String(raw.headers['content-type'] ?? '');
    if (!TEXT_TYPES.test(contentType)) return { url: rawUrl, finalUrl: current.href, ok: false, status: raw.status, error: `글 형식이 아니에요(${contentType || '형식 없음'})` };
    const decoded = decode(raw.body, contentType);
    const { title, text } = /html/i.test(contentType) ? htmlToText(decoded) : { title: '', text: decoded };
    const cut = text.length > o.maxChars;
    return {
      url: rawUrl,
      finalUrl: current.href,
      ok: raw.status >= 200 && raw.status < 300,
      status: raw.status,
      title,
      text: cut ? text.slice(0, o.maxChars) : text,
      truncated: cut || raw.truncated,
      ...(raw.status >= 400 ? { error: `HTTP ${raw.status}` } : {}),
    };
  }
  return { url: rawUrl, ok: false, error: `리디렉션이 ${maxRedirects}번을 넘었어요` };
}
