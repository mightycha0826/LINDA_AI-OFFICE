// CLI 출력에서 실패 종류를 가린다. 문구는 CLI 버전에 따라 바뀌므로 넓게 잡고, 모르면 crash로 본다.
import type { BrainFailure } from './brain.ts';

const LIMIT = /usage limit|rate[ -]?limit|limit reached|quota|too many requests|\b429\b|credit balance/i;
const OFFLINE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|getaddrinfo|network error|unable to connect|fetch failed|connection (?:error|refused|reset)|offline/i;

export function classifyFailure(text: string): BrainFailure {
  if (LIMIT.test(text)) return 'limit';
  if (OFFLINE.test(text)) return 'offline';
  return 'crash';
}

/** 한도 메시지에 들어 있는 초기화 시각(ISO 또는 유닉스 초)을 찾는다. 못 찾으면 undefined. */
export function findResetTime(text: string): string | undefined {
  const iso = /reset[^\n]*?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text);
  if (iso?.[1]) {
    const d = new Date(iso[1]);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const epoch = /reset[^\n]*?\b(1[6-9]\d{8})\b/i.exec(text);
  if (epoch?.[1]) return new Date(Number(epoch[1]) * 1000).toISOString();
  return undefined;
}

export function tail(text: string, chars = 600): string {
  return text.length > chars ? '…' + text.slice(-chars) : text;
}
