// Ollama 어댑터 (로컬 Qwen3-14B, Gemma 4 12B). 요청에 JSON 스키마를 함께 넘겨 구조화 출력을 강제한다 (6장).
// GPU는 한 번에 한 요청만 처리하므로 모든 요청은 GpuQueue를 거친다 (8장).
import { LOCAL_MODEL, type OllamaModel } from '@ai-office/shared';
import { QUEUE_PRIORITY } from './gpu-queue.ts';
import { BrainError, type Brain, type BrainRequest, type BrainResult } from './brain.ts';
import type { GpuQueue } from './gpu-queue.ts';
import { extractJson, toJsonSchema } from './json-schema.ts';

export interface OllamaOptions {
  host: string;
  numCtx: number;
  timeoutMs: number;
  keepAlive: string;
  queue: GpuQueue;
  /** 리서치 몫 소진 때 Claude 대신 쓸 모델 (8장) */
  fallbackModel?: OllamaModel;
  fetchImpl?: typeof fetch;
}

interface ChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  load_duration?: number;
  error?: string;
}

export class OllamaBrain implements Brain {
  private readonly o: OllamaOptions;

  constructor(o: OllamaOptions) {
    this.o = o;
  }

  modelFor(req: BrainRequest): OllamaModel {
    const b = req.employee.brain;
    if (b.provider === 'ollama') return b.model;
    if (req.lowPrecision) return this.o.fallbackModel ?? LOCAL_MODEL;
    throw new BrainError('crash', `${req.employee.id}은(는) 로컬 모델 직원이 아니에요`);
  }

  async call(req: BrainRequest): Promise<BrainResult> {
    const model = this.modelFor(req);
    const body = {
      model,
      messages: [
        { role: 'system', content: req.prompt.system },
        { role: 'user', content: req.prompt.user },
      ],
      format: toJsonSchema(req.schema),
      stream: false,
      think: false,
      keep_alive: this.o.keepAlive,
      options: { num_ctx: this.o.numCtx, temperature: 0.2 },
    };
    const doFetch = this.o.fetchImpl ?? fetch;
    const res = await this.o.queue.enqueue(
      model,
      async () => {
        let r: Response;
        try {
          r = await doFetch(`${this.o.host.replace(/\/$/, '')}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.any([req.signal, AbortSignal.timeout(this.o.timeoutMs)]),
          });
        } catch (err) {
          if (req.signal.aborted) throw err;
          if ((err as Error).name === 'TimeoutError') throw new BrainError('timeout', `Ollama 응답이 ${this.o.timeoutMs / 1000}초 안에 오지 않았어요 (${model})`);
          // 로컬 서버라 인터넷 끊김이 아니라 Ollama가 꺼진 것
          throw new BrainError('crash', `Ollama에 연결하지 못했어요: ${(err as Error).message}`);
        }
        const json = (await r.json().catch(() => ({}))) as ChatResponse;
        if (!r.ok || json.error) throw new BrainError('crash', `Ollama 오류 ${r.status}: ${json.error ?? ''}`);
        return json;
      },
      req.signal,
      req.priority ?? QUEUE_PRIORITY.normal,
    );
    return {
      output: extractJson(res.message?.content ?? ''),
      usage: { inputTokens: res.prompt_eval_count ?? 0, outputTokens: res.eval_count ?? 0, source: 'reported', estimatedPct: 0, estimatedWeeklyPct: 0 },
    };
  }
}
