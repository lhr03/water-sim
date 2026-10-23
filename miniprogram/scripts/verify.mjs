// 平台适配层在模块加载时就会调用 wx 接口，Node 里没有，先打桩再动态导入
// 2D 画布上下文：任何方法都返回空操作，够画瓷砖纹理用
const CTX2D = new Proxy({}, {
  get: (_t, p) => {
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (p === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
    if (p === 'canvas') return { width: 1, height: 1 };
    return () => {};
  },
  set: () => true,
});

globalThis.wx = {
  getSystemInfoSync: () => ({ platform: 'devtools', SDKVersion: '3.0.0', pixelRatio: 2 }),
  getSystemInfo: (o) => o && o.success && o.success({ platform: 'devtools', pixelRatio: 2 }),
  onTouchStart() {}, onTouchMove() {}, onTouchEnd() {}, onTouchCancel() {},
  createCanvas: () => ({ width: 0, height: 0, getContext: () => CTX2D }),
  createOffscreenCanvas: () => ({ width: 0, height: 0, getContext: () => CTX2D }),
  getFileSystemManager: () => ({}), createWebAudioContext: () => ({}),
  requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16),
  cancelAnimationFrame: (id) => clearTimeout(id),
};
globalThis.self = globalThis;

const THREE = await import('../pkg-water/lib/build/three.module.js');
const CANNON = await import('../pkg-water/lib/cannon-es.js');
const { params } = await import('../pkg-water/core/config.js');
const { WaveField } = await import('../pkg-water/core/water.js');
const { WaterPhysics } = await import('../pkg-water/core/physics.js');
const { createPrimitive } = await import('../pkg-water/core/objects.js');
const { createPool } = await import('../pkg-water/core/pool.js');
const { WechatPlatform } = await import('../pkg-water/lib/src/WechatPlatform/index.js');
const { OrbitControls } = await import('../pkg-water/lib/examples/jsm/controls/OrbitControls.js');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✘ ') + m); if (!c) fail++; };

console.log('three REVISION =', THREE.REVISION);
ok(typeof THREE.PLATFORM === 'object', 'THREE.PLATFORM 存在（平台化补丁生效）');
ok(typeof THREE.Scene === 'function', 'THREE.Scene 可用');
ok(typeof WechatPlatform === 'function', 'WechatPlatform 具名导出可用');
ok(typeof OrbitControls === 'function', 'OrbitControls 可导入');
ok(typeof CANNON.World === 'function', 'cannon-es 可导入');

const wave = new WaveField(params, 20261022);
const physics = new WaterPhysics(params, wave);
// 所有内置物体模板都必须有 root（不是 mesh）——scene.spawn 曾经写成 tpl.mesh 导致
// 「Cannot set properties of undefined (setting 'castShadow')」
const { PRIMITIVE_TYPES } = await import('../pkg-water/core/objects.js');
let tplOk = 0;
for (const t of PRIMITIVE_TYPES) {
  const tpl = createPrimitive(t.id, 1.2);
  if (tpl.root && tpl.shape && tpl.probes && tpl.probes.length > 0 && tpl.volume > 0) tplOk++;
  else console.log(`    模板 ${t.id} 缺字段:`, Object.keys(tpl).join(','));
}
ok(tplOk === PRIMITIVE_TYPES.length, `${tplOk}/${PRIMITIVE_TYPES.length} 个内置物体模板结构完整（含 root）`);

const sceneSrc = (await import('node:fs')).readFileSync(
  new URL('../pkg-water/core/scene.js', import.meta.url), 'utf8');
ok(!/tpl\.mesh/.test(sceneSrc), 'scene.js 未再误用 tpl.mesh');

