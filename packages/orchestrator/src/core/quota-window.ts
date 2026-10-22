import type { AccountUsage } from '../brains/brain.ts';
import { getState, setState, type Ctx } from '../context.ts';

export interface ReportedAccount extends AccountUsage { at: string }
const resetKey = (provider: string, window: string) => `quotaReset:${provider}:${window}`;

/** Preserve the old window boundary before a fresh report replaces its reset timestamp. */
export function rememberQuotaResets(c: Ctx): void {
  const now = c.clock.now().getTime();
  for (const provider of ['claude','gpt'] as const) {
    const account = getState<ReportedAccount | null>(c,`account.${provider}`,null);
    if (!account) continue;
    for (const window of ['fiveHour','weekly'] as const) {
      const reset = Date.parse(account[`${window}ResetsAt`] ?? '');
      const previous = getState<number>(c,resetKey(provider,window),0);
      if (Number.isFinite(reset) && reset <= now && reset > previous) setState(c,resetKey(provider,window),reset);
    }
  }
}

export function quotaResetAt(c: Ctx, provider: 'claude' | 'gpt', window: 'fiveHour' | 'weekly'): number {
  const account = getState<ReportedAccount | null>(c,`account.${provider}`,null);
  const reset = Date.parse(account?.[`${window}ResetsAt`] ?? '');
  const known = getState<number>(c,resetKey(provider,window),0);
  return Number.isFinite(reset) && reset <= c.clock.now().getTime() ? Math.max(known,reset) : known;
}

/** A 5h reset cannot release an exhausted weekly allowance. Unknown reset dates remain blocked. */
export function reportedQuotaAvailable(account: ReportedAccount | null, now: number): boolean {
  if (!account) return true;
  return (['fiveHour','weekly'] as const).every(window => {
    const percent = account[`${window}Pct`];
    if (percent == null || percent < 100) return true;
    const reset = Date.parse(account[`${window}ResetsAt`] ?? '');
    return Number.isFinite(reset) && reset <= now && Date.parse(account.at) <= reset;
  });
}
