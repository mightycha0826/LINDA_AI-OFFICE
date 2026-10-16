// 웹 자료 (15장). 엔진이 쓰는 검색·링크 읽기를 한데 묶는다. 테스트에서는 가짜로 바꿔 끼운다.
import type { Config } from '../config.ts';
import { fetchPage, type FetchedPage } from './fetch-page.ts';
import { SearxngClient, type SearchClient } from './searxng.ts';

export interface Web {
  search: SearchClient;
  fetchPage(url: string, signal?: AbortSignal): Promise<FetchedPage>;
}

export function createWeb(config: Config): Web {
  return {
    search: new SearxngClient({
      host: config.searxng.host,
      maxPerMinute: config.searxng.maxPerMinute,
      timeoutMs: config.searxng.timeoutSec * 1000,
      resultsPerQuery: config.searxng.resultsPerQuery,
    }),
    fetchPage: (url, signal) =>
      fetchPage(url, {
        timeoutMs: config.web.timeoutSec * 1000,
        maxBytes: config.web.maxBytes,
        maxChars: config.web.maxCharsPerPage,
        ...(signal ? { signal } : {}),
      }),
  };
}

/** 제출물(문서 출력)의 주장별 근거 링크. 중복을 빼고 최대 max개. */
export function claimLinks(submission: unknown, max: number): string[] {
  const claims = (submission as { claims?: { sources?: unknown }[] } | null)?.claims;
  if (!Array.isArray(claims)) return [];
  const out: string[] = [];
  for (const c of claims) {
    for (const s of Array.isArray(c?.sources) ? c.sources : []) {
      if (typeof s === 'string' && /^https?:\/\//i.test(s) && !out.includes(s)) out.push(s);
      if (out.length >= max) return out;
    }
  }
  return out;
}
