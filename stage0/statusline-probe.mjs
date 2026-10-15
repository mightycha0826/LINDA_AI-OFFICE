#!/usr/bin/env node
// 0단계 #5: Claude Code 상태줄이 받는 JSON을 기록하고, 구독 사용량 %를 상태줄에 보여 준다.
//   claude --settings stage0\statusline-settings.json   (대화형으로 한 번 말 걸고 /exit)
// 기록: stage0/out/statusline.jsonl
// rate_limits.five_hour / seven_day 는 Pro·Max 구독자에게 첫 응답 뒤에 들어온다(Claude Code 상태줄 문서).

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  let data = null;
  try {
    data = JSON.parse(input);
  } catch {
    process.stdout.write('stage0 probe: 입력을 읽지 못했어요');
    return;
  }
  const rl = data.rate_limits ?? null;
  mkdirSync(OUT_DIR, { recursive: true });
  // 판정에 필요한 필드만 남긴다.
  appendFileSync(
    join(OUT_DIR, 'statusline.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), version: data.version ?? null, model: data.model?.id ?? null, rate_limits: rl, cost: data.cost ?? null }) + '\n',
    'utf8',
  );
  const pct = (w) => (typeof w?.used_percentage === 'number' ? `${w.used_percentage.toFixed(1)}%` : '없음');
  const reset = (w) => (typeof w?.resets_at === 'number' ? ` (초기화 ${new Date(w.resets_at * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })})` : '');
  if (!rl) {
    process.stdout.write('stage0 probe · rate_limits 아직 없음 (한 번 말을 걸어 주세요)');
  } else {
    process.stdout.write(`stage0 probe · 5h ${pct(rl.five_hour)}${reset(rl.five_hour)} · 7d ${pct(rl.seven_day)}${reset(rl.seven_day)}`);
  }
});
