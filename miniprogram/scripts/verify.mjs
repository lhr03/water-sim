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
const scene = new THREE.Scene();
for (const c of createPool(scene).colliders) physics.addStaticBox(c.half, c.pos);

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

console.log(fail === 0 ? '\n全部通过 ✓' : `\n失败 ${fail} 项 ✘`);
process.exit(fail === 0 ? 0 : 1);
