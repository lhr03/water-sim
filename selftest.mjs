// 物理与几何自检（Node 端，不需要浏览器）：验证浮力、稳定性、凸包、碰撞事件
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { params, POOL } from './src/config.js';
import { WaveField } from './src/water.js';
import { WaterPhysics } from './src/physics.js';
import { createPrimitive, buildFloatingTemplate, collectPoints, computeVolume } from './src/objects.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// 固定种子：让每次运行的自检结果完全可复现（运行时用不传种子的随机波面）
const wave = new WaveField(params, 20261022);
const physics = new WaterPhysics(params, wave);

// 泳池边界
const cfg = [
  { half: [POOL.wallThickness / 2, (POOL.depth + POOL.wallHeight) / 2, (POOL.innerZ + POOL.wallThickness * 2) / 2], pos: [POOL.innerX / 2 + POOL.wallThickness / 2, -POOL.depth + (POOL.depth + POOL.wallHeight) / 2, 0] },
  { half: [POOL.wallThickness / 2, (POOL.depth + POOL.wallHeight) / 2, (POOL.innerZ + POOL.wallThickness * 2) / 2], pos: [-(POOL.innerX / 2 + POOL.wallThickness / 2), -POOL.depth + (POOL.depth + POOL.wallHeight) / 2, 0] },
  { half: [(POOL.innerX + POOL.wallThickness * 2) / 2, (POOL.depth + POOL.wallHeight) / 2, POOL.wallThickness / 2], pos: [0, -POOL.depth + (POOL.depth + POOL.wallHeight) / 2, POOL.innerZ / 2 + POOL.wallThickness / 2] },
  { half: [(POOL.innerX + POOL.wallThickness * 2) / 2, (POOL.depth + POOL.wallHeight) / 2, POOL.wallThickness / 2], pos: [0, -POOL.depth + (POOL.depth + POOL.wallHeight) / 2, -(POOL.innerZ / 2 + POOL.wallThickness / 2)] },
  { half: [POOL.innerX / 2 + POOL.wallThickness, 0.5, POOL.innerZ / 2 + POOL.wallThickness], pos: [0, -POOL.depth - 0.5, 0] },
];
// 隐形防飞出挡板（与 pool.js 保持一致）
const gh = 5.0, gcy = POOL.wallHeight + gh / 2;
cfg.push(
  { half: [POOL.wallThickness / 2, gh / 2, (POOL.innerZ + POOL.wallThickness * 2) / 2], pos: [POOL.innerX / 2 + POOL.wallThickness / 2, gcy, 0] },
  { half: [POOL.wallThickness / 2, gh / 2, (POOL.innerZ + POOL.wallThickness * 2) / 2], pos: [-(POOL.innerX / 2 + POOL.wallThickness / 2), gcy, 0] },
  { half: [(POOL.innerX + POOL.wallThickness * 2) / 2, gh / 2, POOL.wallThickness / 2], pos: [0, gcy, POOL.innerZ / 2 + POOL.wallThickness / 2] },
  { half: [(POOL.innerX + POOL.wallThickness * 2) / 2, gh / 2, POOL.wallThickness / 2], pos: [0, gcy, -(POOL.innerZ / 2 + POOL.wallThickness / 2)] },
);
for (const c of cfg) physics.addStaticBox(c.half, c.pos);

// ---------- 1. 波浪场 ----------
console.log('\n[1] 波浪场');
wave.rebuild();
ok(isFinite(wave.heightAt(0, 0)), 'heightAt(0,0) 有限值 = ' + wave.heightAt(0, 0).toFixed(4));
let mn = 1e9, mx = -1e9;
for (let i = 0; i < 400; i++) { const h = wave.heightAt(Math.random() * 20 - 10, Math.random() * 12 - 6); mn = Math.min(mn, h); mx = Math.max(mx, h); }
ok(mx - mn > 0.05 && mx - mn < 2.5, `波高范围合理 min=${mn.toFixed(3)} max=${mx.toFixed(3)}`);
const before = wave.heightAt(3, 2);
wave.update(0.5);
ok(Math.abs(wave.heightAt(3, 2) - before) > 1e-4, '相位随时间推进');
const n = wave.normalAt(1, 1);
ok(Math.abs(n.length() - 1) < 1e-6, '水面法线为单位向量');

