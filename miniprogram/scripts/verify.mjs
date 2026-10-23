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

// 会叫的物体：只有鸭子带 quack，别的物体不该误触发
ok(createPrimitive('duck', 1.2).quack === true, '小黄鸭标记了 quack（撞击会叫）');
ok(createPrimitive('ball', 1.2).quack === false, '充气球不会叫');
const { AudioEngine } = await import('../pkg-water/core/audio.js');
ok(typeof AudioEngine.prototype.quack === 'function', '音效引擎提供 quack()');

// 石灯笼的落点：曾经的算法按 (cos,sin)*radius 摆，方位 165° 会把灯摆到水面正中央
const { lanternSpot } = await import('../pkg-water/core/scene.js');
const POOL = (await import('../pkg-water/core/config.js')).POOL;
let onDeck = 0, spots = [];
for (let az = 0; az < 360; az += 15) {
  const s = lanternSpot(az, 0.9);
  spots.push(`(${s.x.toFixed(1)},${s.z.toFixed(1)})`);
  // 池内半宽 / 半长（不含池壁）之外才算站在平台上
  if (Math.abs(s.x) >= POOL.innerX / 2 || Math.abs(s.z) >= POOL.innerZ / 2) onDeck++;
}
ok(onDeck === 24, `24 个方位的石灯笼都落在池外的平台上（${onDeck}/24）`);
ok(lanternSpot(165, 0.6).z > 0 || Math.abs(lanternSpot(165, 0.6).x) > POOL.innerX / 2,
  `方位 165° 的灯笼不再悬在水面上：${spots[11]}`);
// outset 必须真的改变位置（原来的「距池心」滑块在 2~12 之间完全没反应，像坏了）
ok(Math.abs(lanternSpot(0, 2.4).x - lanternSpot(0, 0).x - 2.4) < 1e-6,
  '「离池边」滑块能把灯笼往外推，且位移等于设定值');

