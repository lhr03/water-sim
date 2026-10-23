import * as THREE from '../lib/build/three.module.js';
import * as CANNON from '../lib/cannon-es.js';
import { makeProbes, filterProbesInside } from './physics.js';

/*
 * 小程序版只做内置物体，不提供外部模型导入。
 *
 * 原因：小程序的沙箱里没有 FileReader / URL / fetch，GLTFLoader 解析 .glb 时
 * 依赖这些接口去取贴图，即使把文件读成 ArrayBuffer 喂给 parse()，贴图那一步也会挂；
 * 更要紧的是 .gltf 往往还要外挂 .bin 和贴图文件，必须做成 zip 才能带进来。
 * 结果是绝大多数模型导入都失败——与其留个坏入口，不如删掉，把体积让给渲染。
 * 删掉三个 loader 后分包少了约 0.3MB。
 */

const PALETTE = ['#FFD966', '#A8DAF5', '#A5D6A7', '#FFAB91', '#CE93D8', '#F48FB1', '#90CAF9', '#FFF59D'];

function pickColor() {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

/* --------------------------- 内置物体 --------------------------- */

/**
 * 造一个「可投放的漂浮体」。
 * @returns {root, shape, volume, probes, size, bounds}
 *   root   要加进场景的 Object3D（位置/朝向跟随刚体）
 *   shape  cannon 碰撞体
 *   volume 真实体积（m³），浮力按它算
 */
export function createPrimitive(type, targetSize = 1.2) {
  const group = new THREE.Group();
  let shape, volume;
  let upright = false;        // 需要自扶正（重心低）的物体

  if (type === 'ball') {
    const r = targetSize * 0.42;
    group.add(new THREE.Mesh(
      new THREE.SphereGeometry(r, 32, 24),
      new THREE.MeshStandardMaterial({ color: pickColor(), roughness: 0.45, metalness: 0.05 }),
    ));
    shape = new CANNON.Sphere(r);
    volume = (4 / 3) * Math.PI * r * r * r;
  } else if (type === 'crate') {
    const s = targetSize * 0.6;
    group.add(new THREE.Mesh(
      new THREE.BoxGeometry(s, s, s),
      new THREE.MeshStandardMaterial({ color: pickColor(), roughness: 0.45, metalness: 0.05 }),
    ));
    shape = new CANNON.Box(new CANNON.Vec3(s / 2, s / 2, s / 2));
    volume = s * s * s;
  } else if (type === 'barrel') {
    const r = targetSize * 0.26, h = targetSize * 0.7;
    group.add(new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, h, 24),
      new THREE.MeshStandardMaterial({ color: pickColor(), roughness: 0.45, metalness: 0.1 }),
    ));
    shape = new CANNON.Cylinder(r, r, h, 12);
    volume = Math.PI * r * r * h;
  } else if (type === 'board') {
    const x = targetSize * 1.1, y = targetSize * 0.1, z = targetSize * 0.42;
    group.add(new THREE.Mesh(
      new THREE.BoxGeometry(x, y, z),
      new THREE.MeshStandardMaterial({ color: pickColor(), roughness: 0.55, metalness: 0.02 }),
    ));
    shape = new CANNON.Box(new CANNON.Vec3(x / 2, y / 2, z / 2));
    volume = x * y * z;
  } else if (type === 'ring') {
    const R = targetSize * 0.4, t = targetSize * 0.11;
    group.add(new THREE.Mesh(
      new THREE.TorusGeometry(R, t, 16, 28),
      new THREE.MeshStandardMaterial({ color: '#FF6B5A', roughness: 0.5, metalness: 0.02 }),
    ));
    shape = new CANNON.Cylinder(R + t, R + t, t * 2, 12);
    volume = 2 * Math.PI * Math.PI * R * t * t;
  } else if (type === 'duck') {
    // 小黄鸭：身体 + 头 + 喙 + 尾巴 + 眼睛。
    // 碰撞体故意只用身体那个扁盒子——用球会滚，鸭子在水里应该是稳稳立着的。
    const r = targetSize * 0.34;
    const ico = (rad, seg = 20) => new THREE.SphereGeometry(rad, seg, Math.max(12, seg - 6));
    const yellow = new THREE.MeshStandardMaterial({ color: '#FFD43B', roughness: 0.55, metalness: 0.02 });
    const orange = new THREE.MeshStandardMaterial({ color: '#FF9F45', roughness: 0.5, metalness: 0.02 });
    const black = new THREE.MeshStandardMaterial({ color: '#2B2B2B', roughness: 0.4, metalness: 0.1 });

    const body = new THREE.Mesh(ico(r), yellow);
    body.scale.set(1, 0.86, 1);
    group.add(body);

    const tail = new THREE.Mesh(new THREE.ConeGeometry(r * 0.34, r * 0.55, 10), yellow);
    tail.position.set(-r * 1.05, r * 0.34, 0);
    tail.rotation.z = Math.PI * 0.42;
    group.add(tail);

    const head = new THREE.Mesh(ico(r * 0.52, 18), yellow);
    head.position.set(r * 0.58, r * 0.76, 0);
    group.add(head);

    // 喙和眼睛要落在头球表面上：位置比头心再远一点，否则会整根埋进头里看不见
    const beak = new THREE.Mesh(new THREE.ConeGeometry(r * 0.19, r * 0.36, 10), orange);
    beak.position.set(r * 1.25, r * 0.62, 0);
    beak.rotation.z = -Math.PI / 2;   // 锥体默认朝 +Y，转成朝 +X
    group.add(beak);

    const eyeDir = new THREE.Vector3(0.55, 0.35, 0.7).normalize();
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(r * 0.085, 10, 8), black);
      eye.position.set(
        head.position.x + eyeDir.x * r * 0.52,
        head.position.y + eyeDir.y * r * 0.52,
        s * eyeDir.z * r * 0.52,
      );
      group.add(eye);
    }

    // 碰撞盒取身体本身的包围盒（不含头和喙）：盒子太小会把探针滤到只剩 8 个，
    // 浮力就变成阶梯式跳变，鸭子会在水面上一顿一顿地抖。
    shape = new CANNON.Box(new CANNON.Vec3(r, r * 0.86, r));
    volume = 0.55 * (r * 2) * (r * 1.72) * (r * 2);
    upright = true;
  } else if (type === 'gem') {
    // 多面体：碰撞用球，所以会滚——这是它好玩的地方
    const r = targetSize * 0.42;
    const mat = new THREE.MeshStandardMaterial({
      color: pickColor(), roughness: 0.12, metalness: 0.55, flatShading: true,
    });
    group.add(new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), mat));
    shape = new CANNON.Sphere(r * 0.94);
    volume = 0.62 * (4 / 3) * Math.PI * r * r * r;
  } else if (type === 'log') {
    // 浮木：圆柱躺倒，靠圆柱两侧的弧面在水里滚，但滚到一定程度会卡住
    const r = targetSize * 0.17, h = targetSize * 1.15;
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r * 1.06, h, 14),
      new THREE.MeshStandardMaterial({ color: '#B98A5E', roughness: 0.85, metalness: 0.0 }),
    );
    m.rotation.z = Math.PI / 2;    // 轴朝 x
    group.add(m);
    shape = new CANNON.Box(new CANNON.Vec3(h / 2, r, r));
    volume = Math.PI * r * r * h;
  } else { // block
    const x = targetSize * 0.9, y = targetSize * 0.35, z = targetSize * 0.55;
    group.add(new THREE.Mesh(
      new THREE.BoxGeometry(x, y, z),
      new THREE.MeshStandardMaterial({ color: pickColor(), roughness: 0.45, metalness: 0.05 }),
    ));
    shape = new CANNON.Box(new CANNON.Vec3(x / 2, y / 2, z / 2));
    volume = x * y * z;
  }

  group.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });

  const bb = new THREE.Box3().setFromObject(group);
  const bounds = bb.getSize(new THREE.Vector3());
  // 鸭子形状不规则，采样密一点才不会因为探针太少而抖
  const probeN = type === 'duck' ? 6 : 4;
  return {
    root: group,
    shape,
    volume: Math.max(volume, 2e-4),
    probes: filterProbesInside(makeProbes(bb, probeN), shape),
    size: Math.max(bounds.x, bounds.y, bounds.z),
    bounds,
    upright,
  };
}

export const PRIMITIVE_TYPES = [
  { id: 'ball', label: '充气球' },
  { id: 'duck', label: '小黄鸭' },
  { id: 'crate', label: '木箱' },
  { id: 'barrel', label: '油桶' },
  { id: 'board', label: '浮板' },
  { id: 'ring', label: '救生圈' },
  { id: 'gem', label: '多面体' },
  { id: 'log', label: '浮木' },
  { id: 'block', label: '浮块' },
];
