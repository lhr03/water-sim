import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { makeProbes } from './physics.js';

const PALETTE = ['#FFD966', '#A8DAF5', '#A5D6A7', '#FFAB91', '#CE93D8', '#F48FB1', '#90CAF9', '#FFF59D'];

let gltfLoader = null;
export function getGLTFLoader() {
  if (!gltfLoader) {
    gltfLoader = new GLTFLoader();
    try {
      const draco = new DRACOLoader();
      draco.setDecoderPath('./vendor/three/addons/libs/draco/gltf/');
      gltfLoader.setDRACOLoader(draco);
    } catch (e) { /* 无 draco 也能加载普通 glb */ }
  }
  return gltfLoader;
}

/* ------------------------- 模型文件导入 ------------------------- */

export function loadModelFile(file) {
  return new Promise((resolve, reject) => {
    const name = file.name || 'model';
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    const reader = new FileReader();

    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.onload = () => {
      const data = reader.result;
      try {
        if (ext === '.glb' || ext === '.gltf') {
          const loader = getGLTFLoader();
          const isBin = ext === '.glb' || data instanceof ArrayBuffer;
          loader.parse(isBin ? data : new TextDecoder().decode(data), '', (gltf) => {
            resolve(gltf.scene || gltf.scenes[0]);
          }, (err) => reject(new Error('GLTF 解析失败: ' + (err && err.message))));
        } else if (ext === '.obj') {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const obj = new OBJLoader().parse(text);
          obj.traverse((o) => {
            if (o.isMesh) {
              o.material = new THREE.MeshStandardMaterial({
                color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
                roughness: 0.55, metalness: 0.05,
              });
            }
          });
          resolve(obj);
        } else if (ext === '.fbx') {
          const fbx = new FBXLoader().parse(data instanceof ArrayBuffer ? data : data, '');
          resolve(fbx);
        } else if (ext === '.stl') {
          const geo = new STLLoader().parse(data);
          geo.computeVertexNormals();
          const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
            color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
            roughness: 0.5, metalness: 0.1,
          }));
          resolve(mesh);
        } else {
          reject(new Error('暂不支持的格式：' + ext));
        }
      } catch (err) {
        reject(err);
      }
    };

    if (ext === '.obj' || ext === '.gltf') reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  });
}

/* --------------------- 几何 → 碰撞体 / 体积 / 探针 --------------------- */

export function collectPoints(root, maxPoints = 6000) {
  root.updateMatrixWorld(true);
  const pts = [];
  const v = new THREE.Vector3();
  const meshes = [];
  root.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o); });
  let total = 0;
  for (const m of meshes) total += m.geometry.attributes.position.count;
  const stride = Math.max(1, Math.ceil(total / maxPoints));
  let count = 0;
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      pts.push(v.clone());
      count++;
    }
  }
  return pts;
}

export function computeVolume(root) {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  root.updateMatrixWorld(true);
  let vol = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    const pos = g.attributes.position;
    if (!pos) return;
    const idx = g.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i;
      const i1 = idx ? idx.getX(i + 1) : i + 1;
      const i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      vol += a.dot(new THREE.Vector3().crossVectors(ab, ac)) / 6;
    }
  });
  return Math.abs(vol);
}

/** 把点集按体素格粗化，用于在面数过多时生成“简化凸包” */
function simplifyPoints(points, maxDim, cells = 8) {
  const q = Math.max(1e-4, maxDim / cells);
  const map = new Map();
  for (const p of points) {
    const k = `${Math.round(p.x / q)}|${Math.round(p.y / q)}|${Math.round(p.z / q)}`;
    if (!map.has(k)) map.set(k, p.clone());
  }
  return [...map.values()];
}

function hullToCannonShape(points, maxFaces = 64, maxVerts = 110) {
  const hull = new ConvexHull().setFromPoints(points);
  if (hull.faces.length > maxFaces) return null;
  const verts = [];
  const map = new Map();
  const faces = [];
  for (const f of hull.faces) {
    const idx = [];
    let e = f.edge;
    let guard = 0;
    do {
      const p = e.head().point;
      const key = `${p.x.toFixed(4)}|${p.y.toFixed(4)}|${p.z.toFixed(4)}`;
      let i = map.get(key);
      if (i === undefined) {
        i = verts.length;
        map.set(key, i);
        verts.push(new CANNON.Vec3(p.x, p.y, p.z));
      }
      idx.push(i);
      e = e.next;
      guard++;
    } while (e !== f.edge && guard < 512);
    if (idx.length >= 3) faces.push(idx);
  }
  if (faces.length < 4 || faces.length > maxFaces || verts.length > maxVerts) return null;
  try {
    const shape = new CANNON.ConvexPolyhedron({ vertices: verts, faces });
    return shape;
  } catch (e) {
    return null;
  }
}

