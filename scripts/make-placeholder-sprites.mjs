#!/usr/bin/env node
// 단색 임시 스프라이트 만들기 (13장 규격). 그림이 준비되면 assets/characters/<세트>/ 폴더만 바꾸면 된다.
//   node scripts/make-placeholder-sprites.mjs
// 규격: 프레임 128×128, 기준점 발 중앙(64, 120), 오른쪽 방향만, 동작 하나당 PNG 한 장(프레임을 가로로), 배경 투명.
// 이름표·말풍선·느낌표 같은 것은 그리지 않는다(화면 코드가 덧그린다).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'characters');
const F = 128;

const POSES = {
  idle: { frames: 2, fps: 2, loop: true },
  typing: { frames: 2, fps: 6, loop: true },
  walking: { frames: 6, fps: 10, loop: true },
  carrying: { frames: 6, fps: 10, loop: true },
  meeting: { frames: 2, fps: 2, loop: true },
  blocked: { frames: 2, fps: 3, loop: true },
  paused: { frames: 1, fps: 1, loop: false },
};

// 세트마다 한 가지 색 (단색 임시 그림). 사람은 둥근 몸, 고양이는 고양이 모양.
const SETS = {
  'chief-of-staff': [70, 78, 96],
  pm: [86, 120, 170],
  developer: [60, 90, 200],
  reviewer: [120, 84, 60],
  marketing: [214, 120, 40],
  strategy: [110, 130, 70],
  'qa-local': [150, 90, 160],
  'git-cat': [235, 140, 40],
  'temp-1': [120, 120, 120],
  'temp-2': [100, 140, 140],
  'temp-3': [150, 120, 100],
  'temp-4': [120, 110, 150],
};

// --- PNG 쓰기 (의존성 없음) ---
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// --- 그리기 ---
function canvas(frames) {
  const w = F * frames;
  const px = Buffer.alloc(w * F * 4);
  const set = (x, y, c, a = 255) => {
    if (x < 0 || y < 0 || x >= w || y >= F) return;
    const i = (Math.round(y) * w + Math.round(x)) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = a;
  };
  const rect = (x, y, rw, rh, c) => {
    for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) set(x + i, y + j, c);
  };
  const circle = (cx, cy, r, c) => {
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r) set(cx + i, cy + j, c);
  };
  return { w, px, rect, circle };
}

const shade = (c, k) => c.map((v) => Math.max(0, Math.min(255, Math.round(v * k))));

function drawPerson(cv, f, pose, c) {
  const ox = f * F;
  const dark = shade(c, 0.7);
  const bob = pose === 'idle' || pose === 'meeting' ? (f % 2) * 2 : pose === 'walking' || pose === 'carrying' ? [0, 2, 0, 0, 2, 0][f] : 0;
  const sit = pose === 'meeting' || pose === 'typing' ? 10 : 0;
  // 다리 (발끝이 y=120)
  if (pose === 'walking' || pose === 'carrying') {
    const swing = [-10, -5, 0, 10, 5, 0][f];
    cv.rect(ox + 54 + swing, 92, 9, 28, dark);
    cv.rect(ox + 66 - swing, 92, 9, 28, dark);
  } else {
    cv.rect(ox + 52, 92 + sit, 9, 28 - sit, dark);
    cv.rect(ox + 67, 92 + sit, 9, 28 - sit, dark);
  }
  // 몸과 머리
  cv.rect(ox + 44, 54 + bob + sit, 40, 42, c);
  cv.circle(ox + 64, 38 + bob + sit, 15, c);
  // 팔
  if (pose === 'typing') {
    cv.rect(ox + 80, 70 + sit + (f % 2) * 3, 18, 7, dark);
  } else if (pose === 'carrying') {
    cv.rect(ox + 80, 66 + bob, 14, 7, dark);
    cv.rect(ox + 88, 58 + bob, 26, 22, shade([180, 140, 90], 1)); // 상자
  } else if (pose === 'blocked') {
    cv.rect(ox + 72, 22 + sit + (f % 2) * 2, 16, 7, dark); // 머리 짚기
  } else {
    cv.rect(ox + 80, 60 + bob + sit, 7, 30, dark);
  }
}

function drawCat(cv, f, pose, c) {
  const ox = f * F;
  const dark = shade(c, 0.75);
  const bob = pose === 'walking' || pose === 'carrying' ? [0, 2, 0, 0, 2, 0][f] : (f % 2) * 1;
  // 몸 (낮고 길게), 다리
  cv.rect(ox + 34, 84 + bob, 56, 24, c);
  const swing = pose === 'walking' || pose === 'carrying' ? [-6, -3, 0, 6, 3, 0][f] : 0;
  for (const lx of [38, 50, 72, 84]) cv.rect(ox + lx + (lx < 60 ? swing : -swing), 106, 6, 14, dark);
  // 머리와 귀
  cv.circle(ox + 92, 78 + bob, 14, c);
  cv.rect(ox + 82, 60 + bob, 6, 8, c);
  cv.rect(ox + 98, 60 + bob, 6, 8, c);
  // 줄무늬 (같은 색의 진한 톤)
  for (const sx of [44, 56, 68]) cv.rect(ox + sx, 84 + bob, 4, 14, dark);
  // 꼬리
  const tail = pose === 'blocked' ? 26 : 16;
  cv.rect(ox + 22, 70 - (tail - 16) + bob, 8, tail, c);
  if (pose === 'carrying') cv.rect(ox + 100, 66 + bob, 18, 14, shade([180, 140, 90], 1)); // 라벨 붙인 상자
}

for (const [set, color] of Object.entries(SETS)) {
  const dir = join(ROOT, set);
  mkdirSync(dir, { recursive: true });
  const manifest = { id: set, frame: { width: F, height: F }, anchor: { x: 64, y: 120 }, poses: {} };
  for (const [pose, spec] of Object.entries(POSES)) {
    const cv = canvas(spec.frames);
    for (let f = 0; f < spec.frames; f++) (set === 'git-cat' ? drawCat : drawPerson)(cv, f, pose, color);
    writeFileSync(join(dir, `${pose}.png`), png(cv.w, F, cv.px));
    manifest.poses[pose] = { file: `${pose}.png`, ...spec };
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
console.log(`임시 스프라이트 ${Object.keys(SETS).length}세트를 만들었어요: ${ROOT}`);