// ---------- 2. 内置物体模板 ----------
console.log('\n[2] 物体模板');
for (const id of ['ball', 'crate', 'barrel', 'board', 'ring', 'block']) {
  const t = createPrimitive(id, 1.2);
  ok(t.volume > 0 && isFinite(t.volume) && t.probes.length === 27 && t.size > 0,
    `${id}: 体积=${t.volume.toFixed(4)}m³ 尺寸=${t.size.toFixed(2)}m 探针=${t.probes.length}`);
}

// ---------- 3. 自定义网格 → 凸包 + 体积 ----------
console.log('\n[3] 导入网格处理');
{
  const geo = new THREE.TorusKnotGeometry(0.5, 0.16, 48, 12);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  const tpl = buildFloatingTemplate(mesh, 1.2);
  ok(tpl.volume > 0, `TorusKnot 体积 ${tpl.volume.toFixed(4)}`);
  ok(tpl.shape instanceof CANNON.ConvexPolyhedron || tpl.shape instanceof CANNON.Box, '碰撞体类型 = ' + tpl.shape.constructor.name);
  const bc = new THREE.Box3().setFromObject(tpl.root);
  const s = bc.getSize(new THREE.Vector3());
  ok(Math.max(s.x, s.y, s.z) > 1.1 && Math.max(s.x, s.y, s.z) < 1.3, '归一化尺寸 ≈ 1.2m → ' + Math.max(s.x, s.y, s.z).toFixed(3));
  const c = bc.getCenter(new THREE.Vector3());
  ok(c.length() < 0.02, '几何中心已对齐原点 → ' + c.length().toFixed(4));
}
{
  // 退化输入：极扁平面（体积接近 0）应走兜底
  const g = new THREE.PlaneGeometry(2, 2);
  const tpl = buildFloatingTemplate(new THREE.Mesh(g, new THREE.MeshStandardMaterial()), 1.2);
  ok(tpl.volume > 0 && isFinite(tpl.volume), '退化平面体积兜底 = ' + tpl.volume.toFixed(5));
}

// ---------- 4. 浮力平衡 ----------
console.log('\n[4] 浮力平衡（模拟 8 秒）');
const tpl = createPrimitive('crate', 0.8);
const e = physics.addBody({
  shape: tpl.shape, mass: tpl.volume * params.density * params.waterDensity,
  position: { x: 0, y: 3, z: 0 }, quaternion: new THREE.Quaternion(),
  volume: tpl.volume, probes: tpl.probes, size: tpl.size, mesh: null, seed: 1,
});
let impacts = 0, splashes = 0;
physics.onImpact = () => impacts++;
physics.onSplash = () => splashes++;
const dt = 1 / 60;
for (let i = 0; i < 480; i++) { wave.update(dt); physics.step(dt); }
const y = e.body.position.y;
ok(y > -0.15 && y < 0.35, `木箱稳定漂浮在 y=${y.toFixed(3)}（水面 0 附近）`);
ok(splashes >= 1, `入水水花事件触发 ${splashes} 次`);
ok(Math.abs(e.body.velocity.y) < 1.0, `竖直速度已收敛 = ${e.body.velocity.y.toFixed(3)}`);

