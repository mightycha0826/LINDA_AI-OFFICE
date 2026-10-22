// 백서진 reference sculpt. Real geometry for silhouette, nose, hair, spectacles and tailoring.
// The face albedo is an authored character texture; no portrait billboard is used.
import * as T from 'three';
import { mergeBufferGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Figure } from './figure.ts';
import { buildHand, type Hand } from './hands.ts';

type P = readonly [number, number, number];
const v = (p: P) => new T.Vector3(...p);
const mix = T.MathUtils.lerp;

/** Cross sections of the sculpt: y, cheek/jaw width, front depth. */
const FACE: readonly P[] = [
  [-0.225, 0.008, 0.036], [-0.211, 0.043, 0.063], [-0.186, 0.076, 0.088],
  [-0.15, 0.11, 0.111], [-0.105, 0.137, 0.135], [-0.05, 0.156, 0.147],
  [0.015, 0.161, 0.145], [0.075, 0.158, 0.136], [0.135, 0.147, 0.119],
  [0.19, 0.114, 0.086], [0.225, 0.066, 0.045], [0.242, 0.001, 0.001],
];
function section(y: number): [number, number] {
  for (let i = 1; i < FACE.length; i++) {
    const a = FACE[i - 1]!, b = FACE[i]!;
    if (y <= b[0]) {
      const t = T.MathUtils.clamp((y - a[0]) / (b[0] - a[0]), 0, 1);
      const prev = FACE[Math.max(0,i-2)]!, next = FACE[Math.min(FACE.length-1,i+1)]!;
      const h=b[0]-a[0];
      const interp=(k:1|2)=>{
        const ma=(b[k]-prev[k])/(b[0]-prev[0]), mb=(next[k]-a[k])/(next[0]-a[0]);
        return Math.max(0.001,(2*t**3-3*t*t+1)*a[k]+(t**3-2*t*t+t)*h*ma+(-2*t**3+3*t*t)*b[k]+(t**3-t*t)*h*mb);
      };
      return [interp(1),interp(2)];
    }
  }
  return [0.001, 0.001];
}
const gauss = (x: number, mid: number, width: number) => Math.exp(-(((x - mid) / width) ** 2));

function faceGeometry(): T.BufferGeometry {
  const positions: number[] = [], uv: number[] = [], front: number[] = [], back: number[] = [];
  const rows = 90, cols = 128;
  const g = new T.BufferGeometry();
  for (let r = 0; r <= rows; r++) {
    const y = mix(-0.225, 0.242, r / rows);
    const [w, d] = section(y);
    for (let c = 0; c <= cols; c++) {
      const a = -Math.PI + c / cols * Math.PI * 2;
      const x = w * Math.sin(a), f = Math.cos(a);
      let z = f >= 0 ? d * Math.pow(f, 0.52) : d * f * 0.95;
      if (f > 0) {
        // Bridge, tip, philtrum, mouth plane, cheek cushions and eye sockets.
        z += gauss(x, 0, 0.017) * (0.013 * gauss(y, -0.003, 0.067) + 0.019 * gauss(y, -0.047, 0.021));
        z += 0.006 * gauss(x, 0, 0.041) * gauss(y, -0.12, 0.025);
        z -= 0.007 * (gauss(x, 0.067, 0.038) + gauss(x, -0.067, 0.038)) * gauss(y, 0.044, 0.026);
        z += 0.004 * (gauss(x, 0.088, 0.03) + gauss(x, -0.088, 0.03)) * gauss(y, -0.044, 0.04);
      }
      positions.push(x, y, z);
      // Planar frontal UVs keep eye widths and mouth placement independent of the jaw taper.
      uv.push(0.5 + x / 0.34, (y + 0.225) / 0.44);
      if (r < rows && c < cols) {
        const n = r * (cols + 1) + c;
        const indices = Math.cos(a + Math.PI / cols) > 0.15 ? front : back;
        indices.push(n, n + 1, n + cols + 1, n + 1, n + cols + 2, n + cols + 1);
      }
    }
  }
  g.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
  g.setIndex([...front,...back]); g.computeVertexNormals();
  g.addGroup(0,front.length,0); g.addGroup(front.length,back.length,1);
  return g;
}

