// 3D 사무실을 짓는 기본 도구 (12장): 재질, 상자·원기둥 같은 도형, 나무결·바닥 타일·글자 판·모니터 화면.
// 3D 재질(나무·식물·바닥) 색은 포인트 디자인 시스템의 예외다(17장 메모). 화면 글자·패널은 토큰을 쓴다.
// 밤낮에 따라 밝기가 바뀌는 것(모니터 화면, 천장 조명, 서버 표시등)은 여기 모아 두고 setNight·blink로 바꾼다.
import * as THREE from 'three';
import { css } from './util.ts';

export type WoodTone = 'oak' | 'walnut' | 'ash';
export type ScreenKind = 'code' | 'doc' | 'chart' | 'chat';

export class Builder {
  readonly scene: THREE.Scene;
  readonly glass = new THREE.MeshStandardMaterial({ color: 0xbfe0e6, transparent: true, opacity: 0.22, roughness: 0.1, metalness: 0.1, depthWrite: false });
  protected readonly lamps: THREE.PointLight[] = [];
  protected readonly bulbs: THREE.MeshStandardMaterial[] = [];
  protected readonly leds: THREE.MeshStandardMaterial[] = [];
  private readonly mats = new Map<string, THREE.MeshStandardMaterial>();
  private readonly woods = new Map<string, THREE.MeshStandardMaterial>();
  private readonly screens: THREE.MeshStandardMaterial[] = [];
  private readonly redraws: (() => void)[] = [];
  private readonly font: string;

  constructor(scene: THREE.Scene, font: string) {
    this.scene = scene;
    this.font = font;
  }

  /** 밤에는 천장 조명을 켜고 화면을 밝힌다 */
  setNight(on: boolean): void {
    this.lamps.forEach((l) => (l.intensity = on ? 0.9 : 0));
    this.bulbs.forEach((m) => (m.emissiveIntensity = on ? 1.4 : 0.2));
    this.screens.forEach((m) => (m.emissiveIntensity = on ? 1.1 : 0.45));
  }

  /** 서버 표시등 깜빡임. 동작 줄이기(m = 0)면 깜빡임 폭을 반으로 */
  blink(t: number, m: number): void {
    this.leds.forEach((l, i) => (l.emissiveIntensity = 0.4 + (Math.sin(t * (2 + (i % 3)) + i) > 0.3 ? 0.9 : 0) * (m || 0.5)));
  }

  /** 글꼴이 늦게 오면 글자 판을 다시 그린다 */
  redrawText(): void {
    this.redraws.forEach((d) => d());
  }

