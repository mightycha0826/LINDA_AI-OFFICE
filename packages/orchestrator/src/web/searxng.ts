// SearXNG 검색 (15장). 요청을 한 줄로 세우고 분당 요청 수를 제한한다.
// 너무 자주 보내면 SearXNG가 모아 오는 원래 검색엔진 쪽에서 막히기 때문이다.
import { OfficeError } from '../errors.ts';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchClient {
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
}

export interface SearxngOptions {
  host: string;
  maxPerMinute: number;
  timeoutMs: number;
  resultsPerQuery: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  fetchImpl?: typeof fetch;
}

const MINUTE = 60_000;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('정지됨', 'AbortError'));
      },
      { once: true },
    );
  });
}

export class SearxngClient implements SearchClient {
  private readonly o: SearxngOptions;
  private readonly stamps: number[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(o: SearxngOptions) {
    this.o = o;
  }

  search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const run = this.chain.then(() => this.throttled(query, signal));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async throttled(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const now = this.o.now ?? Date.now;
    const sleep = this.o.sleep ?? defaultSleep;
    for (;;) {
      const t = now();
      while (this.stamps.length && t - this.stamps[0]! >= MINUTE) this.stamps.shift();
      if (this.stamps.length < this.o.maxPerMinute) break;
      await sleep(this.stamps[0]! + MINUTE - t, signal);
    }
    this.stamps.push(now());

    const url = `${this.o.host.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json&language=ko-KR&safesearch=1`;
    let json: { results?: { title?: string; url?: string; content?: string }[] };
    try {
      const res = await (this.o.fetchImpl ?? fetch)(url, { signal: AbortSignal.any([AbortSignal.timeout(this.o.timeoutMs), ...(signal ? [signal] : [])]) });
      if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 403 ? ' (settings.yml에서 json 형식을 켰는지 확인)' : ''}`);
      json = (await res.json()) as typeof json;
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new OfficeError('search', `SearXNG 검색 실패: ${(err as Error).message}`);
    }
    return (json.results ?? [])
      .filter((r) => typeof r.url === 'string' && /^https?:\/\//i.test(r.url))
      .slice(0, this.o.resultsPerQuery)
      .map((r) => ({ title: (r.title ?? '').trim(), url: r.url!, snippet: (r.content ?? '').trim().slice(0, 500) }));
  }
}
