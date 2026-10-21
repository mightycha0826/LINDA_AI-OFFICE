// 3D 캐릭터 VRM 모델 (13장 3D 캐릭터). assets/models/<직원 ID>.vrm이 있을 때만 이 모듈을 불러온다(three-vrm은 크다).
// 모델을 의자에 앉히고 몸짓(타이핑·손짓·대기)·눈 깜빡임·스프링 본(머리카락·치마 흔들림)을 돌린다.
// 뼈는 축 규칙(VRM 0.x·1.0)에 기대지 않고 "자식 뼈가 원하는 방향을 가리키게" 돌린다. 좌표는 figure.ts와 같은 자리 기준.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm';
import type { Act } from './layout.ts';

const V3 = THREE.Vector3;
type V3 = THREE.Vector3;

/** 서 있을 때 키 (사무실 단위, 코드 인형과 비슷한 크기) */
export const STAND_HEIGHT = 1.9;
/** 앉았을 때 골반 높이·앞뒤 (의자 좌석 윗면 0.485) */
const HIPS = new V3(0, 0.6, -0.03);
/** 타이핑할 때 손이 놓이는 곳 (책상 윗면 0.81, 앞 모서리 z 0.3) */
const HAND = { x: 0.16, y: 0.85, z: 0.42 };

export interface Avatar {
  /** 자리 기준 몸 전체 */
  root: THREE.Group;
  /** 정수리 높이 (이름표 기준) */
  top: number;
  animate(act: Act, t: number, phase: number, motion: number, dt: number): void;
  dispose(): void;
}

interface Joint {
  node: THREE.Object3D;
  base: THREE.Quaternion;
  /** 부모 공간에서 본 자리 기준 x축(끄덕임)·y축(돌림) */
  ax: V3;
  ay: V3;
}

