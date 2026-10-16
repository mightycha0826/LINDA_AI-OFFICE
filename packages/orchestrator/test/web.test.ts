// 웹 (15장): 근거 링크 가져오기의 내부 주소 차단, HTML → 글자, SearXNG 분당 상한.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchPage, htmlToText, isBlockedAddress } from '../src/web/fetch-page.ts';
import { claimLinks } from '../src/web/research.ts';
import { SearxngClient } from '../src/web/searxng.ts';

const opts = { timeoutMs: 3000, maxBytes: 200_000, maxChars: 5000 };

describe('내부 주소 판정', () => {
  it('localhost·사설·링크 로컬·Tailscale·IPv6 내부 대역을 막고 공인 주소는 통과', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.1', '169.254.169.254', '100.100.100.100', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '224.0.0.1']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '142.250.196.110', '2606:4700:4700::1111']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });
});

describe('근거 링크 가져오기', () => {
  let server: Server;
  let port = 0;
  const hits: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/page') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end('<html><head><title>요금 안내 &amp; 정책</title><style>.x{}</style></head><body><script>alert(1)</script><h1>월 요금</h1><p>9,900원&nbsp;입니다</p><!-- 숨김 --></body></html>');
      } else if (req.url === '/euckr') {
        res.setHeader('content-type', 'text/html; charset=euc-kr');
        res.end(Buffer.from([0xc7, 0xd1, 0xb1, 0xdb])); // "한글"
      } else if (req.url === '/to-internal') {
        res.statusCode = 302;
        res.setHeader('location', 'http://127.0.0.1:11434/api/tags');
        res.end();
      } else if (req.url === '/pdf') {
        res.setHeader('content-type', 'application/pdf');
        res.end('%PDF');
      } else if (req.url === '/big') {
        res.setHeader('content-type', 'text/plain');
        res.end('가'.repeat(300_000));
      } else if (req.url === '/slow') {
        setTimeout(() => res.end('늦음'), 5000);
      } else {
        res.statusCode = 404;
        res.end('없음');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // 테스트 서버(127.0.0.1의 이 포트)만 예외로 허용한다
  const allowTestServer = (ip: string, p: number) => ip === '127.0.0.1' && p === port;

  it('내부 주소는 예외 허용 없이는 가지 않는다 (이 PC의 Ollama 포트 포함)', async () => {
    for (const url of ['http://127.0.0.1:11434/api/tags', 'http://localhost:11434/', 'http://api.localhost/', 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]:8888/', 'http://100.101.102.103/']) {
      const r = await fetchPage(url, opts);
      expect(r, url).toMatchObject({ ok: false, error: expect.stringContaining('내부 주소') });
    }
    const before = hits.length;
    expect(await fetchPage(`http://127.0.0.1:${port}/page`, opts)).toMatchObject({ ok: false });
    expect(hits.length).toBe(before); // 요청 자체가 나가지 않았다
  });

  it('http(s)가 아니거나 사용자 정보가 든 주소는 가지 않는다', async () => {
    expect(await fetchPage('file:///C:/Windows/win.ini', opts)).toMatchObject({ ok: false, error: expect.stringContaining('http(s)만') });
    expect(await fetchPage('ftp://example.com/a', opts)).toMatchObject({ ok: false });
    expect(await fetchPage('https://user:pw@example.com/', opts)).toMatchObject({ ok: false, error: expect.stringContaining('사용자 정보') });
    expect(await fetchPage('아무말', opts)).toMatchObject({ ok: false, error: '주소 형식이 아니에요' });
  });

  it('리디렉션으로 내부 주소에 가려 해도 막는다', async () => {
    const r = await fetchPage(`http://127.0.0.1:${port}/to-internal`, { ...opts, allowAddress: allowTestServer });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('내부 주소') });
  });

  it('HTML에서 글자만 남기고 제목을 꺼낸다', async () => {
    const r = await fetchPage(`http://127.0.0.1:${port}/page`, { ...opts, allowAddress: allowTestServer });
    expect(r).toMatchObject({ ok: true, status: 200, title: '요금 안내 & 정책' });
    expect(r.text).toContain('월 요금');
    expect(r.text).toContain('9,900원 입니다');
    expect(r.text).not.toContain('alert');
    expect(r.text).not.toContain('숨김');
  });

  it('EUC-KR 페이지도 읽는다', async () => {
    const r = await fetchPage(`http://127.0.0.1:${port}/euckr`, { ...opts, allowAddress: allowTestServer });
    expect(r.text).toBe('한글');
  });

  it('글이 아닌 형식은 가져오지 않고, 크기·글자 수·시간 상한을 지킨다', async () => {
    const allow = { ...opts, allowAddress: allowTestServer };
    expect(await fetchPage(`http://127.0.0.1:${port}/pdf`, allow)).toMatchObject({ ok: false, error: expect.stringContaining('글 형식이 아니에요') });
    const big = await fetchPage(`http://127.0.0.1:${port}/big`, { ...allow, maxBytes: 30_000, maxChars: 1000 });
    expect(big).toMatchObject({ ok: true, truncated: true });
    expect(big.text!.length).toBe(1000);
    const slow = await fetchPage(`http://127.0.0.1:${port}/slow`, { ...allow, timeoutMs: 300 });
    expect(slow).toMatchObject({ ok: false, error: expect.stringContaining('시간 초과') });
  });

  it('제출물에서 근거 링크만 뽑는다 (중복 제거, http(s)만, 상한)', () => {
    const sub = { claims: [{ sources: ['https://a.com', 'https://a.com', 'javascript:alert(1)'] }, { sources: ['http://b.com', 'https://c.com'] }, { sources: [] }] };
    expect(claimLinks(sub, 15)).toEqual(['https://a.com', 'http://b.com', 'https://c.com']);
    expect(claimLinks(sub, 2)).toEqual(['https://a.com', 'http://b.com']);
    expect(claimLinks('문자열', 5)).toEqual([]);
  });

  it('htmlToText: 숫자 엔티티와 줄바꿈', () => {
    expect(htmlToText('<p>a&#44;b&#x41;</p><br>c').text).toBe('a,bA\nc');
  });
});