// ---------- 5. 密度与浮沉 ----------
console.log('\n[5] 密度影响');
function settle(density, seconds = 6) {
  const t = createPrimitive('ball', 0.6);
  const b = physics.addBody({
    shape: t.shape, mass: t.volume * density * params.waterDensity,
    // 位置固定，避免随机落点导致的波浪相位差异让结果不可复现
    position: { x: 0, y: 2, z: 0 },
    quaternion: new THREE.Quaternion(), volume: t.volume, probes: t.probes, size: t.size, mesh: null, seed: 2,
  });
  // 物体稳定后仍会随浪上下起伏，取最后一秒的平均高度而不是某一瞬时值，
  // 否则断言会随采样时刻在阈值边缘反复横跳。
  const frames = Math.round(seconds * 60);
  const tailFrames = 60;
  let sum = 0, n = 0;
  for (let i = 0; i < frames; i++) {
    wave.update(dt); physics.step(dt);
    if (i >= frames - tailFrames) { sum += b.body.position.y; n++; }
  }
  const yy = sum / n;
  physics.remove(b);
  return yy;
}
const light = settle(0.25), heavy = settle(1.1);
// 理论值：球半径 r=0.252，密度 0.25 时浸没 25% 体积，球缺解 x²(3-x)/4=0.25 得
// 浸没深度 0.653r，球心应在水面下 0.347r ≈ -0.088。27 探针离散采样会带来几十毫米偏差，
// 因此判定标准取「球心浸没不超过 0.8r」——即明显还浮在水面上，而不是沉下去。
ok(light > -0.2, `轻物(0.25)漂浮 y=${light.toFixed(3)}（理论 ≈ -0.088）`);
ok(heavy < -1.0, `重物(1.1)下沉 y=${heavy.toFixed(3)}`);

// ---------- 6. 边界约束 ----------
console.log('\n[6] 池壁边界');
{
  const t = createPrimitive('ball', 0.6);
  const b = physics.addBody({
    shape: t.shape, mass: t.volume * 0.4 * params.waterDensity,
    position: { x: 0, y: 1.5, z: 0 }, quaternion: new THREE.Quaternion(),
    volume: t.volume, probes: t.probes, size: t.size, mesh: null, seed: 3,
  });
  let impacts2 = 0;
  b.body.addEventListener('collide', () => impacts2++);
  for (let i = 0; i < 600; i++) { b.body.applyForce(new CANNON.Vec3(60, 0, 0)); wave.update(dt); physics.step(dt); }
  ok(Math.abs(b.body.position.x) < POOL.innerX / 2 + 0.5,
    `强推 10 秒后仍在池内 x=${b.body.position.x.toFixed(2)}（池半宽 ${POOL.innerX / 2}）`);
  ok(impacts2 >= 1, `撞墙碰撞事件触发 ${impacts2} 次`);
  physics.remove(b);
}

// ---------- 7. 风的作用 ----------
console.log('\n[7] 风');
{
  params.windDirection = 0; params.windStrength = 10; params.waveHeight = 0;
  wave.rebuild();
  const t = createPrimitive('board', 1.2);
  const b = physics.addBody({
    shape: t.shape, mass: t.volume * 0.3 * params.waterDensity,
    position: { x: -6, y: 0.4, z: 0 }, quaternion: new THREE.Quaternion(),
    volume: t.volume, probes: t.probes, size: t.size, mesh: null, seed: 4,
  });
  const x0 = b.body.position.x;
  for (let i = 0; i < 480; i++) { wave.update(dt); physics.step(dt); }
  ok(b.body.position.x > x0 + 0.5, `风把浮板吹向下风处 Δx=${(b.body.position.x - x0).toFixed(2)}m`);
  physics.remove(b);
}