  mat(color: number, o: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
    const key = `${color}:${JSON.stringify(o)}`;
    let m = this.mats.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.02, ...o });
      this.mats.set(key, m);
    }
    return m;
  }
  protected add(m: THREE.Mesh, x: number, y: number, z: number, parent?: THREE.Object3D, shadow = true): THREE.Mesh {
    m.position.set(x, y, z);
    m.castShadow = shadow;
    m.receiveShadow = true;
    (parent ?? this.scene).add(m);
    return m;
  }
  box(w: number, h: number, d: number, color: number, x: number, y: number, z: number, parent?: THREE.Object3D, o?: THREE.MeshStandardMaterialParameters): THREE.Mesh {
    return this.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.mat(color, o)), x, y, z, parent);
  }
  flat(w: number, h: number, d: number, color: number, x: number, y: number, z: number, parent?: THREE.Object3D): THREE.Mesh {
    return this.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.mat(color)), x, y, z, parent, false);
  }
  cyl(rt: number, rb: number, h: number, color: number, x: number, y: number, z: number, parent?: THREE.Object3D, seg = 20): THREE.Mesh {
    return this.add(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), this.mat(color)), x, y, z, parent);
  }
  sphere(r: number, color: number, x: number, y: number, z: number, parent?: THREE.Object3D): THREE.Mesh {
    return this.add(new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), this.mat(color)), x, y, z, parent);
  }
  wood(tone: WoodTone): THREE.MeshStandardMaterial {
    let m = this.woods.get(tone);
    if (m) return m;
    const pal = { oak: [0xd2b48a, 0xa9824f, 0xe4cba4], walnut: [0x7a5537, 0x5e3f28, 0x93694a], ash: [0xe2d5be, 0xbda582, 0xefe6d6] }[tone];
    const cv = document.createElement('canvas');
    cv.width = 512;
    cv.height = 128;
    const c = cv.getContext('2d')!;
    c.fillStyle = css(pal[0]!);
    c.fillRect(0, 0, 512, 128);
    for (let i = 0; i < 70; i++) {
      const y = Math.random() * 128;
      const amp = 1 + Math.random() * 3;
      const ph = Math.random() * 6;
      c.strokeStyle = css(Math.random() < 0.5 ? pal[1]! : pal[2]!);
      c.globalAlpha = 0.18 + Math.random() * 0.3;
      c.lineWidth = 0.6 + Math.random() * 1.6;
      c.beginPath();
      for (let x = 0; x <= 512; x += 16) c.lineTo(x, y + Math.sin(x / 60 + ph) * amp);
      c.stroke();
    }
    for (let k = 0; k < 3; k++) {
      const kx = Math.random() * 512;
      const ky = Math.random() * 128;
      c.globalAlpha = 0.35;
      c.strokeStyle = css(pal[1]!);
      for (let r = 2; r < 10; r += 2.5) {
        c.beginPath();
        c.ellipse(kx, ky, r * 2.4, r, 0, 0, 6.28);
        c.stroke();
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = 4;
    m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62, metalness: 0 });
    this.woods.set(tone, m);
    return m;
  }
  woodBox(w: number, h: number, d: number, tone: WoodTone, x: number, y: number, z: number): THREE.Mesh {
    return this.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.wood(tone)), x, y, z);
  }
  roundTop(w: number, d: number, r: number, tone: WoodTone, x: number, y: number, z: number, thick = 0.04): THREE.Mesh {
    const s = new THREE.Shape();
    const hw = w / 2;
    const hd = d / 2;
    s.moveTo(-hw + r, -hd);
    s.lineTo(hw - r, -hd);
    s.quadraticCurveTo(hw, -hd, hw, -hd + r);
    s.lineTo(hw, hd - r);
    s.quadraticCurveTo(hw, hd, hw - r, hd);
    s.lineTo(-hw + r, hd);
    s.quadraticCurveTo(-hw, hd, -hw, hd - r);
    s.lineTo(-hw, -hd + r);
    s.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
    const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.008, bevelSegments: 2 });
    g.rotateX(-Math.PI / 2);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) + hw) / 2.2, (uv.getY(i) + hd) / 1.1);
    return this.add(new THREE.Mesh(g, this.wood(tone)), x, y - thick / 2, z);
  }
  /** 글자 판 (표지판·이름표·로고). 글꼴이 늦게 와도 다시 그린다 */
  textPlane(text: string, sub: string | null, w: number, h: number, bg: number, fg: number, x: number, y: number, z: number, rotY = 0): THREE.Mesh {
    const cv = document.createElement('canvas');
    cv.width = 1024;
    cv.height = Math.round((1024 * h) / w);
    const tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = 4;
    const draw = () => {
      const c = cv.getContext('2d')!;
      c.fillStyle = css(bg);
      c.fillRect(0, 0, cv.width, cv.height);
      c.fillStyle = css(fg);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.font = `700 ${Math.round(cv.height * (sub ? 0.42 : 0.55))}px ${this.font}`;
      c.fillText(text, cv.width / 2, cv.height * (sub ? 0.4 : 0.52));
      if (sub) {
        c.globalAlpha = 0.7;
        c.font = `500 ${Math.round(cv.height * 0.2)}px ${this.font}`;
        c.fillText(sub, cv.width / 2, cv.height * 0.78);
        c.globalAlpha = 1;
      }
      tex.needsUpdate = true;
    };
    draw();
    this.redraws.push(draw);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }));
    m.position.set(x, y, z);
    m.rotation.y = rotY;
    this.scene.add(m);
    return m;
  }
  tiles(x1: number, z1: number, x2: number, z2: number, base: number, line: number, size = 1): void {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const c = cv.getContext('2d')!;
    c.fillStyle = css(base);
    c.fillRect(0, 0, 128, 128);
    c.strokeStyle = css(line);
    c.lineWidth = 2;
    c.strokeRect(1, 1, 126, 126);
    c.globalAlpha = 0.08;
    c.fillStyle = css(line);
    for (let i = 0; i < 260; i++) c.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
    const tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const w = x2 - x1;
    const d = z2 - z1;
    tex.repeat.set(w / size, d / size);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x1 + w / 2, 0.012, z1 + d / 2);
    m.receiveShadow = true;
    this.scene.add(m);
  }
  screenMat(kind: ScreenKind | null, color = 0x9bb8d6): THREE.MeshStandardMaterial {
    let m: THREE.MeshStandardMaterial;
    if (kind) {
      const cv = document.createElement('canvas');
      cv.width = 256;
      cv.height = 150;
      const c = cv.getContext('2d')!;
      const dark = kind === 'code';
      c.fillStyle = css(dark ? 0x1e2430 : 0xf7f8fa);
      c.fillRect(0, 0, 256, 150);
      c.fillStyle = css(dark ? 0x2a3242 : 0xe3e8ef);
      c.fillRect(0, 0, 256, 12);
      c.fillRect(0, 12, 40, 138);
      if (kind === 'chart') {
        for (let b = 0; b < 7; b++) {
          c.fillStyle = css(b % 2 ? 0x5ba88a : 0x3e7bd6);
          const bh = 20 + ((b * 37) % 70);
          c.fillRect(56 + b * 26, 135 - bh, 16, bh);
        }
      } else if (kind === 'chat') {
        for (let i = 0; i < 6; i++) {
          c.fillStyle = css(i % 2 ? 0xdcebe3 : 0xe6eaf3);
          const mw = 70 + ((i * 29) % 90);
          c.fillRect(i % 2 ? 236 - mw : 52, 20 + i * 21, mw, 14);
        }
      } else {
        const cols = dark ? [0x7fb2f0, 0xc59bf0, 0x9bd49b, 0xe8c27a, 0xb8c2d0] : [0x9aa6b5, 0xc2cad4];
        for (let l = 0; l < 12; l++) {
          const x = 48 + (dark ? (l % 4) * 10 : 0);
          c.fillStyle = css(cols[l % cols.length]!);
          c.fillRect(x, 20 + l * 10, Math.min(60 + ((l * 53) % 140), 248 - x), 4);
        }
      }
      const tex = new THREE.CanvasTexture(cv);
      tex.encoding = THREE.sRGBEncoding;
      m = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.45, roughness: 0.4 });
    } else m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.45, roughness: 0.4 });
    this.screens.push(m);
    return m;
  }
}
