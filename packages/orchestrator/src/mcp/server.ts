// 비서실장(헤르메스)용 MCP 서버 (6장 비서실장 도구). 헤르메스가 stdio로 띄운다.
//   헤르메스 config.yaml:
//     mcp_servers:
//       office:
//         command: "node"
//         args: ["C:/ai-office/office/packages/orchestrator/src/mcp/main.ts"]
// 도구 호출은 모두 오케스트레이터 내부 API(127.0.0.1)로 넘긴다. 이 프로세스는 DB를 열지 않는다.
// stdout은 MCP 프로토콜 전용이라 로그는 stderr로만 쓴다.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOL_DEFS, TOOL_NAMES } from '../chief/tool-defs.ts';

export interface BridgeOptions {
  apiBase: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/** 도구 하나를 내부 API로 넘긴다 */
export async function forward(o: BridgeOptions, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  try {
    const res = await (o.fetchImpl ?? fetch)(`${o.apiBase}/tools/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${o.token}` },
      body: JSON.stringify(args ?? {}),
      signal: AbortSignal.timeout(120_000),
    });
    const json = (await res.json()) as { result?: unknown; error?: string };
    if (!res.ok) return { text: `오류: ${json.error ?? res.status}`, isError: true };
    return { text: JSON.stringify(json.result, null, 2), isError: false };
  } catch (err) {
    return { text: `회사 시스템에 연결하지 못했어요: ${(err as Error).message}`, isError: true };
  }
}

export function buildMcpServer(o: BridgeOptions): McpServer {
  const server = new McpServer(
    { name: 'ai-office', version: '0.3.0' },
    { instructions: '회사 오케스트레이터 도구. 읽기, 지시 등록, 확인 버튼 요청, 보고 제출만 할 수 있다. 위험한 작업은 request_confirmation으로 버튼만 요청한다.' },
  );
  for (const name of TOOL_NAMES) {
    const def = TOOL_DEFS[name];
    server.registerTool(name, { description: def.description, inputSchema: def.input.shape }, async (args: unknown) => {
      const r = await forward(o, name, args);
      return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError };
    });
  }
  return server;
}