describe('SearXNG', () => {
  it('JSON 결과를 정리하고, http(s)가 아닌 결과는 뺀다', async () => {
    const fake = (async (url: string) => {
      expect(url).toContain('format=json');
      return new Response(JSON.stringify({ results: [{ title: ' 제목 ', url: 'https://x.com/a', content: '요약' }, { title: 'bad', url: 'javascript:x' }] }), { status: 200 });
    }) as typeof fetch;
    const c = new SearxngClient({ host: 'http://127.0.0.1:8888', maxPerMinute: 10, timeoutMs: 1000, resultsPerQuery: 5, fetchImpl: fake });
    expect(await c.search('요금')).toEqual([{ title: '제목', url: 'https://x.com/a', snippet: '요약' }]);
  });

  it('분당 상한을 넘으면 1분 창이 지날 때까지 기다린다', async () => {
    let now = 0;
    const waits: number[] = [];
    const c = new SearxngClient({
      host: 'http://127.0.0.1:8888',
      maxPerMinute: 2,
      timeoutMs: 1000,
      resultsPerQuery: 5,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
      fetchImpl: (async () => new Response('{"results":[]}')) as typeof fetch,
    });
    await Promise.all([c.search('a'), c.search('b'), c.search('c')]);
    expect(waits).toEqual([60_000]);
  });

  it('403이면 json 형식 설정을 확인하라고 알려 준다', async () => {
    const c = new SearxngClient({ host: 'http://127.0.0.1:8888', maxPerMinute: 10, timeoutMs: 1000, resultsPerQuery: 5, fetchImpl: (async () => new Response('', { status: 403 })) as typeof fetch });
    await expect(c.search('a')).rejects.toThrow(/json/);
  });
});