// 模型导入已砍：loader 与 importModel 都不该再出现，否则会把体积和坑一起带回来
const fsMod = await import('node:fs');
const objSrc = fsMod.readFileSync(new URL('../pkg-water/core/objects.js', import.meta.url), 'utf8');
// 只看真正的 import 语句：注释里会提到 loader 名字，那不算
ok(!/from\s+['"][^'"]*loaders\//.test(objSrc), 'objects.js 不再 import 模型 loader');
ok(!/importModel/.test(sceneSrc), 'scene.js 不再有 importModel');
ok(/setDropType/.test(sceneSrc) && /applyPreset/.test(sceneSrc) && /kick\(/.test(sceneSrc),
  'scene.js 提供 setDropType / applyPreset / kick');
ok(['duck', 'gem', 'log'].every((id) => PRIMITIVE_TYPES.some((t) => t.id === id)),
  '新物体（小黄鸭 / 多面体 / 浮木）已注册');

// 水面着色器：把注入结果在真实的 three shader 源码上跑一遍，检查声明是否重复。
// 曾经因为 vFoam 被声明两次导致顶点着色器编译失败 → 水面整个不渲染、池子看起来是干的。
const { createWater } = await import('../pkg-water/core/water.js');
const wf2 = new (await import('../pkg-water/core/water.js')).WaveField(params, 7);
const water = createWater(wf2, 'mid');
const shaderObj = {
  uniforms: {},
  vertexShader: (THREE.ShaderLib.physical || THREE.ShaderLib.standard).vertexShader,
  fragmentShader: (THREE.ShaderLib.physical || THREE.ShaderLib.standard).fragmentShader,
};
water.material.onBeforeCompile(shaderObj);
const decls = (src, name) => (src.match(new RegExp(`\\b(?:uniform|varying|attribute)\\s+\\w+\\s+${name}\\s*(?:\\[|;)`, 'g')) || []).length;
ok(decls(shaderObj.vertexShader, 'vFoam') === 1, `顶点着色器 vFoam 声明 ${decls(shaderObj.vertexShader, 'vFoam')} 次（应为 1）`);
ok(decls(shaderObj.fragmentShader, 'vFoam') === 1, `片元着色器 vFoam 声明 ${decls(shaderObj.fragmentShader, 'vFoam')} 次（应为 1）`);
ok(decls(shaderObj.vertexShader, 'uWaveA') === 1, `uWaveA 声明 ${decls(shaderObj.vertexShader, 'uWaveA')} 次（应为 1）`);
ok(decls(shaderObj.vertexShader, 'uMaxAmp') === 1, `uMaxAmp 声明 ${decls(shaderObj.vertexShader, 'uMaxAmp')} 次（应为 1）`);
ok(/waveNormalAt/.test(shaderObj.vertexShader) && /waveHeightAt/.test(shaderObj.vertexShader),
  '顶点位移与法线函数已注入');
ok(!/#include <beginnormal_vertex>/.test(shaderObj.vertexShader), 'beginnormal_vertex 锚点已被替换');
const braces = (s) => (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length;
ok(braces(shaderObj.vertexShader) === 0 && braces(shaderObj.fragmentShader) === 0, '着色器大括号配平');

const scene = new THREE.Scene();
const pool = createPool(scene, 'mid');
for (const c of pool.colliders) physics.addStaticBox(c.half, c.pos);

// 池口必须通透：从正上方垂直往下打射线，水面以上不允许有任何几何体。
// 曾经池边平台是一整块实心 Box 盖在 y=-0.15（顶面正好在水面高度），
// 结果只有浪尖从板上冒出来，浪谷全被挡住，池子看起来是干的。
scene.add(water.group);
scene.updateMatrixWorld(true);   // 不做这一步，raycast 会用单位矩阵，全部打在原点
const rayDown = new THREE.Raycaster(new THREE.Vector3(0, 20, 0), new THREE.Vector3(0, -1, 0));
const hitsAbove = rayDown.intersectObjects(scene.children, true)
  .filter((h) => h.point.y > -1.5);
const blockers = hitsAbove.filter((h) => h.object !== water.mesh);
ok(blockers.length === 0,
  `池口无遮挡（水面以上命中 ${hitsAbove.length} 个，其中非水面 ${blockers.length} 个：${blockers.map((b) => b.object.name || b.object.type).join(',') || '无'}）`);
ok(hitsAbove.some((h) => h.object === water.mesh), '水面在池口位置可被射线命中');
ok(Math.abs(water.mesh.position.y - params.waterLevel) < 1e-6,
  `水面高度 y=${water.mesh.position.y}（水位 ${params.waterLevel}）`);

const t = createPrimitive('box', 1.2);
const e = physics.addBody({
  shape: t.shape, mass: t.volume * params.density * params.waterDensity,
  position: { x: 0, y: 3, z: 0 }, quaternion: new THREE.Quaternion(),
  volume: t.volume, probes: t.probes, size: t.size, mesh: null, seed: 2,
});
// 再放一个紧挨着的物体，否则单个物体落水后原地浮着，永远碰不到东西
physics.addBody({
  shape: t.shape, mass: t.volume * params.density * params.waterDensity,
  position: { x: 0.75, y: 3, z: 0 }, quaternion: new THREE.Quaternion(),
  volume: t.volume, probes: t.probes, size: t.size, mesh: null, seed: 7,
});

let splashes = 0, impacts = 0;
physics.onSplash = () => splashes++;
physics.onImpact = () => impacts++;

const dt = 1 / 60;
for (let i = 0; i < 480; i++) { wave.update(dt); physics.step(dt); }
const y = e.body.position.y;
ok(y > -0.6 && y < 0.9, `木箱稳定漂浮 y=${y.toFixed(3)}`);
ok(splashes >= 2, `入水水花事件 ${splashes} 次`);
// 轻微接触（相对速度 < 0.55）是故意不发声的，否则随浪轻碰会一直响
ok(impacts === 0, `随浪轻碰被正确过滤（事件 ${impacts} 次）`);

// 从高处砸一个重物下去，这才是真正该响的撞击
const heavy = createPrimitive('ball', 0.9);
physics.addBody({
  shape: heavy.shape, mass: heavy.volume * 3.0 * params.waterDensity,
  position: { x: 0.2, y: 9, z: 0 }, quaternion: new THREE.Quaternion(),
  volume: heavy.volume, probes: heavy.probes, size: heavy.size, mesh: null, seed: 11,
});
for (let i = 0; i < 180; i++) { wave.update(dt); physics.step(dt); }
ok(impacts >= 1, `高速撞击触发碰撞事件 ${impacts} 次`);

// 「推一把」：冲量必须按质量给，否则重箱子不动、轻鸭子飞出池子。
// 判据看速度矢量的变化量（不是速率）：物体本来就朝反方向动时，速率反而会变小。
const before = physics.bodies.map((b) => ({
  x: b.body.velocity.x, y: b.body.velocity.y, z: b.body.velocity.z,
}));
physics.kick(2.5);
let moved = 0;
let maxDv = 0;
physics.bodies.forEach((b, i) => {
  const d = before[i];
  const dv = Math.hypot(b.body.velocity.x - d.x, b.body.velocity.y - d.y, b.body.velocity.z - d.z);
  if (dv > 0.3) moved++;
  maxDv = Math.max(maxDv, dv);
});
ok(moved === physics.bodies.length,
  `kick 让 ${moved}/${physics.bodies.length} 个物体获得速度（最大 Δv=${maxDv.toFixed(2)} m/s）`);

// 小黄鸭必须能自己翻正：碰撞盒是均质盒子，翻 180° 同样是平衡态，
// 不加自扶正力矩它就会一直倒着浮（实测 up.y = -0.67，即肚皮朝天）。
{
  const p2 = Object.assign({}, params, { windStrength: 0, waveHeight: 0, windGust: 0 });
  const wf3 = new WaveField(p2, 5150);
  const ph3 = new WaterPhysics(p2, wf3);
  const duck = createPrimitive('duck', 1.2);
  ok(duck.upright === true, '小黄鸭标记了自扶正（upright）');
  const e3 = ph3.addBody({
    shape: duck.shape, mass: duck.volume * p2.density * p2.waterDensity,
    position: { x: 0, y: 2.5, z: 0 },
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI),
    volume: duck.volume, probes: duck.probes, size: duck.size, mesh: null, seed: 3,
    upright: duck.upright,
  });
  for (let i = 0; i < 600; i++) { wf3.update(dt); ph3.step(dt); }
  const q3 = e3.body.quaternion;
  const up3 = new THREE.Vector3(0, 1, 0)
    .applyQuaternion(new THREE.Quaternion(q3.x, q3.y, q3.z, q3.w));
  const tilt = (Math.acos(Math.min(1, Math.abs(up3.y))) * 180) / Math.PI;
  ok(tilt < 25, `倒着扔的小黄鸭翻了回来，残余倾角 ${tilt.toFixed(0)}°`);
  ok(e3.body.position.y > -0.4 && e3.body.position.y < 0.6,
    `小黄鸭浮在 ${e3.body.position.y.toFixed(3)}（水面附近）`);
}

console.log(fail === 0 ? '\n全部通过 ✓' : `\n失败 ${fail} 项 ✘`);
process.exit(fail === 0 ? 0 : 1);
