import * as THREE from '../lib/build/three.module.js';
import { POOL } from './config.js';

/**
 * 程序化生成泳池瓷砖纹理。
 * 小程序没有 document，用离屏 canvas 画；尺寸压到 256（微信纹理上限 2048）。
 */
function makeTileTexture(repeatX = 1, repeatZ = 1, base = '#bfe4f5', grout = '#5b9fc4') {
  const c = wx.createOffscreenCanvas({ type: '2d', width: 256, height: 256 });
  const g = c.getContext('2d');
  const S = 256;
  const tiles = 4;
  const s = S / tiles;
  g.fillStyle = grout;
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < tiles; i++) {
    for (let j = 0; j < tiles; j++) {
      const shade = 0.88 + Math.random() * 0.12;
      const col = new THREE.Color(base).multiplyScalar(shade);
      g.fillStyle = `#${col.getHexString()}`;
      g.fillRect(i * s + 2, j * s + 2, s - 4, s - 4);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(i * s + 2, j * s + 2, s - 4, 3);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatZ);
  // three 0.133 用 encoding（0.152+ 才改叫 colorSpace）
  if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
  tex.anisotropy = 2;
  return tex;
}

export function createPool(scene, quality = 'mid') {
  const { innerX, innerZ, depth, wallThickness: wt, wallHeight: wh } = POOL;
  const group = new THREE.Group();
  group.name = 'pool';

  const wallH = depth + wh;
  const wallCY = -depth + wallH / 2;

  // 池底（精简版去掉焦散动画，省一层 shader 开销）
  const floorTex = makeTileTexture(innerX / 1.0, innerZ / 1.0, '#bfdff0', '#4f93bd');
  const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.42, metalness: 0.0 });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(innerX, 0.4, innerZ), floorMat);
  floor.position.y = -depth - 0.2;
  floor.receiveShadow = quality !== 'low';
  floor.userData.pickable = 'floor';

  // 四面池壁
  const wallTex = makeTileTexture(innerX / 1.0, wallH / 1.0, '#cfe9f7', '#4f93bd');
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.38, metalness: 0.0 });
  const wallTexSide = makeTileTexture(innerZ / 1.0, wallH / 1.0, '#cfe9f7', '#4f93bd');
  const wallMatSide = new THREE.MeshStandardMaterial({ map: wallTexSide, roughness: 0.38, metalness: 0.0 });

  const mkWall = (w, h, d, x, y, z, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = quality !== 'low';
    m.receiveShadow = quality !== 'low';
    m.userData.pickable = 'wall';
    return m;
  };

  group.add(
    mkWall(innerX + wt * 2, wallH, wt, 0, wallCY, innerZ / 2 + wt / 2, wallMat),
    mkWall(innerX + wt * 2, wallH, wt, 0, wallCY, -innerZ / 2 - wt / 2, wallMat),
    mkWall(wt, wallH, innerZ, innerX / 2 + wt / 2, wallCY, 0, wallMatSide),
    mkWall(wt, wallH, innerZ, -innerX / 2 - wt / 2, wallCY, 0, wallMatSide),
  );

  // 池边平台：必须是一块「中间有洞」的平面。
  // 之前用整个 BoxGeometry 铺在 -0.15，等于在池口盖了一块板，板顶正好在水面高度，
  // 结果水只有浪尖从板上冒出来、浪谷全被挡住，池子看起来是干的。
  const deckW = 4.0;
  const shape = new THREE.Shape();
  const ox = innerX / 2 + wt + deckW;
  const oz = innerZ / 2 + wt + deckW;
  shape.moveTo(-ox, -oz); shape.lineTo(ox, -oz); shape.lineTo(ox, oz); shape.lineTo(-ox, oz); shape.closePath();
  const hole = new THREE.Path();
  const ix = innerX / 2 + wt;
  const iz = innerZ / 2 + wt;
  hole.moveTo(-ix, -iz); hole.lineTo(-ix, iz); hole.lineTo(ix, iz); hole.lineTo(ix, -iz); hole.closePath();
  shape.holes.push(hole);
  const deckGeo = new THREE.ShapeGeometry(shape);
  deckGeo.rotateX(-Math.PI / 2);
  // ShapeGeometry 的 UV 直接用顶点坐标（单位：米），所以 repeat 取 0.5，即每 2 米一次纹理
  const deckTex = makeTileTexture(0.5, 0.5, '#e8eaed', '#b9bec4');
  const deckMat = new THREE.MeshStandardMaterial({ map: deckTex, roughness: 0.85, metalness: 0.0 });
  const deck = new THREE.Mesh(deckGeo, deckMat);
  deck.position.y = wh;
  deck.receiveShadow = quality !== 'low';
  deck.userData.pickable = 'deck';

  group.add(floor, deck);
  scene.add(group);

  /* ---------------- 静态碰撞体（四面墙 + 池底 + 防飞出挡板） ---------------- */
  const colliders = [];
  colliders.push({ half: [innerX / 2 + wt, wallH / 2, wt / 2], pos: [0, wallCY, innerZ / 2 + wt / 2] });
  colliders.push({ half: [innerX / 2 + wt, wallH / 2, wt / 2], pos: [0, wallCY, -innerZ / 2 - wt / 2] });
  colliders.push({ half: [wt / 2, wallH / 2, innerZ / 2], pos: [innerX / 2 + wt / 2, wallCY, 0] });
  colliders.push({ half: [wt / 2, wallH / 2, innerZ / 2], pos: [-innerX / 2 - wt / 2, wallCY, 0] });
  colliders.push({ half: [innerX / 2 + wt, 0.5, innerZ / 2 + wt], pos: [0, -depth - 0.5, 0] });

  // 水面之上的隐形挡板：防止大浪把物体推出池外
  const guardH = 3.0;
  colliders.push({ half: [0.2, guardH / 2, innerZ / 2 + wt], pos: [innerX / 2 + wt + 0.2, guardH / 2 - 0.5, 0] });
  colliders.push({ half: [0.2, guardH / 2, innerZ / 2 + wt], pos: [-innerX / 2 - wt - 0.2, guardH / 2 - 0.5, 0] });
  colliders.push({ half: [innerX / 2 + wt, guardH / 2, 0.2], pos: [0, guardH / 2 - 0.5, innerZ / 2 + wt + 0.2] });
  colliders.push({ half: [innerX / 2 + wt, guardH / 2, 0.2], pos: [0, guardH / 2 - 0.5, -innerZ / 2 - wt - 0.2] });

  return {
    group,
    colliders,
    dispose() {
      [floorTex, wallTex, wallTexSide, deckTex].forEach((t) => t && t.dispose());
      [floorMat, wallMat, wallMatSide, deckMat].forEach((m) => m && m.dispose());
      group.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
      scene.remove(group);
    },
  };
}
