// 차선 (8장 동시 실행): Claude Code는 한 번에 한 작업, Codex도 한 번에 한 작업.
// 로컬 모델은 GpuQueue가 따로 줄을 세운다. 차선이 다르면 동시에 돈다.
export class Lanes {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly active = new Map<string, number>();
  /** 차선별 동시 실행 최댓값 기록 (테스트용) */
  readonly peak = new Map<string, number>();

  private async acquire(key: string): Promise<() => void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.tails.set(key, prev.then(() => mine));
    await prev;
    const n = (this.active.get(key) ?? 0) + 1;
    this.active.set(key, n);
    this.peak.set(key, Math.max(this.peak.get(key) ?? 0, n));
    return () => {
      this.active.set(key, (this.active.get(key) ?? 1) - 1);
      release();
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
