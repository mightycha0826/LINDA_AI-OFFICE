// 비밀 값 (9장 봇 토큰, ⑦ 웹훅, 비서실장용 내부 API 토큰). 저장소 밖 paths.data\secrets.json에 둔다.
// 자식 프로세스에는 넘어가지 않는다(brains/process.ts 허용 목록).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const SecretsSchema = z.object({
  discordToken: z.string().min(20).optional(),
  mirrorWebhookUrl: z.url().optional(),
  internalApiToken: z.string().min(32),
  /** 등록 저장소에만 쓰기 권한이 있는 세분화된 토큰 (11장). Git 고양이가 푸시하는 순간에만 꺼낸다 */
  githubToken: z.string().min(20).optional(),
});
export type Secrets = z.infer<typeof SecretsSchema>;

export function loadSecrets(dataDir: string): Secrets {
  const file = join(dataDir, 'secrets.json');
  const raw = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  if (typeof raw.internalApiToken !== 'string' || raw.internalApiToken.length < 32) {
    // 비서실장 MCP 서버와 오케스트레이터 사이의 토큰. 없으면 만든다.
    raw.internalApiToken = randomBytes(32).toString('hex');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
  }
  const r = SecretsSchema.safeParse(raw);
  if (!r.success) throw new Error(`secrets.json 형식 오류: ${z.prettifyError(r.error)}`);
  return r.data;
}
