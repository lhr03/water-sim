import * as THREE from 'three';
import { POOL } from './config.js';

/** 程序化生成泳池瓷砖纹理（浅蓝白瓷砖 + 深蓝缝） */
function makeTileTexture(repeatX = 1, repeatZ = 1, base = '#bfe4f5', grout = '#5b9fc4') {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const tiles = 4;
  const s = 256 / tiles;
  g.fillStyle = grout;
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < tiles; i++) {
    for (let j = 0; j < tiles; j++) {
      const shade = 0.88 + Math.random() * 0.12;
      const col = new THREE.Color(base).multiplyScalar(shade);
      g.fillStyle = `#${col.getHexString()}`;
      g.fillRect(i * s + 2, j * s + 2, s - 4, s - 4);
      // 高光边
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(i * s + 2, j * s + 2, s - 4, 3);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatZ);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function createPool(scene) {
  const { innerX, innerZ, depth, wallThickness: wt, wallHeight: wh } = POOL;
  const group = new THREE.Group();
  group.name = 'pool';

  const wallH = depth + wh;                 // 从池底到池壁顶
  const wallCY = -depth + wallH / 2;

  // 池底（带焦散动画）
  const floorTex = makeTileTexture(innerX / 1.0, innerZ / 1.0, '#bfdff0', '#4f93bd');
  const causticsTime = { value: 0 };
  const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.42, metalness: 0.0 });
  floorMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTimeC = causticsTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPosC;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPosC = (modelMatrix * vec4(transformed,1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPosC;\nuniform float uTimeC;')
      .replace('#include <dithering_fragment>', /* glsl */`
        #include <dithering_fragment>
        float t = uTimeC * 0.5;
        vec2 q = vWPosC.xz * 0.85;
        float c1 = sin(q.x * 1.25 + t) * sin(q.y * 1.05 - t * 0.7);
        float c2 = sin(q.x * 0.63 - t * 0.55) * sin(q.y * 1.63 + t * 1.15);
        float ca = pow(max((c1 + c2) * 0.35 + 0.5, 0.0), 4.0);
        gl_FragColor.rgb += vec3(0.35, 0.62, 0.85) * ca * 0.35;
      `);
  };
  floorMat.customProgramCacheKey = () => 'poolFloor';

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(innerX, innerZ, 1, 1), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -depth;
  floor.receiveShadow = true;
  group.add(floor);

  // 池壁（四面）
  const wallMat = new THREE.MeshStandardMaterial({
    map: makeTileTexture(innerX / 1.0, wallH / 1.0, '#c8e8f7', '#4f93bd'),
    roughness: 0.35,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });
  const wallMatZ = wallMat.clone();
  wallMatZ.map = makeTileTexture(innerZ / 1.0, wallH / 1.0, '#c8e8f7', '#4f93bd');

  const colliders = [];

  function addWall(size, pos, mat) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat);
    m.position.set(pos[0], pos[1], pos[2]);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    colliders.push({ half: [size[0] / 2, size[1] / 2, size[2] / 2], pos });
    return m;
  }

  // x 方向两面
  addWall([wt, wallH, innerZ + wt * 2], [innerX / 2 + wt / 2, wallCY, 0], wallMat);
  addWall([wt, wallH, innerZ + wt * 2], [-(innerX / 2 + wt / 2), wallCY, 0], wallMat);
  // z 方向两面
  addWall([innerX + wt * 2, wallH, wt], [0, wallCY, innerZ / 2 + wt / 2], wallMatZ);
  addWall([innerX + wt * 2, wallH, wt], [0, wallCY, -(innerZ / 2 + wt / 2)], wallMatZ);

  // 池底碰撞
  colliders.push({ half: [innerX / 2 + wt, 0.5, innerZ / 2 + wt], pos: [0, -depth - 0.5, 0] });

  // 隐形挡板：池壁以上再往上 5 米的“透明围栏”，防止物体被风/碰撞弹飞出泳池
  const guardH = 5.0;
  const guardCY = wh + guardH / 2;
  colliders.push({ half: [wt / 2, guardH / 2, (innerZ + wt * 2) / 2], pos: [innerX / 2 + wt / 2, guardCY, 0], invisible: true });
  colliders.push({ half: [wt / 2, guardH / 2, (innerZ + wt * 2) / 2], pos: [-(innerX / 2 + wt / 2), guardCY, 0], invisible: true });
  colliders.push({ half: [(innerX + wt * 2) / 2, guardH / 2, wt / 2], pos: [0, guardCY, innerZ / 2 + wt / 2], invisible: true });
  colliders.push({ half: [(innerX + wt * 2) / 2, guardH / 2, wt / 2], pos: [0, guardCY, -(innerZ / 2 + wt / 2)], invisible: true });

  // 池边平台（甲板）
  const deck = 4.0;
  const shape = new THREE.Shape();
  const ox = innerX / 2 + wt + deck, oz = innerZ / 2 + wt + deck;
  shape.moveTo(-ox, -oz); shape.lineTo(ox, -oz); shape.lineTo(ox, oz); shape.lineTo(-ox, oz); shape.closePath();
  const hole = new THREE.Path();
  const ix = innerX / 2 + wt, iz = innerZ / 2 + wt;
  hole.moveTo(-ix, -iz); hole.lineTo(-ix, iz); hole.lineTo(ix, iz); hole.lineTo(ix, -iz); hole.closePath();
  shape.holes.push(hole);
  const deckGeo = new THREE.ShapeGeometry(shape);
  deckGeo.rotateX(-Math.PI / 2);
  // 注意：ShapeGeometry 的 UV 直接使用顶点坐标（单位：米），所以 repeat 取 0.5（每 2 米一次纹理）
  const deckTex = makeTileTexture(0.5, 0.5, '#e8eaed', '#b9bec4');
  const deckMat = new THREE.MeshStandardMaterial({ map: deckTex, roughness: 0.85, metalness: 0.0 });
  const deckMesh = new THREE.Mesh(deckGeo, deckMat);
  deckMesh.position.y = wh;
  deckMesh.receiveShadow = true;
  deckMesh.userData.pickable = 'deck';
  group.add(deckMesh);

  scene.add(group);

  return {
    group,
    colliders,
    deckMesh,
    update(dt) { causticsTime.value += dt; },
  };
}