// ---------- 8. 水面/池底着色器注入（用 three 真实 shader 源码验证锚点） ----------
console.log('\n[8] 着色器注入');
{
  // 最小 DOM stub（泳池纹理用到 canvas）
  const ctx2d = { fillRect() {}, fillStyle: '' };
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };

  const { createWater } = await import('./src/water.js');
  const { createPool } = await import('./src/pool.js');

  const water = createWater(wave);
  ok(!!water.surface && !!water.material, '水面对象创建成功');
  const vsrc = THREE.ShaderLib.physical.vertexShader;
  const fsrc = THREE.ShaderLib.physical.fragmentShader;
  ok(vsrc.includes('#include <beginnormal_vertex>') && vsrc.includes('#include <begin_vertex>'), '顶点着色器锚点存在');
  ok(fsrc.includes('#include <color_fragment>'), '片元着色器锚点存在');

  const shader = { uniforms: {}, vertexShader: vsrc, fragmentShader: fsrc };
  water.material.onBeforeCompile(shader);
  ok(shader.vertexShader.includes('waveHeightAt(position.xz)'), '顶点位移已注入');
  ok(shader.vertexShader.includes('waveNormalAt(position.xz)'), '波面法线已注入');
  ok(!shader.vertexShader.includes('#include <begin_vertex>'), 'begin_vertex 已被替换（无重复定义 transformed）');
  ok(!shader.vertexShader.includes('#include <beginnormal_vertex>'), 'beginnormal_vertex 已被替换');
  ok(shader.fragmentShader.includes('vFoam'), '片元白沫已注入');
  ok(!!shader.uniforms.uWaveA && !!shader.uniforms.uPhase, '波参数 uniform 已绑定');
  // 括号配平的简单检查
  const bal = (s) => { let a = 0, b = 0; for (const c of s) { if (c === '{') a++; if (c === '}') a--; if (c === '(') b++; if (c === ')') b--; } return a === 0 && b === 0; };
  ok(bal(shader.vertexShader) && bal(shader.fragmentShader), '着色器括号配平');
  water.refresh();

  const scene2 = new THREE.Scene();
  const pool = createPool(scene2);
  ok(pool.colliders.length === 9, '泳池碰撞体 5(墙+底) + 4(隐形挡板) = ' + pool.colliders.length);
  ok(pool.colliders.every((c) => c.half.every((v) => v > 0)), '碰撞体尺寸均为正');
  const fs2 = THREE.ShaderLib.standard.fragmentShader;
  const vs2 = THREE.ShaderLib.standard.vertexShader;
  ok(fs2.includes('#include <dithering_fragment>'), '池底焦散锚点存在');
  const floorMat = pool.group.children[0].material;
  const sh2 = { uniforms: {}, vertexShader: vs2, fragmentShader: fs2 };
  floorMat.onBeforeCompile(sh2);
  ok(sh2.fragmentShader.includes('uTimeC'), '池底焦散已注入');
  ok(bal(sh2.fragmentShader), '池底着色器括号配平');
  pool.update(0.016);
}

// ---------- 9. 控制面板：三盏灯 + 路径 key + 按钮 ----------
console.log('\n[9] 控制面板');
{
  const makeEl = () => ({
    className: '', innerHTML: '', textContent: '', value: '', checked: false, type: '',
    min: 0, max: 0, step: 1, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { cs.forEach((c) => this.children.push(c)); },
    onclick: null, oninput: null,
  });
  globalThis.document = { createElement: () => makeEl() };

  const { createUI, GROUPS } = await import('./src/ui.js');
  const host = makeEl();
  const actions = [];
  const ui = createUI({
    params, host,
    onChange(k, v, tag, action) { if (action) actions.push(action); },
  });

  const stageGroups = GROUPS.filter((g) => g.id.startsWith('stage'));
  ok(stageGroups.length === 3, `灯光控制组 ${stageGroups.length} 个`);
  ok(stageGroups.every((g) => g.items.length >= 6), '每组至少 6 个可调项（开关/亮度/颜色/方位/距离/高度/阴影）');
  ok(host.children.length === GROUPS.length, `面板渲染 ${host.children.length}/${GROUPS.length} 组`);

  params.lights[1].intensity = 333;
  ok(params.lights[1].intensity === 333, '路径 key（lights.1.intensity）可读写');
  ui.set('lights.1.intensity', 210);
  ui.refresh();
  ok(true, 'ui.set / ui.refresh 不抛异常');

  // 找到“黄昏场景”按钮并点击
  const found = [];
  (function walk(n) {
    if (!n) return;
    if (n.textContent === '黄昏场景（突出灯光）') found.push(n);
    (n.children || []).forEach(walk);
  })(host);
  ok(found.length === 1, '黄昏预设按钮存在');
  if (found[0]) { found[0].onclick(); ok(actions.includes('dusk'), '按钮回传 dusk 动作'); }
}

console.log('\n' + (fail === 0 ? '全部通过 ✔' : `失败 ${fail} 项 ✘`));
process.exit(fail === 0 ? 0 : 1);
