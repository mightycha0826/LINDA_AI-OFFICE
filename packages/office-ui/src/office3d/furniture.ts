// 3D 사무실 가구 (12장): 의자·모니터·화분·조명·긴 공용 책상·유리방 … Builder의 도형으로 만든다.
import * as THREE from 'three';
import { Builder, type ScreenKind, type WoodTone } from './builder.ts';
import { DESK_SEATS } from './layout.ts';
import { buildKeyboard, buildMouse, createKeyboardLegends } from './peripherals.ts';
import { rnd } from './util.ts';

export class Furniture extends Builder {
  private readonly keyboardLegends = createKeyboardLegends();
  private readonly leafGeo = new Map<string, THREE.ShapeGeometry>();
  private readonly leafMat = new Map<number, THREE.MeshStandardMaterial>();

  dispose(): void {
    this.keyboardLegends.map?.dispose();
    this.keyboardLegends.dispose();
  }

  chair(x: number, z: number, face: 1 | -1, color = 0x3a403c): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = face > 0 ? 0 : Math.PI;
    this.box(0.5, 0.07, 0.48, color, 0, 0.45, 0.01, g);
    this.box(0.46, 0.03, 0.44, 0x2a2e2b, 0, 0.405, 0.01, g);
    this.box(0.48, 0.5, 0.06, color, 0, 0.78, -0.26, g).rotation.x = 0.1;
    this.box(0.4, 0.08, 0.04, 0x2a2e2b, 0, 0.56, -0.25, g);
    for (const sd of [-1, 1]) {
      this.box(0.05, 0.03, 0.28, 0x2a2e2b, sd * 0.27, 0.64, -0.02, g);
      this.box(0.03, 0.18, 0.03, 0x6c726e, sd * 0.27, 0.54, -0.1, g);
    }
    this.cyl(0.03, 0.035, 0.34, 0x8a908c, 0, 0.23, 0, g, 10);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      this.box(0.3, 0.035, 0.05, 0x5e6662, Math.cos(a) * 0.15, 0.07, Math.sin(a) * 0.15, g).rotation.y = -a;
      const wh = this.cyl(0.03, 0.03, 0.035, 0x1f2321, Math.cos(a) * 0.28, 0.03, Math.sin(a) * 0.28, g, 10);
      wh.rotation.z = Math.PI / 2;
    }
    this.scene.add(g);
    return g;
  }
  restBench(x: number, z: number, width: number, face: 1 | -1): void {
    const g = new THREE.Group(); g.position.set(x,0,z); g.rotation.y = face > 0 ? 0 : Math.PI; this.scene.add(g);
    this.box(width,0.08,0.48,0xa4b4a6,0,0.42,0,g);
    this.box(width,0.3,0.06,0x8b9f91,0,0.68,-0.23,g);
    for (const side of [-1,1]) for (const depth of [-0.16,0.16]) this.box(0.045,0.38,0.045,0x53655c,side*(width/2-0.12),0.19,depth,g);
  }
  monitor(x: number, z: number, face: 1 | -1, yaw = 0, kind: ScreenKind | null = 'doc', arm = false): void {
    const g = new THREE.Group();
    g.position.set(x, 0.77, z);
    g.rotation.y = (face > 0 ? 0 : Math.PI) + yaw;
    if (arm) {
      this.box(0.04, 0.32, 0.04, 0x9aa0a3, 0, 0.16, -0.06, g);
      this.box(0.04, 0.04, 0.12, 0x9aa0a3, 0, 0.3, -0.01, g);
    } else {
      this.box(0.05, 0.3, 0.05, 0x2a302c, 0, 0.15, -0.03, g);
      this.box(0.24, 0.015, 0.17, 0x2a302c, 0, 0.008, 0, g);
    }
    this.box(0.62, 0.38, 0.025, 0x16191a, 0, 0.42, 0.03, g);
    const s = new THREE.Mesh(new THREE.PlaneGeometry(0.59, 0.335), this.screenMat(kind));
    s.position.set(0, 0.43, 0.044);
    g.add(s);
    this.scene.add(g);
  }
  private laptop(x: number, z: number, face: 1 | -1, kind: ScreenKind = 'doc'): void {
    const g = new THREE.Group();
    g.position.set(x, 0.775, z);
    g.rotation.y = face > 0 ? 0 : Math.PI;
    this.box(0.34, 0.015, 0.24, 0xb9bec0, 0, 0.008, 0, g);
    const lid = new THREE.Group();
    lid.position.set(0, 0.015, -0.12);
    lid.rotation.x = -0.25;
    g.add(lid);
    this.box(0.34, 0.22, 0.012, 0xb9bec0, 0, 0.11, 0, lid);
    const s = new THREE.Mesh(new THREE.PlaneGeometry(0.31, 0.19), this.screenMat(kind));
    s.position.set(0, 0.11, 0.008);
    lid.add(s);
    this.scene.add(g);
  }
  private leaf(parent: THREE.Object3D, len: number, wid: number, color: number, yaw: number, tilt: number, x: number, y: number, z: number, curl = 0): void {
    const key = `${len}:${wid}`;
    let geo = this.leafGeo.get(key);
    if (!geo) {
      const s = new THREE.Shape();
      s.moveTo(0, 0);
      s.bezierCurveTo(wid * 0.9, len * 0.15, wid, len * 0.65, 0, len);
      s.bezierCurveTo(-wid, len * 0.65, -wid * 0.9, len * 0.15, 0, 0);
      geo = new THREE.ShapeGeometry(s, 10);
      this.leafGeo.set(key, geo);
    }
    let mat = this.leafMat.get(color);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.6 });
      this.leafMat.set(color, mat);
    }
    const piv = new THREE.Group();
    piv.position.set(x, y, z);
    piv.rotation.set(0, yaw, 0);
    parent.add(piv);
    const inner = new THREE.Group();
    inner.rotation.x = tilt;
    piv.add(inner);
    const m = new THREE.Mesh(geo, mat);
    m.rotation.y = curl;
    m.castShadow = true;
    inner.add(m);
  }
  private pot(x: number, y: number, z: number, r: number, h: number, color = 0xede8de): { g: THREE.Group; top: number } {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    this.scene.add(g);
    this.cyl(r * 1.05, r * 0.95, 0.02, 0xbdb5a6, 0, 0.01, 0, g, 24);
    this.cyl(r, r * 0.78, h, color, 0, h / 2 + 0.02, 0, g, 24);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r * 0.98, r * 0.06, 8, 24), this.mat(color));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = h + 0.02;
    g.add(rim);
    this.cyl(r * 0.92, r * 0.92, 0.01, 0x4a3828, 0, h + 0.01, 0, g, 24);
    return { g, top: h + 0.03 };
  }
  plant(x: number, y: number, z: number, s = 0.5): void {
    const GREENS = [0x2f7f52, 0x3a9460, 0x267048, 0x4aa36c];
    if (s < 0.25) {
      const p = this.pot(x, y, z, 0.05, 0.06, 0xe07a5f);
      for (let ring = 0; ring < 3; ring++) for (let i = 0; i < 7; i++) this.leaf(p.g, 0.05 - ring * 0.012, 0.022, ring ? 0x8fbf8a : 0x6fa57a, (i / 7) * 6.28 + ring * 0.4, 1.25 - ring * 0.4, 0, p.top, 0);
      return;
    }
    if (rnd(x * 1.3 + z * 0.7) < 0.45) {
      const p = this.pot(x, y, z, (0.15 * s) / 0.4, (0.28 * s) / 0.4, 0x3b4048);
      for (let i = 0; i < 11; i++) {
        const yaw = rnd(i + x) * 6.28;
        const r = rnd(i * 7 + z) * 0.08 * s;
        this.leaf(p.g, ((0.45 + rnd(i * 3 + x) * 0.35) * s) / 0.4, (0.045 * s) / 0.4, i % 3 ? 0x2e6b45 : 0x557a3a, yaw, 0.08 + rnd(i + 9) * 0.18, Math.sin(yaw) * r, p.top, Math.cos(yaw) * r, 0.3);
      }
      return;
    }
    const p = this.pot(x, y, z, (0.22 * s) / 0.5, (0.36 * s) / 0.5, 0xe7e1d5);
    for (let i = 0; i < 9; i++) {
      const yaw = (i / 9) * Math.PI * 2 + rnd(x + i) * 0.5;
      const stemH = ((0.35 + rnd(i + x * 3) * 0.35) * s) / 0.5;
      const sx = Math.sin(yaw) * 0.12 * s;
      const sz = Math.cos(yaw) * 0.12 * s;
      const st = this.cyl(0.008, 0.012, stemH, 0x5c8a4a, sx / 2, p.top + stemH / 2, sz / 2, p.g, 6);
      st.rotation.x = Math.cos(yaw) * 0.35;
      st.rotation.z = -Math.sin(yaw) * 0.35;
      this.leaf(p.g, (0.34 * s) / 0.5, (0.24 * s) / 0.5, GREENS[i % 4]!, yaw, 0.7 + rnd(z + i) * 0.6, sx, p.top + stemH, sz, 0.2);
    }
  }
  tallPlant(x: number, z: number): void {
    const GREENS = [0x2f7f52, 0x3a9460, 0x267048, 0x4aa36c];
    const p = this.pot(x, 0, z, 0.27, 0.48, 0xd6cdbe);
    this.cyl(0.025, 0.04, 1.35, 0x6b5134, 0, p.top + 0.65, 0, p.g, 8);
    const branches = [[0.4, 1.15, 0.35], [2.3, 1.3, 0.3], [4.2, 1.0, 0.32], [5.4, 1.45, 0.25]] as const;
    branches.forEach((b, bi) => {
      const bx = Math.sin(b[0]) * b[2];
      const bz = Math.cos(b[0]) * b[2];
      const br = this.cyl(0.012, 0.018, Math.hypot(b[2], 0.25), 0x6b5134, bx / 2, p.top + b[1], bz / 2, p.g, 6);
      br.rotation.x = Math.cos(b[0]) * 0.9;
      br.rotation.z = -Math.sin(b[0]) * 0.9;
      for (let i = 0; i < 6; i++) this.leaf(p.g, 0.26, 0.16, GREENS[(i + bi) % 4]!, b[0] + (i - 2.5) * 0.5, 0.6 + rnd(i + bi * 7 + x) * 0.7, bx * (0.6 + i * 0.08), p.top + b[1] + 0.12 + i * 0.03, bz * (0.6 + i * 0.08), 0.1);
    });
    for (let t = 0; t < 7; t++) this.leaf(p.g, 0.28, 0.17, GREENS[t % 4]!, (t / 7) * 6.28, 0.35 + rnd(t + z) * 0.4, 0, p.top + 1.32, 0, 0.1);
  }
  lamp(x: number, z: number): void {
    this.cyl(0.07, 0.08, 0.02, 0x2a302c, x, 0.785, z, undefined, 16);
    this.box(0.02, 0.3, 0.02, 0x2a302c, x, 0.93, z).rotation.z = 0.25;
    this.box(0.02, 0.26, 0.02, 0x2a302c, x - 0.08, 1.15, z).rotation.z = -0.9;
    this.cyl(0.035, 0.07, 0.07, 0x2a302c, x - 0.2, 1.2, z, undefined, 14);
  }
  mug(x: number, z: number, color: number, rot = 0): void {
    const g = new THREE.Group();
    g.position.set(x, 0.775, z);
    g.rotation.y = rot;
    this.scene.add(g);
    this.cyl(0.04, 0.036, 0.09, color, 0, 0.045, 0, g, 16);
    this.cyl(0.034, 0.034, 0.005, 0x4a3226, 0, 0.088, 0, g, 16);
    const h = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.006, 6, 12, Math.PI), this.mat(color));
    h.position.set(0.04, 0.045, 0);
    h.rotation.z = -Math.PI / 2;
    g.add(h);
  }
  private deskStuff(sx: number, deskZ: number, face: 1 | -1, seed: number, name: string | null): void {
    const k = rnd(seed);
    const input = new THREE.Group();
    input.position.set(sx, 0.812, deskZ + 0.08 * face);
    input.rotation.y = face > 0 ? 0 : Math.PI;
    this.scene.add(input);
    input.add(buildKeyboard(color => this.mat(color), this.keyboardLegends));
    // Layered stitched pad and a sculpted wireless mouse, on the user's right.
    this.box(0.232, 0.003, 0.204, 0x758b89, -0.34, 0.0015, 0, input);
    this.box(0.224, 0.002, 0.196, 0x344848, -0.34, 0.004, 0, input);
    const mouse = buildMouse(color => this.mat(color));
    mouse.position.set(-0.34, 0.005, 0.005); input.add(mouse);
    if (k < 0.75) this.mug(sx - 0.4, deskZ + 0.15 * face, [0xffffff, 0xe07a5f, 0x3e7bd6, 0x2f2f2f][Math.floor(k * 4)]!, k * 6);
    if (k > 0.3) this.box(0.15, 0.012, 0.21, [0x2f5d8a, 0x7a4e8c, 0xc9b796][Math.floor(k * 3)]!, sx - 0.55, 0.782, deskZ + 0.3 * face).rotation.y = 0.2;
    if (k > 0.55) {
      this.cyl(0.03, 0.03, 0.2, 0x8fb4c8, sx + 0.62, 0.875, deskZ + 0.25 * face, undefined, 12);
      this.cyl(0.022, 0.022, 0.03, 0x2a302c, sx + 0.62, 0.99, deskZ + 0.25 * face, undefined, 10);
    }
    if (k < 0.4) {
      const hp = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.012, 6, 16, Math.PI), this.mat(0x22262a));
      hp.position.set(sx + 0.6, 0.79, deskZ + 0.3 * face);
      hp.rotation.x = -Math.PI / 2;
      this.scene.add(hp);
    }
    if (k > 0.8) this.plant(sx - 0.62, 0.775, deskZ + 0.45 * face, 0.16);
    this.box(0.08, 0.008, 0.15, 0x1b211e, sx - 0.2, 0.78, deskZ + 0.38 * face).rotation.y = 0.4;
    if (name) this.textPlane(name, null, 0.36, 0.09, 0xffffff, 0x1b211e, sx, 1.06, deskZ + (face > 0 ? 0.6 : -0.6) - 0.025 * face, face > 0 ? Math.PI : 0);
  }
  /** 긴 공용 책상: 좌석 x = x0 + 1 + 2i, 북쪽 좌석 z = zN - 0.3, 남쪽 좌석 z = zN + 1.95. 의자는 늘 놓고 사람만 오간다 */
  bench(x0: number, zN: number, n: number, names: Readonly<Record<string, string>>, o: { dual?: boolean; laptop?: boolean; screen?: number; tone?: WoodTone; kind?: ScreenKind } = {}): void {
    const w = n * 2;
    const d = 1.65;
    const zc = zN + d / 2;
    this.roundTop(w, d, 0.08, o.tone ?? 'oak', x0 + w / 2, 0.77, zc, 0.04);
    this.box(w - 0.1, 0.38, 0.04, o.screen ?? 0xc9c0af, x0 + w / 2, 0.98, zc);
    this.flat(w - 0.06, 0.03, 0.06, 0x9aa0a3, x0 + w / 2, 1.18, zc);
    for (let lx = 0; lx <= n; lx++) {
      const px = x0 + 0.15 + (lx * (w - 0.3)) / n;
      this.box(0.05, 0.7, 0.06, 0x3a3f3d, px, 0.4, zc);
      this.box(0.05, 0.04, d - 0.2, 0x3a3f3d, px, 0.03, zc);
      this.box(0.05, 0.04, d - 0.3, 0x3a3f3d, px, 0.73, zc);
    }
    this.box(w - 0.3, 0.06, 0.14, 0x5e6662, x0 + w / 2, 0.66, zc);
    const seatName = (x: number, z: number) => {
      const id = Object.entries(DESK_SEATS).find(([, s]) => Math.abs(s.x - x) < 0.3 && Math.abs(s.z - z) < 0.3)?.[0];
      return id ? (names[id] ?? null) : null;
    };
    for (let i = 0; i < n; i++) {
      const sx = x0 + 1 + 2 * i;
      for (const [sz, face] of [[zN - 0.3, 1], [zN + d + 0.3, -1]] as const) {
        const deskZ = face > 0 ? zN + 0.15 : zN + d - 0.15;
        const monZ = face > 0 ? zc - 0.22 : zc + 0.22;
        const kind = o.kind ?? 'doc';
        if (o.dual) {
          this.monitor(sx - 0.32, monZ, face > 0 ? -1 : 1, -0.16 * face, 'code', true);
          this.monitor(sx + 0.32, monZ, face > 0 ? -1 : 1, 0.16 * face, kind === 'code' ? 'chat' : kind, true);
        } else if (o.laptop) this.laptop(sx, deskZ + 0.4 * face, face > 0 ? -1 : 1, kind);
        else this.monitor(sx, monZ, face > 0 ? -1 : 1, 0, kind);
        this.deskStuff(sx, deskZ, face, sx * 7 + sz * 3, seatName(sx, sz));
        const pz = face > 0 ? zN + 0.32 : zN + d - 0.32;
        this.box(0.42, 0.56, 0.5, 0xbfc3c0, sx + 0.62, 0.3, pz);
        for (const hy of [0.42, 0.28, 0.14]) this.flat(0.16, 0.015, 0.02, 0x7e8581, sx + 0.62, hy + 0.06, pz + 0.26 * face);
        this.chair(sx, sz, face);
      }
    }
    this.lamp(x0 + w - 0.25, zN + 0.3);
    this.plant(x0 + w / 2, 1.19, zc, 0.16);
  }
  planterWall(x: number, z1: number, z2: number): void {
    const len = z2 - z1;
    const zc = z1 + len / 2;
    this.woodBox(0.38, 0.95, len, 'ash', x, 0.475, zc);
    this.flat(0.3, 0.04, len - 0.1, 0x4a3828, x, 0.97, zc);
    for (let z = z1 + 0.25; z < z2 - 0.15; z += 0.18) {
      for (let j = 0; j < 3; j++) this.leaf(this.scene, 0.3 + rnd(z * 9 + j) * 0.25, 0.035, (j + Math.round(z * 10)) % 3 ? 0x2e6b45 : 0x557a3a, rnd(z + j) * 6.28, 0.1 + rnd(z * 3 + j) * 0.2, x + (j - 1) * 0.08, 0.98, z);
    }
  }
  hangingSign(text: string, sub: string, x: number, z: number): void {
    this.textPlane(text, sub, 2.4, 0.6, 0xffffff, 0x1b211e, x, 2.75, z + 0.01);
    this.box(2.46, 0.66, 0.03, 0x2a302c, x, 2.75, z - 0.02).castShadow = false;
    for (const sd of [-1, 1]) this.box(0.012, 0.6, 0.012, 0x2a302c, x + sd * 1.0, 3.38, z);
  }
  pendant(x: number, z: number): void {
    this.box(0.008, 0.6, 0.008, 0x2a302c, x, 3.1, z).castShadow = false;
    this.cyl(0.07, 0.2, 0.16, 0x2a302c, x, 2.72, z).castShadow = false;
    const bm = new THREE.MeshStandardMaterial({ color: 0xfff4da, emissive: 0xffd9a0, emissiveIntensity: 0.2 });
    const b = new THREE.Mesh(new THREE.CircleGeometry(0.19, 20), bm);
    b.rotation.x = Math.PI / 2;
    b.position.set(x, 2.635, z);
    this.scene.add(b);
    this.bulbs.push(bm);
    const l = new THREE.PointLight(0xffd9a0, 0, 6.5, 2);
    l.position.set(x, 2.2, z);
    this.scene.add(l);
    this.lamps.push(l);
  }
  whiteboard(x: number, z: number, w: number, rotY: number, scribble: readonly (readonly [number, number, number, number])[] = []): void {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    this.box(w, 1.0, 0.04, 0xfafaf7, 0, 1.45, 0, g);
    this.box(w + 0.06, 0.04, 0.08, 0x9aa3a0, 0, 0.94, 0.02, g);
    for (const s of scribble) this.flat(s[2], 0.03, 0.005, s[3], s[0], 1.45 + s[1], 0.025, g);
    for (const dx of [-w / 2 + 0.1, w / 2 - 0.1]) this.box(0.04, 0.95, 0.04, 0x9aa3a0, dx, 0.47, 0, g);
    this.scene.add(g);
  }
  glassRoom(x1: number, z1: number, x2: number, z2: number, door: { side: 'n' | 'e' | 's' | 'w'; at: number }, h = 2.4): void {
    const wall = (ax: number, az: number, bx: number, bz: number) => {
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.05) return;
      const rot = -Math.atan2(bz - az, bx - ax);
      const g = new THREE.Mesh(new THREE.BoxGeometry(len, h, 0.04), this.glass);
      g.position.set((ax + bx) / 2, h / 2, (az + bz) / 2);
      g.rotation.y = rot;
      this.scene.add(g);
      for (const [yy, hh, dd, col] of [[h, 0.06, 0.08, 0x8e9895], [0.03, 0.06, 0.08, 0x8e9895], [1.1, 0.12, 0.05, 0xe8eef0]] as const) {
        this.box(len, hh, dd, col, (ax + bx) / 2, yy, (az + bz) / 2).rotation.y = rot;
      }
    };
    const sides = [[x1, z1, x2, z1, 'n'], [x2, z1, x2, z2, 'e'], [x2, z2, x1, z2, 's'], [x1, z2, x1, z1, 'w']] as const;
    for (const sd of sides) {
      if (door.side === sd[4]) {
        const half = 0.55;
        if (sd[4] === 'n' || sd[4] === 's') {
          const lo = Math.min(sd[0], sd[2]);
          const hi = Math.max(sd[0], sd[2]);
          wall(lo, sd[1], door.at - half, sd[1]);
          wall(door.at + half, sd[1], hi, sd[1]);
        } else {
          const lo = Math.min(sd[1], sd[3]);
          const hi = Math.max(sd[1], sd[3]);
          wall(sd[0], lo, sd[0], door.at - half);
          wall(sd[0], door.at + half, sd[0], hi);
        }
      } else wall(sd[0], sd[1], sd[2], sd[3]);
      this.box(0.1, h, 0.1, 0x8e9895, sd[0], h / 2, sd[1]);
    }
  }
  /** 서버 랙과 깜빡이는 표시등 (서버실) */
  serverRack(rx: number): void {
    this.box(0.6, 2.2, 4.2, 0x23282a, rx, 1.1, 3.5);
    for (let k = 0; k < 10; k++) {
      const lm = new THREE.MeshStandardMaterial({ color: 0x5bd08d, emissive: 0x3ccb78, emissiveIntensity: 1 });
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.04, 0.08), lm);
      l.position.set(rx + 0.31 * (rx < 28 ? 1 : -1), 0.35 + (k % 5) * 0.4, 1.8 + Math.floor(k / 5) * 2.4 + (k % 3) * 0.3);
      this.scene.add(l);
      this.leds.push(lm);
    }
  }
}
