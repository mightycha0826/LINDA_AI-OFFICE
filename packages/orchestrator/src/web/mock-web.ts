// 가짜 웹. MockLLM 시뮬레이션과 흐름 테스트용. 실제 SearXNG나 인터넷에 나가지 않는다.
import type { FetchedPage } from './fetch-page.ts';
import type { Web } from './research.ts';
import type { SearchResult } from './searxng.ts';

export class MockWeb implements Web {
  readonly queries: string[] = [];
  readonly fetched: string[] = [];
  private readonly results: (q: string) => SearchResult[];
  private readonly pages: (url: string) => FetchedPage;

  constructor(o: { results?: (q: string) => SearchResult[]; pages?: (url: string) => FetchedPage } = {}) {
    this.results = o.results ?? ((q) => [{ title: `${q} 관련 글`, url: 'https://example.com/a', snippet: `${q}에 대한 요약` }]);
    this.pages = o.pages ?? ((url) => ({ url, ok: true, title: '예시 페이지', text: '예시 본문' }));
  }

  search = {
    search: async (q: string): Promise<SearchResult[]> => {
      this.queries.push(q);
      return this.results(q);
    },
  };

  async fetchPage(url: string): Promise<FetchedPage> {
    this.fetched.push(url);
    return this.pages(url);
  }
}