/** A soft lenticular hair lock, tapered along a spline. */
function lock(points: P[], width: number, thickness = 0.008, tip = 0.03, flatFront = false): T.BufferGeometry {
  const curve = new T.CatmullRomCurve3(points.map(v));
  const p: number[] = [], uv: number[] = [], ix: number[] = [];
  const rows = 26, cols = 8;
  for (let i = 0; i <= rows; i++) {
    const t = i / rows, center = curve.getPoint(t), tangent = curve.getTangent(t);
    const outward = new T.Vector3(flatFront ? 0 : center.x, Math.max(0, center.y) * 0.6, center.z).normalize();
    const side = new T.Vector3().crossVectors(tangent, outward).normalize();
    const normal = new T.Vector3().crossVectors(side, tangent).normalize();
    const taper = (0.1 + 0.9 * Math.sin(Math.min(1, t * 3.3) * Math.PI / 2)) * (1 - (1 - tip) * t ** 4);
    for (let j = 0; j <= cols; j++) {
      const a = j / cols * Math.PI * 2;
      const q = center.clone().addScaledVector(side, Math.cos(a) * width * taper / 2).addScaledVector(normal, Math.sin(a) * thickness * taper);
      p.push(q.x, q.y, q.z); uv.push(j / cols, t);
      if (i < rows && j < cols) {
        const n = i * (cols + 1) + j;
        ix.push(n, n + cols + 1, n + 1, n + 1, n + cols + 1, n + cols + 2);
      }
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(p, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
  g.setIndex(ix); g.computeVertexNormals(); return g;
}

function tube(points: P[], radius: number, segments = 32) {
  return new T.TubeGeometry(new T.CatmullRomCurve3(points.map(v)), segments, radius, 8, false);
}

function hairCurtain(): T.BufferGeometry {
  const p:number[]=[],uv:number[]=[],idx:number[]=[];
  const rows=32,cols=72;
  for(let i=0;i<=rows;i++)for(let j=0;j<=cols;j++) {
    const t=i/rows,a=0.81+j/cols*(Math.PI*2-1.62);
    const w=0.178+0.016*Math.sin(t*1.8),d=0.151+0.014*t;
    const y=0.03-t*(0.635+0.02*Math.sin(a*5)+0.012*Math.sin(a*11));
    p.push(Math.sin(a)*w,y,Math.cos(a)*d+0.015*t*t);uv.push(j/cols,1-t);
    if(i<rows&&j<cols){const k=i*(cols+1)+j;idx.push(k,k+cols+1,k+1,k+1,k+cols+1,k+cols+2);}
  }
  const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(p,3));g.setAttribute('uv',new T.Float32BufferAttribute(uv,2));g.setIndex(idx);g.computeVertexNormals();return g;
}

function hairCap():T.BufferGeometry {
  const p:number[]=[],uv:number[]=[],idx:number[]=[];
  const rows=48,cols=96;
  for(let i=0;i<=rows;i++)for(let j=0;j<=cols;j++) {
    const a=-Math.PI+j/cols*Math.PI*2;
    const edge=1.93-0.8*Math.max(0,Math.cos(a))**1.5;
    const theta=i/rows*edge;
    p.push(0.184*Math.sin(theta)*Math.sin(a),0.264*Math.cos(theta)+0.005,0.165*Math.sin(theta)*Math.cos(a)-0.004);
    uv.push(j/cols,1-i/rows);
    if(i<rows&&j<cols){const n=i*(cols+1)+j;idx.push(n,n+cols+1,n+1,n+1,n+cols+1,n+cols+2);}
  }
  const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(p,3));g.setAttribute('uv',new T.Float32BufferAttribute(uv,2));g.setIndex(idx);g.computeVertexNormals();return g;
}

/** Fine longitudinal strand shading, deterministic and seamless horizontally. */
function hairTexture(): T.CanvasTexture {
  const cv=document.createElement('canvas');cv.width=512;cv.height=1024;
  const c=cv.getContext('2d')!;
  const gray=(n:number)=>`rgb(${n},${n},${n})`;
  c.fillStyle=gray(226);c.fillRect(0,0,512,1024);
  for(let i=0;i<180;i++) {
    const x=(i*71.73)%512;
    c.strokeStyle=gray(170+(i*17)%70);c.lineWidth=0.35+(i%4)*0.22;
    c.beginPath();c.moveTo(x,0);c.bezierCurveTo(x+Math.sin(i)*3,300,x-Math.sin(i)*2,700,x,1024);c.stroke();
  }
  const t=new T.CanvasTexture(cv);t.encoding=T.sRGBEncoding;t.anisotropy=4;return t;
}

/** Merge static details by material. Animation pivots remain independent. */
function batch(group: T.Group): void {
  group.updateMatrixWorld(true);
  const groups = new Map<T.Material, T.BufferGeometry[]>();
  const remove: T.Mesh[] = [];
  for (const child of group.children) {
    if (!(child instanceof T.Mesh) || Array.isArray(child.material)) continue;
    child.updateMatrix();
    const g = child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone();
    g.applyMatrix4(child.matrix); g.clearGroups();
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    const bucket = groups.get(child.material) ?? []; bucket.push(g); groups.set(child.material, bucket); remove.push(child);
  }
  for (const child of remove) { group.remove(child); child.geometry.dispose(); }
  for (const [mat, list] of groups) {
    const merged = mergeBufferGeometries(list)!;
    const mesh = new T.Mesh(merged, mat); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh);
    list.forEach(g => g.dispose());
  }
}

