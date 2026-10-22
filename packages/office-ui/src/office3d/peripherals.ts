import * as T from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeBufferGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type Materials = (color: number) => T.Material;
const KEY_ROWS: readonly (readonly number[])[] = [
  [1,1,1,1,1,1,1,1,1,1,1,1,2,1],
  [1.5,1,1,1,1,1,1,1,1,1,1,1,1.5,1],
  [1.75,1,1,1,1,1,1,1,1,1,1,2.25,1],
  [2.25,1,1,1,1,1,1,1,1,1,1.75,1,1],
  [1.25,1.25,1.25,5.75,1,1,1,1,1,1.5],
];

/** One shared transparent print layer for every keyboard in the office. */
export function createKeyboardLegends(): T.MeshStandardMaterial {
  const canvas = document.createElement('canvas'); canvas.width = 1536; canvas.height = 576;
  const c = canvas.getContext('2d')!;
  const labels = [
    ['Esc','1','2','3','4','5','6','7','8','9','0','−','Back','Del'],
    ['Tab','Q','W','E','R','T','Y','U','I','O','P','[',']','PgUp'],
    ['Caps','A','S','D','F','G','H','J','K','L',';','Enter','PgDn'],
    ['Shift','Z','X','C','V','B','N','M',',','.','Shift','↑','End'],
    ['Ctrl','Win','Alt','','Alt','Fn','←','↓','→','Ctrl'],
  ];
  KEY_ROWS.forEach((row, r) => {
    const unit = 0.435 / row.reduce((sum, u) => sum + u, 0);
    let cursor = -0.213;
    row.forEach((u, i) => {
      const x = cursor + unit * u / 2, z = 0.059 - r * 0.029;
      c.save();
      c.translate((0.5 + x / 0.46) * canvas.width, (0.5 + z / 0.171) * canvas.height);
      c.rotate(Math.PI);
      c.fillStyle = '#' + (0x344448).toString(16); c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = `${u > 1 ? 17 : 23}px sans-serif`;
      c.fillText(labels[r]![i] ?? '', 0, 0);
      c.restore(); cursor += u * unit;
    });
  });
  const texture = new T.CanvasTexture(canvas); texture.anisotropy = 4; texture.encoding = T.sRGBEncoding;
  return new T.MeshStandardMaterial({ map: texture, transparent: true, depthWrite: false, roughness: 0.85 });
}

/** Static details share a material batch, so individual keys do not add draw calls. */
class Details {
  private parts = new Map<T.Material, T.BufferGeometry[]>();
  private material: Materials;
  constructor(material: Materials) { this.material = material; }
  add(color: number, g: T.BufferGeometry, x = 0, y = 0, z = 0): void {
    g.translate(x, y, z);
    const m = this.material(color);
    const list = this.parts.get(m) ?? [];
    list.push(g.index ? g.toNonIndexed() : g);
    if (g.index) g.dispose();
    this.parts.set(m, list);
  }
  box(color: number, w: number, h: number, d: number, x: number, y: number, z: number, radius = 0.003): void {
    this.add(color, new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, h / 2, w / 2, d / 2)), x, y, z);
  }
  finish(name: string): T.Group {
    const group = new T.Group(); group.name = name;
    for (const [m, geometries] of this.parts) {
      const mesh = new T.Mesh(mergeBufferGeometries(geometries)!, m);
      mesh.castShadow = true; mesh.receiveShadow = true;
      group.add(mesh);
      geometries.forEach(g => g.dispose());
    }
    return group;
  }
}

/** Compact 65% keyboard, +z away from the seated user. Bottom sits on y=0. */
export function buildKeyboard(material: Materials, legends?: T.Material): T.Group {
  const b = new Details(material);
  b.box(0x394347, 0.46, 0.013, 0.171, 0, 0.0065, 0, 0.006);
  b.box(0xd4d9d7, 0.455, 0.012, 0.165, 0, 0.017, 0, 0.005);
  b.box(0x3e484c, 0.438, 0.003, 0.146, 0, 0.024, 0, 0.001);
  const left = -0.213;
  KEY_ROWS.forEach((row, r) => {
    const unit = 0.435 / row.reduce((sum, u) => sum + u, 0);
    let cursor = left;
    row.forEach((u, c) => {
      const w = unit * u - 0.0035, x = cursor + unit * u / 2, z = 0.059 - r * 0.029;
      const accent = (r === 0 && c === 0) || (r === 2 && u > 2);
      b.box(accent ? 0x648e8d : u > 1.2 ? 0xaebcbd : 0xeff0e8, w, 0.011, 0.025, x, 0.031 + r * 0.0006, z, 0.003);
      // Small inset legends; homing bars distinguish F/J without a separate texture per desk.
      if (!legends && u < 3) b.box(0x536265, 0.005, 0.0007, 0.0014, x - w * 0.2, 0.037 + r * 0.0006, z - 0.005, 0.0003);
      if (r === 2 && (c === 4 || c === 7)) b.box(0x536265, 0.008, 0.0009, 0.0012, x, 0.0378 + r * 0.0006, z - 0.008, 0.0002);
      cursor += unit * u;
    });
  });
  for (let i = 0; i < 3; i++) b.box(i === 0 ? 0x76c7ae : 0x7a8988, 0.006, 0.001, 0.002, 0.16 + i * 0.015, 0.024, 0.078, 0.0005);
  const group = b.finish('keyboard');
  if (legends) {
    const print = new T.Mesh(new T.PlaneGeometry(0.46, 0.171), legends);
    print.rotation.x = -Math.PI / 2; print.position.y = 0.0402; group.add(print);
  }
  return group;
}

export function buildMouse(material: Materials): T.Group {
  const b = new Details(material);
  b.box(0x323e43, 0.067, 0.008, 0.108, 0, 0.004, 0, 0.004);
  const shell = new T.SphereGeometry(1, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  shell.scale(0.035, 0.032, 0.058);
  b.add(0xdce1dc, shell, 0, 0.007, 0);
  // Separate sculpted buttons, a dark wheel channel and ribbed rubber scroll wheel.
  for (const side of [-1, 1]) b.box(0xe9ece7, 0.028, 0.006, 0.042, side * 0.0165, 0.030, 0.024, 0.003);
  b.box(0x364349, 0.009, 0.003, 0.033, 0, 0.0335, 0.025, 0.001);
  const wheel = new T.CylinderGeometry(0.011, 0.011, 0.007, 20);
  wheel.rotateZ(Math.PI / 2);
  b.add(0x647778, wheel, 0, 0.034, 0.023);
  for (let i = 0; i < 6; i++) b.box(0x253438, 0.008, 0.0008, 0.001, 0, 0.0444 - Math.abs(i - 2.5) * 0.0006, 0.016 + i * 0.0026, 0.0003);
  for (let i = 0; i < 2; i++) b.box(0x7c8e8e, 0.002, 0.005, 0.016, -0.034, 0.018, -0.006 + i * 0.019, 0.001);
  b.box(0x8aaba5, 0.011, 0.001, 0.003, 0, 0.035, -0.018, 0.001);
  return b.finish('mouse');
}
