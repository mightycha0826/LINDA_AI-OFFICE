// 토큰 수 → 한도 대비 % 추정 (8장 측정 방식).
// 구독 사용량 %를 프로그램으로 읽을 수 있는지는 0단계 #5에서 확인한다. 그 전까지는 이 추정치를 쓰고 항상 "추정치"로 표시한다.
import type { UsageBudget } from '@ai-office/shared';
import type { Config } from '../config.ts';

export function estimatePct(config: Config, budget: UsageBudget, tokens: number): { fiveHour: number; weekly: number } {
  if (budget === 'local') return { fiveHour: 0, weekly: 0 };
  const cal = budget === 'review' ? config.calibration.gpt : config.calibration.claude;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { fiveHour: round(tokens / cal.tokensPerFiveHourPct), weekly: round(tokens / cal.tokensPerWeeklyPct) };
}
