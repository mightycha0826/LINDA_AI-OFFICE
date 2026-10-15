// GPU 대기열 (8장 로컬). RTX 3060 12GB에는 14B 모델이 하나만 올라가므로 요청을 한 줄로 세운다.
// 지금 올라가 있는 모델의 요청을 먼저 처리해 모델 교체를 줄이고,
// maxWaitMs보다 오래 기다린 요청은 모델이 달라도 먼저 처리해 한쪽이 굶지 않게 한다.

interface Job {
  model: string;
  enqueuedAt: number;
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort?: () => void;
}

export interface GpuQueueOptions {
  maxWaitMs: number;
  now?: () => number;
  /** 다른 모델로 바뀔 때 (서버실 화면 연출, 12장) */
  onModelSwitch?: (from: string | null, to: string) => void;
}

export class GpuQueue {
  private readonly jobs: Job[] = [];
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly onModelSwitch: ((from: string | null, to: string) => void) | undefined;
  private running = false;
  private loaded: string | null = null;
  /** 처리한 순서 (테스트·화면용) */
  readonly history: string[] = [];

  constructor(o: GpuQueueOptions) {
    this.maxWaitMs = o.maxWaitMs;
    this.now = o.now ?? Date.now;
    this.onModelSwitch = o.onModelSwitch;
  }

  get loadedModel(): string | null {
    return this.loaded;
  }

  get waiting(): number {
    return this.jobs.length;
  }

  enqueue<T>(model: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('정지됨', 'AbortError'));
        return;
      }
      const job: Job = { model, enqueuedAt: this.now(), run, resolve: resolve as (v: unknown) => void, reject, signal };
      if (signal) {
        job.onAbort = () => {
          const i = this.jobs.indexOf(job);
          if (i >= 0) {
            this.jobs.splice(i, 1);
            reject(new DOMException('정지됨', 'AbortError'));
          }
        };
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      this.jobs.push(job);
      void this.drain();
    });
  }

  private pick(): Job {
    const now = this.now();
    const starving = this.jobs.find((j) => now - j.enqueuedAt >= this.maxWaitMs);
    const sameModel = this.jobs.find((j) => j.model === this.loaded);
    const job = starving ?? sameModel ?? this.jobs[0]!;
    this.jobs.splice(this.jobs.indexOf(job), 1);
    return job;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length > 0) {
        const job = this.pick();
        if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
        if (job.model !== this.loaded) {
          this.onModelSwitch?.(this.loaded, job.model);
          this.loaded = job.model;
        }
        this.history.push(job.model);
        try {
          job.resolve(await job.run());
        } catch (err) {
          job.reject(err);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
