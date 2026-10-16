// 비서실장 MCP 서버 실행 파일. 헤르메스 config.yaml의 mcp_servers가 이 파일을 node로 띄운다 (server.ts 설명 참고).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './server.ts';

const dataDir = process.env.AI_OFFICE_DATA ?? 'C:\\ai-office\\data';
try {
  const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as { internalApi?: { port?: number } };
  const secrets = JSON.parse(readFileSync(join(dataDir, 'secrets.json'), 'utf8')) as { internalApiToken: string };
  const port = config.internalApi?.port ?? 8790;
  const server = buildMcpServer({ apiBase: `http://127.0.0.1:${port}`, token: secrets.internalApiToken });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`ai-office MCP 서버 시작 (내부 API 127.0.0.1:${port})\n`);
} catch (err) {
  process.stderr.write(`MCP 서버 시작 실패: ${(err as Error).message}\n`);
  process.exitCode = 1;
}