export async function loadAvatar(url: string): Promise<Avatar> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error(`VRM이 아니에요: ${url}`);
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = false;
      // 뼈로 움직이는 메시는 경계 상자가 맞지 않아 잘려 보이지 않게 한다
      o.frustumCulled = false;
    }
  });

  const root = new THREE.Group();
  const holder = new THREE.Group();
  holder.add(vrm.scene);
  root.add(holder);
  const bone = (name: VRMHumanBoneName) => vrm.humanoid.getNormalizedBoneNode(name);
  const need = (name: VRMHumanBoneName) => {
    const b = bone(name);
    if (!b) throw new Error(`VRM에 ${name} 뼈가 없어요: ${url}`);
    return b;
  };
  const at = (o: THREE.Object3D) => o.getWorldPosition(new V3());

  // 1) 키를 맞춘다 (서 있는 기본 자세 기준)
  root.updateMatrixWorld(true);
  const rest = new THREE.Box3().setFromObject(vrm.scene);
  holder.scale.setScalar(STAND_HEIGHT / Math.max(0.1, rest.max.y - rest.min.y));
  root.updateMatrixWorld(true);
  const crown = new THREE.Box3().setFromObject(vrm.scene).max.y - at(need('head')).y;

  // 2) 골반을 의자 위로
  holder.position.add(HIPS.clone().sub(at(need('hips'))));
  root.updateMatrixWorld(true);

  // 3) 다리: 허벅지는 앞으로, 정강이는 아래로
  for (const s of ['left', 'right'] as const) {
    const up = need(`${s}UpperLeg`);
    const low = need(`${s}LowerLeg`);
    const foot = need(`${s}Foot`);
    const out = Math.sign(at(up).x) * 0.06;
    aim(root, up, low, new V3(out, -0.12, 1));
    aim(root, low, foot, new V3(0, -1, 0.06));
    const toes = bone(`${s}Toes`);
    if (toes) aim(root, foot, toes, new V3(0, -0.25, 1));
  }
  // 4) 허리를 조금 앞으로
  const spine = need('spine');
  const chest = bone('chest') ?? bone('upperChest') ?? bone('neck') ?? need('head');
  aim(root, spine, chest, new V3(0, 1, 0.06));
  // 5) 팔: 윗팔은 아래·조금 앞으로, 아래팔은 책상 위 손자리로, 손은 앞으로
  for (const s of ['left', 'right'] as const) {
    const up = need(`${s}UpperArm`);
    const low = need(`${s}LowerArm`);
    const hand = need(`${s}Hand`);
    const side = Math.sign(at(up).x) || (s === 'left' ? 1 : -1);
    aim(root, up, low, new V3(side * 0.14, -0.9, 0.34));
    aim(root, low, hand, new V3(side * HAND.x, HAND.y, HAND.z).sub(at(low)));
    const finger = bone(`${s}MiddleProximal`);
    if (finger) aim(root, hand, finger, new V3(-side * 0.15, -0.2, 1));
  }
  root.updateMatrixWorld(true);
  vrm.springBoneManager?.reset();

  // 목은 VRM에서 선택 뼈라 없을 수 있다
  const neckBone = bone('neck');
  const joints = {
    head: joint(root, need('head')),
    neck: neckBone ? joint(root, neckBone) : null,
    chest: joint(root, chest),
    arms: (['left', 'right'] as const).map((s) => joint(root, need(`${s}LowerArm`))),
  };
  const top = at(need('head')).y + crown;
  const blinkEvery = 3.6 + Math.random() * 1.6;

  return {
    root,
    top,
    animate(act, t, phase, m, dt) {
      const { head, neck, chest: ch, arms } = joints;
      if (act === 'type') {
        arms.forEach((j, i) => turn(j, Math.sin(t * 14 + phase + i * 1.7) * 0.06 * m, 0));
        turn(head, 0.08, Math.sin(t * 0.35 + phase) * 0.1 * m);
        turn(ch, 0, 0);
      } else if (act === 'talk') {
        turn(arms[0]!, 0, 0);
        turn(arms[1]!, (-0.6 + Math.sin(t * 2.2 + phase) * 0.35) * m, 0);
        turn(head, 0, Math.sin(t * 0.8 + phase) * 0.35 * m);
        turn(ch, 0, 0);
      } else {
        arms.forEach((j) => turn(j, 0, 0));
        turn(head, 0, Math.sin(t * 0.25 + phase) * 0.45 * m);
        turn(ch, 0, Math.sin(t * 0.25 + phase) * 0.06 * m);
      }
      if (neck) turn(neck, 0, 0);
      const em = vrm.expressionManager;
      if (em) {
        const k = (t + phase * 3) % blinkEvery;
        em.setValue('blink', m && k < 0.14 ? Math.sin((k / 0.14) * Math.PI) : 0);
        em.setValue('happy', act === 'talk' ? 0.35 : 0);
      }
      vrm.update(dt);
    },
    dispose() {
      VRMUtils.deepDispose(vrm.scene);
    },
  };
}

/** bone을 돌려 child가 dir(자리 기준) 쪽에 오게 한다. root는 아직 장면 밖이라 root 공간 = 월드 */
function aim(root: THREE.Object3D, bone: THREE.Object3D, child: THREE.Object3D, dir: V3): void {
  root.updateMatrixWorld(true);
  const from = child.getWorldPosition(new V3()).sub(bone.getWorldPosition(new V3()));
  if (from.lengthSq() < 1e-10 || dir.lengthSq() < 1e-10) return;
  const delta = new THREE.Quaternion().setFromUnitVectors(from.normalize(), dir.clone().normalize());
  const world = bone.getWorldQuaternion(new THREE.Quaternion());
  const parent = bone.parent ? bone.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
  bone.quaternion.copy(parent.invert().multiply(delta.multiply(world)));
}

function joint(root: THREE.Object3D, node: THREE.Object3D): Joint {
  root.updateMatrixWorld(true);
  const inv = node.parent ? node.parent.getWorldQuaternion(new THREE.Quaternion()).invert() : new THREE.Quaternion();
  return { node, base: node.quaternion.clone(), ax: new V3(1, 0, 0).applyQuaternion(inv), ay: new V3(0, 1, 0).applyQuaternion(inv) };
}

const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();
/** 기본 자세에서 끄덕임(pitch, +면 아래)·돌림(yaw)만큼 더 돌린다 */
function turn(j: Joint, pitch: number, yaw: number): void {
  qa.setFromAxisAngle(j.ay, yaw);
  qb.setFromAxisAngle(j.ax, pitch);
  j.node.quaternion.copy(qa.multiply(qb).multiply(j.base));
}
