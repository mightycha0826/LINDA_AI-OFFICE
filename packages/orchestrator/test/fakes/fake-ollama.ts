// 가짜 Ollama 서버 (/api/chat). 받은 요청을 기록하고, 요청 형식(JSON 스키마)에 맞는 답을 준다.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { criteriaFrom, outputFor } from './fake-common.mjs';

export interface OllamaCall {
  model: string;
  body: Record<string, unknown>;
}

export async function startFakeOllama(opts: { reply?: (body: Record<string, unknown>) => unknown; delayMs?: number } = {}) {
  const calls: OllamaCall[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      calls.push({ model: String(body.model), body });
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const user = ((body.messages as { role: string; content: string }[]).find((m) => m.role === 'user')?.content ?? '') as string;
      const out = opts.reply ? opts.reply(body) : outputFor(body.format, user);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: typeof out === 'string' ? out : JSON.stringify(out) }, prompt_eval_count: 800, eval_count: 200, load_duration: 1e9 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { host: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>((r) => server.close(() => r())), criteriaFrom };
}
