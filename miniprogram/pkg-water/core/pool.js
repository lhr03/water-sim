import * as THREE from '../lib/build/three.module.js';
import { POOL } from './config.js';

function setUVRepeat(tex, repeatX, repeatZ) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatZ);
  // three 0.133 用 encoding（0.152+ 才改叫 colorSpace）
  if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
  tex.anisotropy = 2;
  return tex;
}

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
  return setUVRepeat(new THREE.CanvasTexture(c), repeatX, repeatZ);
}

/** 圆角矩形路径。微信的 2d 上下文不一定有 roundRect，自己拼一遍最保险 */
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  if (typeof g.arcTo === 'function') {
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  } else {
    g.rect(x, y, w, h);
  }
}

/**
 * 程序化石板纹理（池边平台用）。
 *
 * 为什么不用瓷砖那张：瓷砖是规整网格 + 高光边，铺在池边像浴室地面，
 * 跟「日本庭院」的气质完全不对。石板要的是：缝宽不一、每块色差、表面有石粒噪点。
 * 纹理必须能无缝平铺，所以石板按等宽等高的网格切，只把边角做圆、色差做随机。
 */
function makeStoneTexture(repeatX = 1, repeatZ = 1, base = '#cfc7b8', joint = '#7b7466') {
  const S = 512;
  const c = wx.createOffscreenCanvas({ type: '2d', width: S, height: S });
  const g = c.getContext('2d');

  g.fillStyle = joint;          // 先铺缝的颜色，石板压在上面，缝就露出来了
  g.fillRect(0, 0, S, S);

  const rows = 3, cols = 3;
  const cw = S / cols, ch = S / rows;
  const baseCol = new THREE.Color(base);

  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const pad = 3;
      const x = k * cw + pad, y = r * ch + pad;
      const w = cw - pad * 2, h = ch - pad * 2;

      // 每块石头单独的色差，随机偏暖或偏冷
      const tone = 0.86 + Math.random() * 0.20;
      const col = baseCol.clone().multiplyScalar(tone);
      if (Math.random() > 0.5) col.offsetHSL(0.01, 0.02, 0);
      g.fillStyle = `#${col.getHexString()}`;
      roundRect(g, x, y, w, h, 9);
      g.fill();

      // 倒角：上缘提亮、下缘压暗，石板才有厚度，不然是贴纸
      g.fillStyle = 'rgba(255,255,255,0.16)';
      g.fillRect(x + 8, y + 2, w - 16, 3);
      g.fillStyle = 'rgba(52,44,36,0.22)';
      g.fillRect(x + 8, y + h - 7, w - 16, 4);

      // 石面上深浅不一的斑（水渍 / 矿物痕），比纯色更像石头
      for (let n = 0; n < 20; n++) {
        const px = x + Math.random() * w;
        const py = y + Math.random() * h;
        const rad = 6 + Math.random() * 26;
        g.fillStyle = Math.random() > 0.5
          ? `rgba(255,255,255,${0.02 + Math.random() * 0.035})`
          : `rgba(72,62,50,${0.02 + Math.random() * 0.045})`;
        g.beginPath();
        g.arc(px, py, rad, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  // 石粒噪点：远看是颗粒感，近看不会糊成一片
  for (let i = 0; i < 3600; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const a = Math.random();
    g.fillStyle = a > 0.5
      ? `rgba(255,255,255,${0.04 + a * 0.05})`
      : `rgba(60,52,44,${0.03 + a * 0.05})`;
    g.fillRect(x, y, 1, 1);
  }

  return setUVRepeat(new THREE.CanvasTexture(c), repeatX, repeatZ);
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
  const deckTex = makeStoneTexture(0.5, 0.5, '#cfc7b8', '#7b7466');
  const deckMat = new THREE.MeshStandardMaterial({ map: deckTex, roughness: 0.94, metalness: 0.0 });
  const deck = new THREE.Mesh(deckGeo, deckMat);
  deck.position.y = wh;
  deck.receiveShadow = quality !== 'low';
  deck.userData.pickable = 'deck';

  // 池壁压顶石：沿池口围一圈，比平台略高一点点。
  // 有了这道凸起的石边，水面的边线才有"池子"的实感；没有它，水像是浮在地砖上。
  // BoxGeometry 每个面都是 0~1 的 UV，所以压顶这种细长条要把 repeat 拉长（9:0.5），
  // 否则一块石板会有 3 米长。
  const copTex = makeStoneTexture(9, 0.5, '#d9d2c5', '#8a8378');
  const copMat = new THREE.MeshStandardMaterial({ map: copTex, roughness: 0.82, metalness: 0.0 });
  const copH = 0.14;
  const copW = wt + 0.26;
  const mkCop = (w, d, x, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, copH, d), copMat);
    m.position.set(x, wh + copH / 2, z);
    m.castShadow = quality !== 'low';
    m.receiveShadow = quality !== 'low';
    m.userData.pickable = 'deck';
    return m;
  };
  group.add(
    mkCop(innerX + wt * 2 + 0.52, copW, 0, innerZ / 2 + wt / 2),
    mkCop(innerX + wt * 2 + 0.52, copW, 0, -innerZ / 2 - wt / 2),
    mkCop(copW, innerZ + 0.52, innerX / 2 + wt / 2, 0),
    mkCop(copW, innerZ + 0.52, -innerX / 2 - wt / 2, 0),
  );

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
      [floorTex, wallTex, wallTexSide, deckTex, copTex].forEach((t) => t && t.dispose());
      [floorMat, wallMat, wallMatSide, deckMat, copMat].forEach((m) => m && m.dispose());
      group.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
      scene.remove(group);
    },
  };
}
