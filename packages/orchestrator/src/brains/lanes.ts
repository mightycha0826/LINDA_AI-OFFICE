// 차선 (8장 동시 실행): Claude Code는 한 번에 한 작업, Codex는 7-3부터 두 작업까지(설정 codex.concurrency).
// 로컬 모델은 GpuQueue가 따로 줄을 세운다. 차선이 다르면 동시에 돈다. 순서는 먼저 온 차례대로.
export class Lanes {
  private readonly capacity: Record<string, number>;
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, (() => void)[]>();
  /** 차선별 동시 실행 최댓값 기록 (테스트용) */
  readonly peak = new Map<string, number>();

  /** capacity: 차선별 동시 실행 수. 적지 않은 차선은 1 */
  constructor(capacity: Record<string, number> = {}) {
    this.capacity = capacity;
  }

  private async acquire(key: string): Promise<() => void> {
    const limit = Math.max(1, this.capacity[key] ?? 1);
    if ((this.active.get(key) ?? 0) >= limit) {
      await new Promise<void>((r) => this.waiting.set(key, [...(this.waiting.get(key) ?? []), r]));
    }
    const n = (this.active.get(key) ?? 0) + 1;
    this.active.set(key, n);
    this.peak.set(key, Math.max(this.peak.get(key) ?? 0, n));
    return () => {
      this.active.set(key, (this.active.get(key) ?? 1) - 1);
      const next = this.waiting.get(key)?.shift();
      next?.();
    };
  }

  /** key가 null이면 줄 서지 않고 바로 실행한다. */
  async run<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
    if (!key) return fn();
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
