#!/usr/bin/env node
// 0단계 #10: SearXNG가 이 PC에서 떠 있고 JSON 검색 결과를 주는지, 다른 기기에서는 열리지 않는지 확인한다.
//   node stage0/searxng-check.mjs [--host http://127.0.0.1:8888]
import { networkInterfaces } from 'node:os';

const i = process.argv.indexOf('--host');
const host = (i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:8888').replace(/\/$/, '');
const port = new URL(host).port || '80';
const results = [];
const say = (s) => console.log(s);

async function get(url, ms = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  return { status: res.status, body: await res.text() };
}

say(`SearXNG 확인: ${host}\n`);

// 1) JSON 검색
for (const q of ['인공지능 뉴스', 'node.js release']) {
  try {
    const t0 = Date.now();
    const r = await get(`${host}/search?q=${encodeURIComponent(q)}&format=json&language=ko-KR`);
    if (r.status === 403) {
      results.push(['실패', `"${q}": 403 — settings.yml의 search.formats에 json이 있는지 확인해 주세요`]);
      continue;
    }
    const json = JSON.parse(r.body);
    const n = (json.results ?? []).length;
    const engines = [...new Set((json.results ?? []).flatMap((x) => x.engines ?? [x.engine]).filter(Boolean))].join(', ');
    const dead = (json.unresponsive_engines ?? []).map((e) => (Array.isArray(e) ? e.join(':') : String(e))).join(', ');
    say(`  "${q}": ${n}건, ${((Date.now() - t0) / 1000).toFixed(1)}초, 엔진 ${engines || '-'}${dead ? ` · 응답 없는 엔진 ${dead}` : ''}`);
    results.push([n > 0 ? '통과' : '실패', `"${q}" 검색 결과 ${n}건`]);
  } catch (err) {
    results.push(['실패', `"${q}": 연결하지 못했어요 (${err.message}). Docker에서 searxng 컨테이너가 떠 있는지 확인해 주세요`]);
  }
}

// 2) 이 PC의 다른 주소(학교 네트워크 쪽)로는 열리지 않아야 한다
const lanIps = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal)
  .map((a) => a.address);
for (const ip of lanIps) {
  try {
    await get(`http://${ip}:${port}/`, 3000);
    results.push(['실패', `${ip}:${port}로도 열려요. docker run의 -p를 127.0.0.1:${port}:8080으로 바꿔 주세요`]);
  } catch {
    results.push(['통과', `${ip}:${port}로는 열리지 않음 (127.0.0.1에서만)`]);
  }
}

say('\n== 요약 ==');
for (const [s, m] of results) say(`[${s}] ${m}`);
const ok = results.every(([s]) => s === '통과');
say(`\n${ok ? '[통과]' : '[실패]'} #10 SearXNG`);
process.exitCode = ok ? 0 : 1;
