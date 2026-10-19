#!/usr/bin/env node
// 0단계 #2: Qwen ↔ Gemma 교체 속도. 두 모델을 번갈아 부르고 매번 모델 로드 시간을 잰다.
//   node stage0/model-swap.mjs [--rounds 5] [--host http://127.0.0.1:11434] [--models qwen3:14b,gemma4:12b]
// 통과 기준: 모델마다 첫 호출(디스크에서 처음 읽음)을 뺀 load_duration 최댓값 30초 이내 (DESIGN.md 16장).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');
const LIMIT_SEC = 30;

function opt(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const host = opt('host', 'http://127.0.0.1:11434').replace(/\/$/, '');
const rounds = Number(opt('rounds', '5'));
const models = opt('models', 'qwen3:14b,gemma4:12b').split(',');
const sec = (ns) => (typeof ns === 'number' ? ns / 1e9 : null);
const fmt = (n, d = 1) => (n == null ? '-' : n.toFixed(d));

async function api(path, body) {
  const res = await fetch(`${host}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  let version;
  try {
    version = (await api('/api/version')).version;
  } catch (err) {
    console.log(`[실패] Ollama에 연결하지 못했어요 (${host}). Ollama 앱이 켜져 있는지 확인해 주세요.\n${err.message}`);
    process.exit(1);
  }
  const tags = (await api('/api/tags')).models.map((m) => m.name);
  const missing = models.filter((m) => !tags.includes(m) && !tags.includes(`${m}:latest`));
  if (missing.length) {
    console.log(`[실패] 받아 둔 모델이 없어요: ${missing.join(', ')}`);
    for (const m of missing) console.log(`  ollama pull ${m}`);
    process.exit(1);
  }
  console.log(`Ollama ${version} · ${host} · 모델 ${models.join(' ↔ ')} · ${rounds}회 왕복\n`);

  const rows = [];
  const total = rounds * models.length;
  for (let i = 0; i < total; i++) {
    const model = models[i % models.length];
    const t0 = performance.now();
    const r = await api('/api/generate', {
      model,
      prompt: '한 문장으로 오늘 날씨 인사를 해 주세요.',
      stream: false,
      think: false,
      options: { num_predict: 32 },
    });
    const wall = (performance.now() - t0) / 1000;
    const ps = await api('/api/ps');
    const loaded = ps.models.map((m) => `${m.name}(${(m.size_vram / 2 ** 30).toFixed(1)}GB VRAM)`).join(', ');
    const row = {
      n: i + 1,
      model,
      wallSec: wall,
      loadSec: sec(r.load_duration),
      promptEvalSec: sec(r.prompt_eval_duration),
      evalSec: sec(r.eval_duration),
      tokensPerSec: r.eval_count && r.eval_duration ? r.eval_count / sec(r.eval_duration) : null,
      loaded,
    };
    rows.push(row);
    console.log(
      `${String(row.n).padStart(2)}. ${model.padEnd(12)} 로드 ${fmt(row.loadSec).padStart(5)}초 · 전체 ${fmt(wall).padStart(5)}초 · ${fmt(row.tokensPerSec)} tok/s · 올라간 모델: ${loaded || '없음'}`,
    );
  }

  // 모델마다 첫 호출은 디스크에서 처음 읽는 것이라 판정에서 뺀다 (두 번째 모델의 첫 로드도 마찬가지)
  const firstIdx = new Set(models.map((m) => rows.findIndex((r) => r.model === m)));
  const swaps = rows.filter((_, i) => !firstIdx.has(i)).map((r) => r.loadSec ?? r.wallSec);
  const sorted = [...swaps].sort((a, b) => a - b);
  const max = sorted.at(-1);
  const median = sorted[Math.floor(sorted.length / 2)];
  const bothLoaded = rows.some((r) => models.every((m) => r.loaded.includes(m)));

  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `model-swap-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ host, version, models, rows }, null, 2), 'utf8');

  console.log(`\n모델별 첫 호출(디스크에서 처음 읽음) 로드: ${[...firstIdx].map((i) => `${rows[i].model} ${fmt(rows[i].loadSec)}초`).join(', ')} — 판정에서 뺌`);
  console.log(`교체 로드 시간: 중간값 ${fmt(median)}초, 최댓값 ${fmt(max)}초`);
  if (bothLoaded) console.log('참고: 두 모델이 동시에 VRAM에 올라간 적이 있어요. 이 경우 교체가 일어나지 않아 측정값이 작게 나와요.');
  console.log(`결과 파일: ${file}`);
  console.log(`\n${max <= LIMIT_SEC ? '[통과]' : '[실패]'} #2 모델 교체 속도: 최댓값 ${fmt(max)}초 (기준 ${LIMIT_SEC}초 이내)`);
}

main().catch((err) => {
  console.error(`[실패] 실행 중 오류: ${err.message}`);
  process.exit(1);
});