export function buildSeojin(): Figure {
  const root = new T.Group(); root.name = 'Baek Seojin / portrait sculpt';
  const materials: T.Material[] = [], textures: T.Texture[] = [];
  const material = (color: number, roughness = 0.65, metalness = 0) => {
    const m = new T.MeshStandardMaterial({color: new T.Color(color).convertSRGBToLinear(), roughness, metalness});
    materials.push(m); return m;
  };
  const skin = material(0xf1d4cb, 0.85);
  const earShade = material(0xdca9a5, 0.9);
  const hair = [material(0x25232b, 0.57), material(0x2c2931, 0.59), material(0x211f27, 0.57), material(0x353039, 0.61)];
  const hairEdge = material(0x38313a, 0.62);
  const hairMap=hairTexture();textures.push(hairMap);for(const m of hair){m.map=hairMap;m.side=T.DoubleSide;}
  const jacket = material(0x262730, 0.86), lapel = material(0x30313b, 0.75), seam = material(0x15161d, 0.85);
  const shirt = material(0xe9e9ef, 0.86), shirtShade = material(0xc7c8d4, 0.85), tie = material(0x282731, 0.65);
  const metal = material(0x39363e, 0.25, 0.6);
  const silver = material(0x9b97a2, 0.3, 0.7);
  const ribbon = material(0x28242e, 0.75);
  const add = (group: T.Object3D, geo: T.BufferGeometry, mat: T.Material, position?: P) => {
    const m = new T.Mesh(geo, mat); if (position) m.position.set(...position);
    m.castShadow = true; m.receiveShadow = true; group.add(m); return m;
  };
  const ellipsoid = (group: T.Object3D, at: P, size: P, mat: T.Material, segs = 32) => {
    const g = new T.SphereGeometry(1, segs, Math.round(segs * 0.75)); g.scale(...size); return add(group, g, mat, at);
  };
  const limb = (group: T.Object3D, a: P, b: P, r1: number, r2: number, mat: T.Material) => {
    const av = v(a), bv = v(b), delta = bv.clone().sub(av);
    const g = new T.CylinderGeometry(r2, r1, delta.length(), 20);
    g.applyQuaternion(new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), delta.normalize()));
    g.translate(...av.add(bv).multiplyScalar(0.5).toArray()); return add(group, g, mat);
  };
  const sheet = (group: T.Object3D, pts: P[], mat: T.Material, thickness = 0.002) => {
    const shape = new T.Shape(); pts.forEach((p, i) => i ? shape.lineTo(p[0], p[1]) : shape.moveTo(p[0], p[1])); shape.closePath();
    let g: T.BufferGeometry = new T.ExtrudeGeometry(shape, {depth:thickness,bevelEnabled:true,bevelSize:0.0015,bevelThickness:0.001,bevelSegments:2,steps:1});
    if(group===upper) {
      // Tessellate before draping: a single large flat triangle would cut through a curved jacket.
      const flat=new T.ShapeGeometry(shape), src=flat.index?flat.toNonIndexed():flat;
      const p=src.attributes.position as T.BufferAttribute;
      const positions:number[]=[], uvs:number[]=[];
      const steps=8;
      for(let n=0;n<p.count;n+=3) {
        const a=new T.Vector3().fromBufferAttribute(p,n),b=new T.Vector3().fromBufferAttribute(p,n+1),c=new T.Vector3().fromBufferAttribute(p,n+2);
        const at=(i:number,j:number)=>a.clone().addScaledVector(b.clone().sub(a),i/steps).addScaledVector(c.clone().sub(a),j/steps);
        const tri=(a:T.Vector3,b:T.Vector3,c:T.Vector3)=>{for(const q of [a,b,c]) {positions.push(q.x,q.y,q.z);uvs.push(q.x,q.y);}};
        for(let i=0;i<steps;i++) for(let j=0;j<steps-i;j++) {tri(at(i,j),at(i+1,j),at(i,j+1));if(i+j<steps-1)tri(at(i+1,j),at(i+1,j+1),at(i,j+1));}
      }
      g.dispose();g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(positions,3));g.setAttribute('uv',new T.Float32BufferAttribute(uvs,2));src.dispose();if(src!==flat)flat.dispose();
    }
    // Tailoring panels can be slightly curved to follow the torso.
    const pos = g.attributes.position as T.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x=pos.getX(i),y=pos.getY(i);
      let depth=pts[0]![2]-Math.abs(x)*0.12;
      if(group===upper) {
        let radius=profile.at(-1)![0]!;
        for(let j=1;j<profile.length;j++) { const a=profile[j-1]!, b=profile[j]!; if(y<=b[1]!) {radius=mix(a[0]!,b[0]!,T.MathUtils.clamp((y-a[1]!)/(b[1]!-a[1]!),0,1));break;} }
        depth=Math.sqrt(Math.max(0,radius*radius-x*x))*0.62-0.025+(mat===tie?0.023:mat===shirt?0.012:mat===skin?0.014:0.017);
        if(mat===skin&&y>1.065) {
          const neckDepth=Math.sqrt(Math.max(0,0.049**2-x*x))-0.019;
          depth=mix(depth,neckDepth,T.MathUtils.clamp((y-1.065)/0.04,0,1));
        }
      }
      pos.setZ(i,pos.getZ(i)+depth);
    }
    g.computeVertexNormals(); return add(group, g, mat);
  };

  // Seated body, with proportions compatible with the office desk and existing animation pivots.
  const lower = new T.Group(); root.add(lower);
  const stockings = material(0x34303c, 0.86), shoes = material(0x17171e, 0.35);
  for (const s of [-1, 1]) {
    limb(lower, [s * 0.076, 0.08, 0.4], [s * 0.076, 0.56, 0.38], 0.029, 0.042, stockings);
    ellipsoid(lower, [s * 0.076, 0.055, 0.445], [0.038, 0.035, 0.088], shoes);
    limb(lower, [s * 0.076, 0.57, 0], [s * 0.076, 0.56, 0.34], 0.08, 0.058, jacket);
  }
  ellipsoid(lower, [0, 0.575, 0.12], [0.168, 0.085, 0.23], jacket); batch(lower);

  const upper = new T.Group(); root.add(upper);
  const profile = [[0.143,0.6],[0.148,0.65],[0.125,0.75],[0.137,0.85],[0.176,0.98],[0.18,1.025],[0.13,1.065],[0.058,1.1]];
  const torso = new T.LatheGeometry(profile.slice(0,-1).map(([r,y]) => new T.Vector2(r!,y!)), 64);
  torso.scale(1,1,0.62); torso.translate(0,0,-0.025); add(upper,torso,jacket);
  limb(upper,[0,1.015,-0.025],[0,1.185,-0.015],0.056,0.045,skin);
  // Open white collar and a relaxed dark tie, as in the reference.
  sheet(upper,[[-0.043,1.13,0.08],[0.043,1.13,0],[0.064,1.055,0],[0.041,1.015,0],[0,0.959,0],[-0.041,1.015,0],[-0.064,1.055,0]],skin);
  sheet(upper,[[-0.084,1.067,0.073],[-0.106,0.98,0],[-0.054,0.73,0],[0.048,0.73,0],[0.104,0.98,0],[0.079,1.067,0],[0.041,1.013,0],[0,0.952,0],[-0.041,1.013,0]],shirt);
  sheet(upper,[[-0.081,1.077,0.087],[-0.11,0.988,0],[-0.071,0.952,0],[-0.037,1.025,0]],shirt);
  sheet(upper,[[0.079,1.077,0.087],[0.037,1.025,0],[0.069,0.956,0],[0.106,0.989,0]],shirt);
  for (const s of [-1,1]) {
    sheet(upper,[[s*0.09,1.055,0.079],[s*0.183,1.012,0],[s*0.137,0.96,0],[s*0.151,0.945,0],[s*0.052,0.779,0],[s*0.079,0.951,0]],lapel);
    add(upper,tube([[s*0.158,1.004,0.063],[s*0.112,0.956,0.07],[s*0.132,0.941,0.066],[s*0.049,0.79,0.081]],0.0012),seam);
    add(upper,tube([[s*0.044,1.022,0.09],[s*0.028,0.972,0.094],[s*0.014,0.945,0.095]],0.009),tie);
    add(upper,tube([[s*0.083,0.965,0.085],[s*0.062,0.86,0.084],[s*0.048,0.76,0.086]],0.0013),shirtShade);
    limb(upper,[s*0.174,1.005,-0.025],[s*0.215,0.79,0.09],0.047,0.037,jacket);
    ellipsoid(upper,[s*0.173,1.0,-0.025],[0.05,0.043,0.048],jacket);
    ellipsoid(upper,[s*0.215,0.79,0.09],[0.038,0.038,0.038],jacket,20);
  }
  sheet(upper,[[-0.025,0.957,0.105],[-0.019,0.922,0],[0,0.908,0],[0.019,0.922,0],[0.026,0.957,0]],tie,0.007);
  sheet(upper,[[-0.012,0.916,0.102],[-0.028,0.76,0],[0,0.73,0],[0.029,0.76,0],[0.012,0.916,0]],tie,0.004);
  add(upper,tube([[0.002,0.912,0.113],[-0.004,0.85,0.107],[0.002,0.748,0.107]],0.001),lapel);
  ellipsoid(upper,[0.023,0.722,0.082],[0.008,0.008,0.003],seam,12);
  batch(upper);
  const forearms: T.Group[] = [];
  const hands: Hand[] = [];
  for (const s of [-1,1]) {
    const arm = new T.Group(); arm.position.set(s*0.215,0.79,0.09); arm.rotation.y=-s*0.22; root.add(arm);
    limb(arm,[0,0,0],[0,0.097,0.29],0.038,0.027,jacket);
    limb(arm,[0,0.097,0.285],[0,0.1,0.31],0.028,0.027,shirt);
    const hand=buildHand(s,skin,shirt);
    hand.root.position.set(0,0.1,0.312); arm.add(hand.root); hands.push(hand);
    batch(arm); forearms.push(arm);
  }

  const head = new T.Group(); head.position.set(0,1.315,-0.015); head.scale.setScalar(0.85); root.add(head);
  const faceMap = new T.TextureLoader().load('/assets/models/seojin/face-albedo.png');
  faceMap.encoding=T.sRGBEncoding; faceMap.anisotropy=8; textures.push(faceMap);
  const faceMat = new T.MeshStandardMaterial({map:faceMap,roughness:0.87,metalness:0,emissive:0xffffff,emissiveMap:faceMap,emissiveIntensity:0.08});
  materials.push(faceMat);
  const face = new T.Mesh(faceGeometry(),[faceMat,skin]); face.name='Sculpted face'; face.castShadow=true; head.add(face);
  for(const s of [-1,1]) {
    ellipsoid(head,[s*0.16,-0.025,-0.005],[0.023,0.048,0.025],skin,24);
    ellipsoid(head,[s*0.176,-0.026,0.01],[0.008,0.032,0.014],earShade,20);
    add(head,tube([[s*0.17,0.012,0.018],[s*0.18,0.0,0.024],[s*0.18,-0.03,0.025],[s*0.168,-0.055,0.017]],0.004),skin);
  }

  // Scalp follows the cranium. The front opening is a hairline, not a straight helmet brim.
  add(head,hairCap(),hair[0]!);
  // Closed back surface prevents gaps at oblique angles; locks soften its silhouette.
  add(head,hairCurtain(),hair[0]!);
  for(let i=0;i<18;i++) {
    const a=0.92+i/17*(Math.PI*2-1.84), sa=Math.sin(a),ca=Math.cos(a);
    const len=0.57+0.06*Math.sin(i*2.3);
    add(head,lock([[sa*0.135,0.15,ca*0.121],[sa*0.168,0.08,ca*0.151],[sa*0.182,-0.08,ca*0.164],[sa*0.19,-0.3,ca*0.174],[sa*0.205,-len,ca*0.16+0.035]],0.055,0.002,0.045),hair[i%3]!);
  }
  // Crown flows from a slightly off-centre part; highlights are narrow raised ribbons.
  for(const s of [-1,1]) for(let i=0;i<12;i++) {
    const a=0.38+i*0.2;
    const pts:P[]=[];
    for(let k=0;k<=12;k++) {const t=0.05+k/12*1.35;pts.push([s*0.185*Math.sin(t)*Math.sin(a),0.266*Math.cos(t)+0.005,0.167*Math.sin(t)*Math.cos(a)-0.004]);}
    add(head,tube(pts,0.00065,24),hair[i%2?1:3]!);
  }
  // Separated, tapered fringe; the asymmetry and gaps reveal the brows and eyes.
  const fringe: {p:P[];w:number}[] = [
    {p:[[-0.012,0.268,0.018],[-0.07,0.212,0.091],[-0.131,0.094,0.133],[-0.151,-0.081,0.099]],w:0.049},
    {p:[[-0.009,0.268,0.025],[-0.054,0.207,0.106],[-0.097,0.116,0.147],[-0.116,0.053,0.149]],w:0.043},
    {p:[[-0.006,0.269,0.026],[-0.03,0.204,0.112],[-0.062,0.123,0.157],[-0.083,0.074,0.166]],w:0.038},
    {p:[[-0.004,0.269,0.027],[-0.014,0.201,0.116],[-0.033,0.126,0.159],[-0.037,0.086,0.169]],w:0.035},
    {p:[[0.002,0.269,0.025],[0.01,0.204,0.113],[0.016,0.119,0.164],[0.033,0.039,0.173]],w:0.043},
    {p:[[0.005,0.269,0.024],[0.033,0.208,0.111],[0.045,0.133,0.156],[0.063,0.074,0.168]],w:0.04},
    {p:[[0.008,0.268,0.019],[0.049,0.211,0.103],[0.075,0.137,0.146],[0.098,0.075,0.155]],w:0.043},
    {p:[[0.011,0.268,0.015],[0.069,0.212,0.092],[0.112,0.113,0.129],[0.139,0.033,0.125]],w:0.043},
    {p:[[0.014,0.266,0.009],[0.088,0.207,0.081],[0.148,0.1,0.101],[0.163,-0.076,0.08]],w:0.044},
  ];
  fringe.forEach((f,i)=>{
    add(head,lock(f.p,f.w,0.0028,0.035,true),hair[i%3]!);
    for(let k=0;k<3;k++) {
      const pts=f.p.map(([x,y,z],j)=>[x+(k-1)*0.007,y-0.001,z+0.003+(j===1?0.001:0)] as P);
      add(head,lock(pts,0.0008,0.00035,0.03,true),i%2?hair[3]!:hairEdge);
    }
  });
  // Face framing locks fall in front of the shoulders, with finer loose hairs.
  for(const s of [-1,1]) for(let i=0;i<5;i++) {
    const x=s*(0.146+i*0.009);
    const pts:P[]=[[s*0.115,0.17,0.103],[x,0.02,0.108-i*0.007],[x+s*0.01,-0.2,0.11],[x+s*0.018,-0.4,0.12],[x-s*0.025,-0.61+i*0.018,0.14]];
    add(head,lock(pts,0.038-i*0.002,0.002,0.03,true),hair[(i+1)%3]!);
    if(i%2===0) add(head,lock(pts.map(([x,y,z])=>[x+s*0.006,y,z+0.003]),0.0008,0.00035,0.03,true),hair[3]!);
  }
  for(const s of [-1,1]) for(let i=0;i<3;i++) {
    add(head,tube([[s*0.146,0.08,0.122],[s*(0.169+i*0.006),-0.08,0.11],[s*(0.139+i*0.01),-0.22-i*0.025,0.12]],0.0007,24),hair[1]!);
  }

  // Thin rounded rectangular metal spectacles. Lenses remain clear at every angle.
  const lens = new T.MeshPhysicalMaterial({color:0xdce5ed,transparent:true,opacity:0.045,roughness:0.1,metalness:0.05,depthWrite:false,side:T.DoubleSide}); materials.push(lens);
  for(const s of [-1,1]) {
    const cx=s*0.071, cy=0.025;
    const points:P[]=[];
    for(let j=0;j<=80;j++) {
      const a=j/80*Math.PI*2;
      const x=0.055*Math.sign(Math.cos(a))*Math.abs(Math.cos(a))**0.6;
      const y=0.034*Math.sign(Math.sin(a))*Math.abs(Math.sin(a))**0.72;
      points.push([cx+x,cy+y,0.17-s*x*0.28]);
    }
    add(head,tube(points,0.00165,80),metal);
    const lp:number[]=[],lu:number[]=[],li:number[]=[];
    lp.push(cx,cy,0.17);lu.push(0.5,0.5);
    points.forEach((p,i)=>{lp.push(...p);lu.push((p[0]-cx)/0.11+0.5,(p[1]-cy)/0.068+0.5);if(i<points.length-1)li.push(0,i+1,i+2);});
    const lg=new T.BufferGeometry();lg.setAttribute('position',new T.Float32BufferAttribute(lp,3));lg.setAttribute('uv',new T.Float32BufferAttribute(lu,2));lg.setIndex(li);lg.computeVertexNormals();add(head,lg,lens);
    add(head,tube([[s*0.126,0.038,0.153],[s*0.153,0.045,0.12],[s*0.177,0.043,0.035],[s*0.179,0.012,-0.02]],0.0017),metal);
    ellipsoid(head,[s*0.13,0.04,0.153],[0.004,0.003,0.002],silver,12);
    ellipsoid(head,[s*0.017,0.015,0.172],[0.003,0.007,0.002],silver,12);
  }
  add(head,tube([[-0.017,0.036,0.177],[-0.009,0.045,0.183],[0.009,0.045,0.183],[0.017,0.036,0.177]],0.0016),metal);

  // Folded satin bow tied behind the character's left ear (right in a front view).
  const bow = new T.Group(); bow.position.set(0.166,-0.052,-0.13); bow.rotation.y=0.55; head.add(bow);
  for(const s of [-1,1]) {
    const shape=new T.Shape();shape.moveTo(0,0);shape.bezierCurveTo(s*0.035,0.025,s*0.074,0.067,s*0.076,0.035);shape.bezierCurveTo(s*0.09,0.003,s*0.072,-0.042,s*0.042,-0.025);shape.lineTo(0,-0.01);
    const g=new T.ExtrudeGeometry(shape,{depth:0.007,bevelEnabled:true,bevelSize:0.003,bevelThickness:0.003,bevelSegments:3,steps:1});add(bow,g,ribbon);
    sheet(bow,[[s*0.015,-0.007,0],[s*0.059,-0.115,0],[s*0.02,-0.101,0],[s*0.009,-0.133,0],[-s*0.008,-0.016,0]],ribbon,0.004);
    add(bow,tube([[0,-0.004,0.012],[s*0.038,0.017,0.014],[s*0.068,0.025,0.009]],0.001),hair[3]!);
  }
  ellipsoid(bow,[0,-0.004,0.007],[0.014,0.02,0.012],ribbon,20); batch(bow);
  batch(head);
  let disposed=false;
  root.userData.disposeMaterials=()=>{if(disposed)return;disposed=true;materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());};
  return {root,head,torso:upper,forearms,hands,top:1.55};
}
