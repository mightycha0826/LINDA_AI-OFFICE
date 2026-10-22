// 층 전체 배치 (12장 3D 사무실, 3D 시안을 옮긴 것). 팀 자리·회의실·라운지·서버실 … 한 번만 짓는다.
// 화면 데이터로 바뀌는 것(파견 도킹 표시등, 회의실 표지, 결재 서류, Git 고양이, 배달 로봇)은 돌려준다.
import * as THREE from 'three';
import type { Furniture } from './furniture.ts';
import { GUEST_SEATS, MEETING_SEATS } from './layout.ts';
import { rnd } from './util.ts';

/** 층 크기(m)와 가운데 */
export const W = 30;
export const D = 19.5;
export const CX = 15;
export const CZ = 9.75;

export interface FloorParts {
  /** 파견 라운지 도킹 표시등 (GUEST_SEATS 순서) */
  docks: THREE.MeshStandardMaterial[];
  /** 결재함 서류 (결재 대기 수만큼 보인다) */
  papers: THREE.Mesh[];
  meetingSign: { busy: THREE.Mesh; free: THREE.Mesh };
  cat: THREE.Group;
  robot: THREE.Group;
}

export function buildFloor(f: Furniture, names: Readonly<Record<string, string>>): FloorParts {
  const docks: THREE.MeshStandardMaterial[] = [];
  const papers: THREE.Mesh[] = [];
  f.flat(W, 0.1, D, 0xe6e2da, CX, -0.05, CZ);
  f.tiles(0, 0, W, D, 0xe9e5dd, 0xdcd6cb, 1.2);
  f.flat(28.4, 0.005, 0.06, 0x7fb59a, CX, 0.02, 6.9);
  f.flat(28.4, 0.005, 0.06, 0x7fb59a, CX, 0.02, 12.05);
  // 북쪽 통유리·블라인드·창턱, 낮은 벽, 기둥
  f.box(W, 0.35, 0.2, 0xd4cfc5, CX, 0.17, 0);
  for (let mx = 0; mx <= W; mx += 1.5) f.box(0.06, 3.2, 0.1, 0x8e9895, mx, 1.6, 0);
  const ng = new THREE.Mesh(new THREE.BoxGeometry(W, 2.9, 0.04), f.glass);
  ng.position.set(CX, 1.75, 0);
  f.scene.add(ng);
  f.box(W, 0.1, 0.16, 0x8e9895, CX, 3.2, 0);
  for (let s = 0; s < 6; s++) f.flat(W, 0.035, 0.06, 0xedeae4, CX, 3.05 - s * 0.075, 0.1);
  f.box(W, 0.06, 0.32, 0xc9c1b4, CX, 0.42, 0.22);
  f.box(0.2, 0.5, D, 0xd4cfc5, 0, 0.25, CZ);
  f.box(0.2, 0.5, D, 0xd4cfc5, W, 0.25, CZ);
  f.box(W, 0.5, 0.2, 0xd4cfc5, CX, 0.25, D);
  for (const [x, z] of [[10, 7.0], [20.2, 7.0], [10.8, 12.4], [16.75, 12.4]] as const) f.box(0.45, 3.1, 0.45, 0xf2efe9, x, 1.55, z);
  for (let px = 1.2; px < W; px += 3.6) f.plant(px, 0.45, 0.22, 0.2);

  // 개발팀
  f.tiles(0.8, 0.9, 9.4, 6.2, 0xd9dee4, 0xc7ced6);
  f.hangingSign('개발팀', 'Dev', 4.6, 0.75);
  f.bench(1.6, 2.3, 3, names, { dual: true, screen: 0x8fa3b8, tone: 'ash', kind: 'code' });
  f.whiteboard(8.6, 3.2, 1.5, -Math.PI / 2, [[-0.4, 0.25, 0.4, 0x2d64c8], [-0.1, 0.1, 0.9, 0x1b211e], [0.2, -0.1, 0.5, 0xc0392b], [-0.3, -0.25, 0.6, 0x17845a]]);
  f.box(0.6, 1.1, 0.4, 0x3b4048, 8.6, 0.55, 5.3);
  f.pendant(3.6, 3.1);
  f.pendant(5.6, 3.1);
  f.planterWall(9.8, 1.0, 5.8);
  // 품질보증팀
  f.tiles(10.2, 0.9, 14.8, 6.2, 0xdce3dc, 0xc9d3c9);
  f.hangingSign('품질보증팀', 'QA', 12.4, 0.75);
  f.bench(10.4, 2.3, 2, names, { screen: 0x9db5a0, tone: 'oak', kind: 'doc' });
  f.box(1.2, 0.9, 0.4, 0xd9d3c7, 12.4, 0.45, 5.6);
  f.pendant(12.4, 3.1);
  f.planterWall(15.0, 1.0, 5.8);
  // 기획실 + 칸반 벽
  f.tiles(15.4, 0.9, 20.2, 6.2, 0xe2dee6, 0xd1ccd8);
  f.hangingSign('기획실', 'Planning', 17.6, 0.75);
  f.bench(15.6, 2.3, 2, names, { laptop: true, screen: 0xb3a7c4, tone: 'oak', kind: 'doc' });
  f.whiteboard(17.6, 5.75, 2.4, 0);
  const notes = [0xf7d96b, 0xf4a6a0, 0xa8d5ba, 0xa7c7f2];
  for (let col = 0; col < 3; col++) for (let r = 0; r < 4; r++) if ((col + r) % 4 !== 3) f.flat(0.16, 0.16, 0.01, notes[(col + r) % 4]!, 16.85 + col * 0.75, 1.75 - r * 0.2, 5.78);
  f.pendant(17.6, 3.1);
  // CEO실
  f.tiles(20.6, 0.9, 26.4, 6.4, 0xe5d6bc, 0xd5c3a3, 0.6);
  f.glassRoom(20.6, 0.9, 26.4, 6.4, { side: 'w', at: 4.9 });
  f.textPlane('CEO실', null, 1.0, 0.28, 0x1b211e, 0xffffff, 20.56, 1.8, 3.95, -Math.PI / 2);
  f.flat(2.4, 0.015, 1.9, 0xcdbfa8, 22.0, 0.02, 2.2);
  f.box(0.7, 0.42, 1.9, 0x9db2a6, 21.05, 0.21, 2.2);
  f.box(0.18, 0.75, 1.9, 0x8ba294, 20.8, 0.38, 2.2);
  f.woodBox(0.9, 0.36, 0.6, 'oak', 22.2, 0.18, 2.2);
  f.roundTop(2.0, 0.95, 0.12, 'walnut', 24.9, 0.79, 1.7, 0.05);
  f.woodBox(1.9, 0.7, 0.05, 'walnut', 24.9, 0.4, 2.15);
  f.monitor(24.6, 1.45, 1, 0, 'chart');
  f.lamp(25.75, 1.4);
  f.chair(24.9, 1.15, 1, 0x22262a);
  f.woodBox(1.8, 1.6, 0.35, 'ash', 24.9, 0.8, 1.0);
  f.bench(21.3, 4.0, 2, names, { screen: 0xa7b9b0, tone: 'walnut', kind: 'chart' });
  f.tallPlant(26.0, 5.9);
  // 서버실
  f.tiles(26.9, 0.9, 29.1, 6.4, 0xd8d6d2, 0xc5c2bc, 0.6);
  f.glassRoom(26.9, 0.9, 29.1, 6.4, { side: 's', at: 28.0 });
  for (const rx of [27.5, 28.5]) f.serverRack(rx);
  // 계단 라이브러리
  ([[1.0, 8.0], [0.75, 8.8], [0.5, 9.6], [0.25, 10.4]] as const).forEach(([h, z], i) => f.woodBox(8.6, h, 0.8, i < 2 ? 'ash' : 'oak', 5.3, h / 2, z));
  f.woodBox(8.6, 2.3, 0.35, 'walnut', 5.3, 1.15, 7.45);
  const books = [0x2f8f5b, 0xc9b796, 0x5b665f, 0x3e7bd6, 0xe7dcc8, 0xb4541a, 0x7a4e8c];
  for (let row = 0; row < 3; row++) {
    for (let bx = 1.2; bx < 9.4; bx += 0.17) {
      if (rnd(bx * 13 + row) < 0.12) continue;
      const bh = 0.42 + rnd(bx * 7 + row) * 0.18;
      f.flat(0.13, bh, 0.24, books[Math.floor(rnd(bx * 3 + row * 5) * books.length)]!, bx, 0.35 + row * 0.7 + bh / 2, 7.65);
    }
  }
  f.tallPlant(9.6, 10.6);
  // 커피 바
  f.tiles(10.9, 7.4, 15.8, 11.4, 0xe6e1d8, 0xd6cfc2, 0.5);
  f.box(4.6, 1.0, 0.8, 0x2f3532, 13.3, 0.5, 8.0);
  f.woodBox(4.7, 0.05, 0.86, 'oak', 13.3, 1.02, 8.0);
  f.box(0.55, 0.55, 0.45, 0xb9c2bd, 11.7, 1.32, 7.9);
  f.woodBox(4.6, 0.04, 0.25, 'walnut', 13.3, 2.0, 7.65);
  f.woodBox(4.6, 0.04, 0.25, 'walnut', 13.3, 2.45, 7.65);
  for (const sx of [12.0, 13.2, 14.4]) {
    f.cyl(0.22, 0.22, 0.06, 0xcdbfa8, sx, 0.62, 9.35);
    f.cyl(0.04, 0.04, 0.6, 0x6c726e, sx, 0.3, 9.35, undefined, 8);
  }
  for (const tx of [12.0, 14.4]) {
    f.cyl(0.4, 0.4, 0.04, 0xf4f0e8, tx, 0.74, 10.6).material = f.wood('ash');
    f.cyl(0.04, 0.04, 0.72, 0x6c726e, tx, 0.36, 10.6, undefined, 8);
  }
  f.pendant(12.6, 9.0);
  f.pendant(14.0, 9.0);
  // 라운지
  f.tiles(16.2, 7.6, 22.6, 11.2, 0xdce3de, 0xcbd4ce, 0.8);
  f.box(3.2, 0.42, 0.85, 0x9db2a6, 18.4, 0.21, 8.15);
  f.box(3.2, 0.6, 0.2, 0x8ba294, 18.4, 0.45, 7.8);
  f.box(3.2, 0.42, 0.85, 0x9db2a6, 18.4, 0.21, 10.35);
  f.box(3.2, 0.6, 0.2, 0x8ba294, 18.4, 0.45, 10.7);
  const ct = f.cyl(0.95, 0.95, 0.05, 0xc6ad86, 18.4, 0.4, 9.25);
  ct.material = f.wood('oak');
  ct.scale.z = 0.42;
  f.tallPlant(22.2, 7.9);
  f.tallPlant(16.5, 10.9);
  f.restBench(21.275,8.25,1.8,1);
  f.restBench(21.275,10.35,1.8,-1);
  f.restBench(18.8,18.2,2.6,-1);
  // 폰 부스
  for (const bx of [23.0, 24.4]) {
    f.glassRoom(bx, 7.9, bx + 1.2, 9.4, { side: 's', at: bx + 0.6 }, 2.2);
    f.box(1.0, 0.04, 0.4, 0xf4f0e8, bx + 0.6, 0.75, 8.15);
  }
  // 리셉션·엘리베이터 + 결재함 서류 (결재 대기 수만큼)
  f.tiles(25.8, 7.4, 29.6, 11.6, 0xe3e0da, 0xd2cec6, 0.6);
  f.box(2.4, 1.05, 0.6, 0xf4f0e8, 27.2, 0.52, 10.0);
  f.woodBox(2.5, 0.05, 0.75, 'walnut', 27.2, 1.07, 10.0);
  f.textPlane('LINDA', 'AI OFFICE · 2F', 2.2, 0.55, 0x1b211e, 0xffffff, 27.2, 0.62, 10.31);
  for (let i = 0; i < 5; i++) {
    const p = f.box(0.3, 0.012, 0.22, 0xf7f6f1, 26.4 + i * 0.01, 1.11 + i * 0.014, 10.0 + i * 0.01);
    p.rotation.y = i * 0.07;
    papers.push(p);
  }
  for (const ez of [8.2, 9.8]) f.box(0.1, 2.4, 1.2, 0xb7bdbd, 29.75, 1.2, ez, undefined, { metalness: 0.6, roughness: 0.3 });
  f.tallPlant(26.0, 7.8);
  // 마케팅·콘텐츠팀
  f.tiles(0.8, 12.5, 5.7, 17.4, 0xe9e0d1, 0xd9cdb8);
  f.hangingSign('마케팅 · 콘텐츠팀', 'Marketing', 3.3, 12.35);
  f.bench(1.3, 13.3, 2, names, { laptop: true, screen: 0xd7bf96, tone: 'oak', kind: 'doc' });
  f.whiteboard(3.3, 16.9, 2.6, Math.PI);
  f.pendant(3.3, 14.1);
  f.planterWall(5.95, 12.6, 17.2);
  // 리서치·전략팀
  f.tiles(6.2, 12.5, 10.6, 17.4, 0xd8e2e1, 0xc5d2d1);
  f.hangingSign('리서치 · 전략팀', 'Research', 8.4, 12.35);
  f.bench(6.4, 13.3, 2, names, { dual: true, screen: 0x93b3b0, tone: 'ash', kind: 'chart' });
  f.woodBox(2.6, 1.8, 0.35, 'walnut', 8.4, 0.9, 17.0);
  f.sphere(0.17, 0x3e7bd6, 9.4, 2.12, 16.95);
  f.pendant(8.4, 14.1);
  // 회의실 A
  f.tiles(11.0, 12.6, 16.6, 18.6, 0xcfd8d2, 0xbec9c2);
  f.glassRoom(11.0, 12.6, 16.6, 18.6, { side: 'n', at: 13.8 });
  const meetingSign = {
    busy: f.textPlane('회의실 A · 사용 중', null, 1.6, 0.26, 0x2d64c8, 0xffffff, 15.3, 2.2, 12.57),
    free: f.textPlane('회의실 A · 비어 있음', null, 1.6, 0.26, 0x5b665f, 0xffffff, 15.3, 2.2, 12.57),
  };
  f.box(3.2, 1.8, 0.06, 0x1e2320, 13.8, 1.4, 18.5);
  const tv = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.6), f.screenMat(null, 0xa9c7e3));
  tv.position.set(13.8, 1.4, 18.46);
  tv.rotation.y = Math.PI;
  f.scene.add(tv);
  const mt = f.cyl(2.0, 2.0, 0.07, 0xb89b74, 13.8, 0.76, 15.6);
  mt.material = f.wood('oak');
  mt.scale.z = 0.43;
  f.cyl(0.15, 0.25, 0.72, 0x5e4a34, 13.8, 0.37, 15.6, undefined, 12);
  for (const s of MEETING_SEATS) f.chair(s.x, s.z, s.face);
  f.tallPlant(16.1, 18.1);
  // 운영지원
  f.tiles(16.9, 12.5, 23.0, 17.4, 0xe0e1d6, 0xcdcfc0);
  f.hangingSign('운영지원', 'Ops', 19.9, 12.35);
  f.bench(17.8, 13.3, 2, names, { screen: 0xb5b99a, tone: 'ash', kind: 'code' });
  f.box(0.9, 0.7, 0.6, 0xe9e7e1, 22.4, 0.35, 16.6);
  for (let lk = 0; lk < 6; lk++) f.box(0.5, 1.8, 0.45, 0xb5bec2, 17.4 + lk * 0.52, 0.9, 17.05);
  f.box(1.0, 0.5, 0.5, 0xc8b590, 22.4, 0.25, 15.6);
  f.pendant(19.9, 14.1);
  // 파견 라운지 (빌려 온 친구 계정, 8장)
  f.tiles(23.4, 12.5, 26.5, 17.4, 0xe6e0ee, 0xd6cee2);
  f.hangingSign('파견 라운지', '친구 계정', 24.95, 12.35);
  f.bench(23.95, 13.6, 1, names, { screen: 0xb9a9d4, tone: 'walnut', kind: 'code' });
  for (const [i, g] of GUEST_SEATS.entries()) {
    const z = g.face > 0 ? 13.95 : 15.25;
    f.box(0.24, 0.05, 0.14, 0x22262a, 25.55, 0.8, z);
    const lm = new THREE.MeshStandardMaterial({ color: 0x8e9496, emissive: 0x000000, emissiveIntensity: 1.2 });
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.02), lm);
    led.position.set(25.61, 0.83, z + 0.071 * (g.face > 0 ? -1 : 1));
    f.scene.add(led);
    docks[i] = lm;
  }
  f.box(0.9, 0.42, 0.45, 0xc9bfd9, 24.0, 0.21, 16.9);
  f.tallPlant(26.1, 17.0);
  f.planterWall(26.65, 12.6, 17.2);
  // 탕비실
  f.tiles(26.9, 12.5, 29.6, 18.9, 0xe4e1db, 0xd3cfc7, 0.5);
  f.box(2.4, 0.92, 0.65, 0xe9e5dd, 28.3, 0.46, 18.55);
  f.box(0.85, 1.9, 0.7, 0xd9d6d0, 29.2, 0.95, 17.6, undefined, { metalness: 0.3, roughness: 0.4 });
  f.box(0.85, 1.8, 0.75, 0x2f5d8a, 29.2, 0.9, 16.4);
  f.box(0.32, 1.05, 0.32, 0xf2eee6, 29.2, 0.52, 14.9);
  f.cyl(0.5, 0.5, 0.04, 0xf4f0e8, 27.9, 0.74, 14.2).material = f.wood('oak');
  f.chair(27.9, 13.45, 1, 0xc8b590);
  f.chair(27.9, 14.95, -1, 0xc8b590);
  f.mug(27.75, 14.1, 0xffffff, 0.4);
  // Git 고양이와 배달 로봇
  const cat = new THREE.Group();
  const o = 0xe8913a;
  f.box(0.5, 0.24, 0.24, o, 0, 0.26, 0, cat);
  f.sphere(0.14, o, 0.3, 0.38, 0, cat);
  for (const [x, z] of [[0.18, 0.08], [0.18, -0.08], [-0.18, 0.08], [-0.18, -0.08]] as const) f.box(0.06, 0.16, 0.06, o, x, 0.08, z, cat);
  f.box(0.05, 0.05, 0.32, o, -0.33, 0.42, 0, cat).rotation.z = 0.9;
  f.scene.add(cat);
  const robot = new THREE.Group();
  f.box(0.6, 0.45, 0.5, 0xfafaf8, 0, 0.32, 0, robot);
  f.box(0.42, 0.18, 0.04, 0x262b28, 0, 0.45, 0.26, robot);
  f.scene.add(robot);
  return { docks, papers, meetingSign, cat, robot };
}
