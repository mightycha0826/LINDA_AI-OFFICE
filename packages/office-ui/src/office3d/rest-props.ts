import * as T from 'three';
import type { RestProfile } from './rest.ts';

export interface RestProps { root: T.Group; cup: T.Group; book: T.Group; steam: T.Group; tint(color: number): void }

/** Held props use the real animated wrist anchors, for both code figures and VRM. */
export function buildRestProps(material: (color: number) => T.Material): RestProps {
  const root = new T.Group(), cup = new T.Group(), book = new T.Group(), steam = new T.Group();
  root.name = 'break-props'; root.add(cup, book); cup.add(steam); root.visible = false;
  const mesh = (parent: T.Object3D, g: T.BufferGeometry, color: number, x = 0, y = 0, z = 0) => {
    const m = new T.Mesh(g, material(color)); m.position.set(x,y,z); m.castShadow = true; parent.add(m); return m;
  };
  const shell = mesh(cup, new T.CylinderGeometry(0.04,0.032,0.075,20,1,true), 0xeee6d8, 0,0.0375,0);
  mesh(cup, new T.CylinderGeometry(0.032,0.032,0.006,20), 0xeee6d8, 0,0.003,0);
  const rim = mesh(cup, new T.TorusGeometry(0.038,0.003,8,20), 0xfaf6ed, 0,0.076,0); rim.rotation.x = Math.PI/2;
  mesh(cup, new T.CylinderGeometry(0.035,0.035,0.003,20), 0x654531, 0,0.069,0);
  const handle = mesh(cup, new T.TorusGeometry(0.021,0.005,7,16), 0xeee6d8, 0.043,0.04,0); handle.rotation.y = Math.PI/2;
  for (let i=0;i<2;i++) {
    const curve = new T.CatmullRomCurve3([new T.Vector3(i*0.018-0.009,0.084,0),new T.Vector3(i*0.018-0.015,0.12,0.004),new T.Vector3(i*0.018,0.155,0)]);
    mesh(steam,new T.TubeGeometry(curve,12,0.0018,4,false),0xd1d9d5);
  }
  for (const side of [-1,1]) {
    const half = new T.Group(); half.rotation.z = -side*0.12; book.add(half);
    mesh(half,new T.BoxGeometry(0.112,0.012,0.14),0x6c8796,side*0.058,0,0);
    mesh(half,new T.BoxGeometry(0.105,0.009,0.132),0xf2ecd9,side*0.058,0.01,0);
    for (let row=0;row<6;row++) mesh(half,new T.BoxGeometry(row%3?0.072:0.05,0.0007,0.002),0x99a2a0,side*0.058,0.015,-0.045+row*0.016);
  }
  return {root,cup,book,steam,tint(color) { shell.material = material(color); handle.material = material(color); }};
}

const point = new T.Vector3(), other = new T.Vector3();
export function updateRestProps(props: RestProps, body: T.Group, anchors: readonly T.Object3D[], profile: RestProfile | undefined, visible: boolean, sip: number, time: number): void {
  props.root.visible = visible && !!profile && (profile.kind === 'coffee' || profile.kind === 'read');
  if (!props.root.visible || !profile) return;
  props.cup.visible = profile.kind === 'coffee'; props.book.visible = profile.kind === 'read';
  body.updateWorldMatrix(true,true);
  const anchor = anchors[profile.side];
  if (props.cup.visible && anchor) {
    anchor.localToWorld(point.set(profile.side ? -0.025 : 0.025,-0.005,0.035));
    body.worldToLocal(point);
    props.cup.position.copy(point);
    props.cup.rotation.set(-sip*0.22, profile.side ? Math.PI : 0, 0);
    props.steam.scale.y = 0.8 + Math.sin(time*1.2)*0.12;
  }
  if (props.book.visible && anchors[0] && anchors[1]) {
    anchors[0].getWorldPosition(point); anchors[1].getWorldPosition(other);
    point.add(other).multiplyScalar(0.5); body.worldToLocal(point);
    props.book.position.copy(point).add(new T.Vector3(0,-0.012,0.055));
    props.book.rotation.x = 0.15;
  }
}

export function disposeRestProps(props: RestProps): void {
  props.root.traverse(node => { if(node instanceof T.Mesh) node.geometry.dispose(); });
}