// 石灯笼本体：绕开需要 WebGL 的构造函数，只借原型方法跑一遍几何构建
{
  const { WaterScene, FIREBOX_Y } = await import('../pkg-water/core/scene.js');
  const fake = {
    params: JSON.parse(JSON.stringify(params)),
    q: { shadow: true },
    lampGroup: new THREE.Group(),
    stoneMat: new THREE.MeshStandardMaterial(),
  };
  fake.lamps = fake.params.lights.map((_, i) => WaterScene.prototype._makeLamp.call(fake, i));
  WaterScene.prototype.updateLights.call(fake);
  const meshes = [];
  fake.lampGroup.traverse((o) => { if (o.isMesh) meshes.push(o); });
  ok(meshes.length >= 3 * 15, `3 盏石灯笼共 ${meshes.length} 个部件（基座/中台/6 柱/窗棂/笠/宝珠…）`);
  const L = fake.lamps[0];
  const wantY = POOL.wallHeight + FIREBOX_Y * L.group.scale.x;
  ok(Math.abs(L.light.position.y - wantY) < 1e-6,
    `灯芯正好在火袋里：y=${L.light.position.y.toFixed(2)}（灯笼 ${L.group.scale.x.toFixed(2)}×）`);
  ok(L.light.position.y > L.group.position.y + 0.4, '灯芯在灯笼内部而不是地面');

  // 織部灯笼的关键结构：没有长竿，靠一块雕空石的拱腿撑起；笠要明显比火袋宽。
  const own = [];
  L.group.traverse((o) => { if (o.isMesh) own.push(o); });
  const base = own.find((m) => m.geometry.type === 'ExtrudeGeometry');
  ok(!!base, '基座是挤出的拱形石块（不是三段式的圆盘+竿）');
  base.updateMatrixWorld(true);
  const hit = (x, y) => {
    const r = new THREE.Raycaster(new THREE.Vector3(x, y, 1), new THREE.Vector3(0, 0, -1));
    return r.intersectObject(base).length > 0;
  };
  ok(!hit(0, 0.25) && hit(0.38, 0.25) && hit(0, 0.62),
    '拱洞真的挖通了：正中镂空、腿部与拱顶之上是实心');

  const posts = own.filter((m) => m.geometry.type === 'BoxGeometry');
  const cap = own.find((m) => m.geometry.type === 'CylinderGeometry'
    && m.geometry.parameters.radiusBottom >= 0.7);
  ok(posts.length === 6, `火袋 6 根角柱（${posts.length}）`);
  ok(!!cap, '笠存在');
  // 角柱必须落在六角板的棱上。CylinderGeometry 的第 0 个顶点在 +z，
  // 用 (cos, sin) 摆会整体错开 30°、柱子长在面的中间。
  let worst = 0;
  for (const post of posts) {
    const ang = Math.atan2(post.position.x, post.position.z);
    let best = Math.PI;
    for (let k = 0; k < 6; k++) {
      const v = (k / 6) * Math.PI * 2;
      const d = Math.abs(((ang - v + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      best = Math.min(best, d);
    }
    worst = Math.max(worst, (best * 180) / Math.PI);
  }
  ok(worst < 1, `6 根角柱都长在六角棱上（最大偏差 ${worst.toFixed(1)}°）`);

  const postR = Math.hypot(posts[0].position.x, posts[0].position.z);
  ok(cap.geometry.parameters.radiusBottom / postR > 2.3,
    `笠比火袋宽得多：${(cap.geometry.parameters.radiusBottom * 2).toFixed(2)} m vs 火袋 ${(postR * 2).toFixed(2)} m`);
  // 量比例前把 updateLights 加的缩放/位移/旋转清掉，否则量到的是世界空间里的斜置 AABB
  L.group.position.set(0, 0, 0);
  L.group.rotation.y = 0;
  L.group.scale.setScalar(1);
  L.group.updateMatrixWorld(true);
  const total = new THREE.Box3().setFromObject(L.group).getSize(new THREE.Vector3());
  // 照片里笠宽 / 整灯高 ≈ 0.78，这个比例定了才像織部灯笼；厚薄也会一眼看出假
  ok(total.z / total.y > 0.72 && total.z / total.y < 0.85,
    `整灯比例像照片：高 ${total.y.toFixed(2)} m、笠宽 ${total.z.toFixed(2)} m（宽高比 ${(total.z / total.y).toFixed(2)}）`);
  ok(cap.geometry.parameters.height <= 0.22, `笠够扁（厚 ${cap.geometry.parameters.height.toFixed(2)} m），不是石饼`);
  const glowBB = new THREE.Box3().setFromObject(L.glow);
  ok(glowBB.min.y > 0.9 && glowBB.max.y < 1.6,
    `发光内芯完整藏在火袋里（${glowBB.min.y.toFixed(2)}~${glowBB.max.y.toFixed(2)} m）`);

  fake.params.lights[0].on = false;
  WaterScene.prototype.updateLights.call(fake);
  ok(L.light.intensity === 0, '关闭后点光源强度归零');
  ok(L.glow.material.color.getHex() !== new THREE.Color(fake.params.lights[0].color).getHex(),
    '关闭后火袋不再发光（必须显式换成石色，只靠强度归零它还是会亮）');
}

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

// varying 在两个 shader 里各声明一次是对的（独立编译单元），同一个 shader 内重复就编译失败
for (const v of ['vHeight', 'vSteep', 'vWPos']) {
  ok(decls(shaderObj.vertexShader, v) === 1, `顶点着色器 ${v} 声明 ${decls(shaderObj.vertexShader, v)} 次（应为 1）`);
  ok(decls(shaderObj.fragmentShader, v) === 1, `片元着色器 ${v} 声明 ${decls(shaderObj.fragmentShader, v)} 次（应为 1）`);
}
ok(decls(shaderObj.vertexShader, 'uWaveA') === 1, `uWaveA 声明 ${decls(shaderObj.vertexShader, 'uWaveA')} 次（应为 1）`);
ok(decls(shaderObj.vertexShader, 'uMaxAmp') === 1, `uMaxAmp 声明 ${decls(shaderObj.vertexShader, 'uMaxAmp')} 次（应为 1）`);
ok(/waveNormalAt/.test(shaderObj.vertexShader) && /waveHeightAt/.test(shaderObj.vertexShader),
  '顶点位移与法线函数已注入');
ok(!/#include <beginnormal_vertex>/.test(shaderObj.vertexShader), 'beginnormal_vertex 锚点已被替换');

// 菲涅尔 + 白沫
ok(/uFresnel/.test(shaderObj.fragmentShader) && /poolFoam/.test(shaderObj.fragmentShader),
  '菲涅尔反射与白沫函数已注入片元着色器');
ok(!/dFdx|dFdy/.test(shaderObj.fragmentShader),
  '片元着色器未使用 dFdx/dFdy（WebGL1 需要额外扩展，用了会整片水面编译失败）');
ok(/inverseTransformDirection\(normal, viewMatrix\)/.test(shaderObj.fragmentShader),
  '法线已从视图空间转回世界空间（菲涅尔需要世界空间的方向）');

// 开关：必须是 uniform，切换不能靠重编译
const uf = water.uniforms.uFresnel;
water.setFresnel(false);
ok(uf.value === 0, '关闭菲涅尔后强度为 0');
water.setFresnel(true, 0.6);
ok(Math.abs(uf.value - 0.6) < 1e-6, '开启菲涅尔后强度跟随滑块（0.6）');
water.setFresnel(true, 1);

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