/**
 * 把任意 Object3D 处理成“可投放的漂浮体模板”
 * @returns {root, shape, volume, probes, size, bounds}
 */
export function buildFloatingTemplate(object, targetSize) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) throw new Error('模型为空');
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const s = targetSize / maxDim;

  const root = new THREE.Group();
  object.position.sub(center);           // 几何中心对齐到 root 原点
  root.add(object);
  root.scale.setScalar(s);
  root.updateMatrixWorld(true);

  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
            m.envMapIntensity = 1.0;
          }
        }
      }
    }
  });

  // 体积
  const bb = new THREE.Box3().setFromObject(root);
  const bsize = bb.getSize(new THREE.Vector3());
  const bboxVol = bsize.x * bsize.y * bsize.z;
  let volume = computeVolume(root);
  if (!isFinite(volume) || volume <= 1e-8 || volume > Math.max(bboxVol, 1e-6) * 1.5) {
    // 非闭合 / 退化（例如一个平面）网格的兜底估计
    volume = bboxVol > 1e-5 ? bboxVol * 0.5 : Math.max(bsize.x * bsize.z * 0.02, 5e-4);
  }
  volume = Math.max(volume, 2e-4);

  // 碰撞体：优先凸包（面数过多时先做点集粗化再求凸包），最后退化用盒
  let shape = null;
  try {
    const pts = collectPoints(root);
    const maxDim = Math.max(bsize.x, bsize.y, bsize.z);
    shape = hullToCannonShape(pts);
    if (!shape) shape = hullToCannonShape(simplifyPoints(pts, maxDim, 8));
    if (!shape) shape = hullToCannonShape(simplifyPoints(pts, maxDim, 5));
    if (!shape) shape = new CANNON.Box(new CANNON.Vec3(bsize.x / 2, bsize.y / 2, bsize.z / 2));
  } catch (e) {
    shape = new CANNON.Box(new CANNON.Vec3(bsize.x / 2, bsize.y / 2, bsize.z / 2));
  }

  const probes = makeProbes(bb);
  return {
    root,
    shape,
    volume,
    probes,
    size: Math.max(bsize.x, bsize.y, bsize.z),
    bounds: bsize,
  };
}

/* --------------------------- 内置物体 --------------------------- */

export function createPrimitive(type, targetSize = 1.2) {
  const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.05 });
  let mesh, shape, volume, size;

  if (type === 'ball') {
    const r = targetSize * 0.42;
    mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 24), mat);
    shape = new CANNON.Sphere(r);
    volume = (4 / 3) * Math.PI * r * r * r;
    size = r * 2;
  } else if (type === 'crate') {
    const s = targetSize * 0.6;
    mesh = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), mat);
    shape = new CANNON.Box(new CANNON.Vec3(s / 2, s / 2, s / 2));
    volume = s * s * s;
    size = s;
  } else if (type === 'barrel') {
    const r = targetSize * 0.26, h = targetSize * 0.7;
    mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 24), mat);
    shape = new CANNON.Cylinder(r, r, h, 12);
    volume = Math.PI * r * r * h;
    size = h;
  } else if (type === 'board') {
    const x = targetSize * 1.1, y = targetSize * 0.1, z = targetSize * 0.42;
    mesh = new THREE.Mesh(new THREE.BoxGeometry(x, y, z), mat);
    shape = new CANNON.Box(new CANNON.Vec3(x / 2, y / 2, z / 2));
    volume = x * y * z;
    size = x;
  } else if (type === 'ring') {
    const R = targetSize * 0.4, t = targetSize * 0.11;
    mesh = new THREE.Mesh(new THREE.TorusGeometry(R, t, 16, 28), mat);
    shape = new CANNON.Cylinder(R + t, R + t, t * 2, 12);
    volume = 2 * Math.PI * Math.PI * R * t * t;
    size = (R + t) * 2;
  } else { // block
    const x = targetSize * 0.9, y = targetSize * 0.35, z = targetSize * 0.55;
    mesh = new THREE.Mesh(new THREE.BoxGeometry(x, y, z), mat);
    shape = new CANNON.Box(new CANNON.Vec3(x / 2, y / 2, z / 2));
    volume = x * y * z;
    size = x;
  }

  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const root = new THREE.Group();
  root.add(mesh);
  const bb = new THREE.Box3().setFromObject(root);
  return {
    root,
    shape,
    volume,
    probes: makeProbes(bb),
    size,
    bounds: bb.getSize(new THREE.Vector3()),
  };
}

export const PRIMITIVE_TYPES = [
  { id: 'ball', label: '充气球' },
  { id: 'crate', label: '木箱' },
  { id: 'barrel', label: '油桶' },
  { id: 'board', label: '浮板' },
  { id: 'ring', label: '救生圈' },
  { id: 'block', label: '浮块' },
];
