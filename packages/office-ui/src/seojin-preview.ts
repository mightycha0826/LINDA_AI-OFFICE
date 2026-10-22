// Local reference studio: the same figure factory used by the office scene.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildFigure, disposeFigure, FigureKit } from './office3d/figure.ts';
import { lookOf } from './office3d/characters.ts';
import { animateHand } from './office3d/hands.ts';
import { buildKeyboard, buildMouse, createKeyboardLegends } from './office3d/peripherals.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#model')!;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe8e9ee);
const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 30);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(0, 1.26, 0);
controls.minDistance = 0.35;
controls.maxDistance = 5;
scene.add(new THREE.HemisphereLight(0xffffff, 0x727483, 0.65));
const key = new THREE.DirectionalLight(0xfff5ef, 0.8);
key.position.set(-2, 3, 4); scene.add(key);
const fill = new THREE.DirectionalLight(0xcddcff, 0.28);
fill.position.set(3, 1, 2); scene.add(fill);
const rim = new THREE.DirectionalLight(0xf4e2dc, 0.55);
rim.position.set(1, 3, -2); scene.add(rim);
const kit = new FigureKit();
let legacy = false;
let fig = buildFigure(lookOf('chief-of-staff'), kit);
scene.add(fig.root);
const desk = new THREE.Group(); desk.visible = false; scene.add(desk);
const mat = new Map<number, THREE.MeshStandardMaterial>();
const material = (color: number) => { if (!mat.has(color)) mat.set(color, new THREE.MeshStandardMaterial({color, roughness:0.8})); return mat.get(color)!; };
const board = buildKeyboard(material, createKeyboardLegends()); board.position.set(0,0.812,0.53); desk.add(board);
const mouse = buildMouse(material); mouse.position.set(-0.34,0.817,0.535); desk.add(mouse);
const pad = new THREE.Mesh(new THREE.BoxGeometry(0.23,0.005,0.2),material(0x344848)); pad.position.set(-0.34,0.813,0.53); desk.add(pad);
const surface = new THREE.Mesh(new THREE.BoxGeometry(1.2,0.04,0.65),material(0xd3c3a8)); surface.position.set(0,0.79,0.65); desk.add(surface);
const detailButton = document.createElement('button'); detailButton.textContent = '손 · 키보드 · 마우스';
document.querySelector('.toolbar')!.append(detailButton);
detailButton.onclick = () => { desk.visible = true; controls.target.set(-0.12,0.86,0.53); camera.position.set(-0.85,1.5,0.1); controls.update(); };
let angle = 0;
let close = true;
let animate = false;
function frameCamera() {
  const rad = angle * Math.PI / 180;
  const d = close ? 1.55 : 3.25;
  controls.target.set(0, close ? 1.26 : 0.8, 0);
  camera.position.set(Math.sin(rad) * d, close ? 1.29 : 1.1, Math.cos(rad) * d);
  controls.update();
}
frameCamera();
document.querySelectorAll<HTMLButtonElement>('[data-angle]').forEach(b => b.onclick = () => { angle = Number(b.dataset.angle); frameCamera(); });
document.querySelector<HTMLButtonElement>('#portrait')!.onclick = () => { close = true; frameCamera(); };
document.querySelector<HTMLButtonElement>('#body')!.onclick = () => { close = false; frameCamera(); };
document.querySelector<HTMLButtonElement>('#animate')!.onclick = (e) => { animate = !animate; (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(animate)); };
document.querySelector<HTMLButtonElement>('#legacy')!.onclick = (e) => {
  legacy = !legacy;
  (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(legacy));
  scene.remove(fig.root); disposeFigure(fig.root);
  const look = lookOf('chief-of-staff');
  const { portraitModel: _model, ...oldLook } = look;
  fig = buildFigure(legacy ? oldLook : look, kit);
  scene.add(fig.root);
};
const resize = new ResizeObserver(() => {
  const { width, height } = canvas.parentElement!.getBoundingClientRect();
  renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix();
});
resize.observe(canvas.parentElement!);
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const t = clock.getElapsedTime();
  fig.head.rotation.y = animate ? Math.sin(t * 0.55) * 0.16 : 0;
  fig.head.rotation.x = animate ? Math.sin(t * 0.7) * 0.025 : 0;
  fig.forearms.forEach((a, i) => a.rotation.x = animate ? Math.sin(t * 7 + i * 2) * 0.012 : 0);
  fig.hands.forEach((hand, i) => animateHand(hand, animate ? 'type' : 'idle', t, i * 2.3, animate ? 1 : 0));
  controls.update(); renderer.render(scene, camera);
  document.querySelector('#stats')!.textContent = `${legacy ? '이전 모델' : '현재 모델'} · ${renderer.info.render.triangles.toLocaleString()} triangles · ${renderer.info.render.calls} draw calls`;
}
frame();
