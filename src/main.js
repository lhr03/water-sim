import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as CANNON from 'cannon-es';

import { params, POOL } from './config.js';
import { WaveField, createWater } from './water.js';
import { createPool } from './pool.js';
import { WaterPhysics } from './physics.js';
import { createUI } from './ui.js';
import { AudioEngine } from './audio.js';
import { loadModelFile, buildFloatingTemplate, createPrimitive, PRIMITIVE_TYPES } from './objects.js';

/* ============================== 基础设施 ============================== */
// 出错时把原因显示出来，避免只看到黑屏
function showFatal(msg) {
  const el = document.getElementById('loading');
  if (!el) return;
  el.style.display = 'flex';
  el.innerHTML = '<div style="max-width:70vw;text-align:center;line-height:1.8">'
    + '<div style="font-size:15px;font-weight:700;color:#0f4c81;margin-bottom:6px">启动失败</div>'
    + '<div style="font-size:12.5px">' + String(msg) + '</div>'
    + '<div style="font-size:12px;margin-top:10px;color:#7b8fa1">请确认显卡支持 WebGL2，并通过 start.bat（本地服务器）打开本页面</div>'
    + '</div>';
}
window.addEventListener('error', (e) => showFatal(e.message || e.error));
window.addEventListener('unhandledrejection', (e) => showFatal((e.reason && e.reason.message) || e.reason));

const container = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = params.exposure;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xd6eaf7, 55, 190);

const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 3000);
const HOME_POS = new THREE.Vector3(0, 9.5, 25);
const HOME_TARGET = new THREE.Vector3(0, 0, 0);
camera.position.copy(HOME_POS);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.copy(HOME_TARGET);
controls.minDistance = 4;
controls.maxDistance = 80;
controls.maxPolarAngle = 1.52;

/* ============================== 天空 / 光影 ============================== */
const sky = new Sky();
sky.scale.setScalar(2000);
sky.material.uniforms.turbidity.value = 3.5;
sky.material.uniforms.rayleigh.value = 1.6;
sky.material.uniforms.mieCoefficient.value = 0.005;
sky.material.uniforms.mieDirectionalG.value = 0.82;
scene.add(sky);

const envScene = new THREE.Scene();
const skyEnv = new Sky();
skyEnv.scale.setScalar(2000);
skyEnv.material.uniforms.turbidity.value = 3.5;
skyEnv.material.uniforms.rayleigh.value = 1.6;
skyEnv.material.uniforms.mieCoefficient.value = 0.005;
skyEnv.material.uniforms.mieDirectionalG.value = 0.82;
envScene.add(skyEnv);

const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
let envRT = null;

const sunDir = new THREE.Vector3();
const dirLight = new THREE.DirectionalLight(0xfff4e0, 2.7);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
const sc = dirLight.shadow.camera;
sc.left = -20; sc.right = 20; sc.top = 18; sc.bottom = -18; sc.near = 1; sc.far = 160;
dirLight.shadow.bias = -0.0006;
dirLight.shadow.normalBias = 0.035;
scene.add(dirLight, dirLight.target);

const hemi = new THREE.HemisphereLight(0xcfe9ff, 0x2f5d7a, 0.45);
scene.add(hemi);

let envDirty = true;
let envTimer = 0;

function updateSun() {
  const phi = THREE.MathUtils.degToRad(90 - params.sunElevation);
  const theta = THREE.MathUtils.degToRad(params.sunAzimuth);
  sunDir.setFromSphericalCoords(1, phi, theta);
  sky.material.uniforms.sunPosition.value.copy(sunDir);
  skyEnv.material.uniforms.sunPosition.value.copy(sunDir);
  dirLight.position.copy(sunDir).multiplyScalar(70);
  dirLight.target.position.set(0, 0, 0);
  // 太阳越低，光越暖越弱
  const elev = THREE.MathUtils.clamp(params.sunElevation / 60, 0.15, 1.2);
  dirLight.intensity = 0.7 + 2.4 * elev;
  dirLight.color.setHSL(0.09, 0.35 * (1 - elev * 0.6) + 0.08, 0.62 + 0.18 * elev);
  envDirty = true;
}

function updateEnv() {
  if (!envDirty) return;
  envDirty = false;
  const rt = pmrem.fromScene(envScene, 0.0, 0.5, 20000);
  if (envRT) envRT.dispose();
  envRT = rt;
  scene.environment = rt.texture;
  water.setEnvironment(rt.texture);
}

/* ============================== 3 盏可控制舞台灯 ============================== */
function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.22, 'rgba(255,255,255,0.5)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const glowTex = makeGlowTexture();

const stageLights = [];
const poleMat = new THREE.MeshStandardMaterial({ color: 0x2b3a48, metalness: 0.85, roughness: 0.32 });
for (let i = 0; i < 3; i++) {
  const p = params.lights[i];
  const light = new THREE.PointLight(new THREE.Color(p.color), 0, 48, 2);
  light.castShadow = false;
  scene.add(light);

  const fixture = new THREE.Group();
  const bulbMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(p.color) });
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.15, 18, 14), bulbMat);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex,
    color: new THREE.Color(p.color),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.9,
  }));
  halo.scale.setScalar(2.4);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 1, 8), poleMat);
  pole.castShadow = false;
  fixture.add(bulb, halo, pole);
  scene.add(fixture);
  stageLights.push({ light, fixture, bulb, halo, pole, bulbMat });
}

function updateLights() {
  for (let i = 0; i < 3; i++) {
    const p = params.lights[i];
    const L = stageLights[i];
    if (!L) continue;
    const a = THREE.MathUtils.degToRad(p.azimuth);
    const x = Math.cos(a) * p.radius;
    const z = Math.sin(a) * p.radius;
    const y = params.waterLevel + p.height;

    L.light.position.set(x, y, z);
    L.light.color.set(p.color);
    L.light.intensity = p.on ? p.intensity : 0;

    const wantShadow = !!p.shadows && params.shadows && p.on;
    if (wantShadow !== L.light.castShadow) {
      L.light.castShadow = wantShadow;
      if (wantShadow) {
        L.light.shadow.mapSize.set(1024, 1024);
        L.light.shadow.bias = -0.0025;
        L.light.shadow.normalBias = 0.03;
        L.light.shadow.camera.near = 0.3;
        L.light.shadow.camera.far = 46;
      }
    }

    L.fixture.position.set(x, y, z);
    L.bulbMat.color.set(p.color);
    L.halo.material.color.set(p.color);
    L.halo.material.opacity = p.on ? 0.9 : 0.12;
    L.bulb.visible = true;

    // 灯杆：从灯往下接到池边甲板
    const topY = Math.max(0.25, y - POOL.wallHeight);
    L.pole.scale.y = topY;
    L.pole.position.y = -topY / 2 - 0.14;
  }
}

/* ============================== 水 / 池 / 物理 ============================== */
const waveField = new WaveField(params);
const water = createWater(waveField);
scene.add(water.group);

const pool = createPool(scene);

const physics = new WaterPhysics(params, waveField);
for (const c of pool.colliders) physics.addStaticBox(c.half, c.pos);

const audio = new AudioEngine(params);
physics.onImpact = (info) => audio.playImpact(info);
physics.onSplash = (info) => {
  audio.playSplash(info);
  ripple(info.x, info.z, info.strength);
};

/* -------- 入水涟漪（视觉小水花） -------- */
const rippleGeo = new THREE.RingGeometry(0.12, 0.42, 28);
rippleGeo.rotateX(-Math.PI / 2);
const ripples = [];
function ripple(x, z, strength) {
  const m = new THREE.Mesh(rippleGeo, new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false,
  }));
  m.position.set(x, waveField.heightAt(x, z) + 0.02, z);
  m.scale.setScalar(0.6 + strength * 1.2);
  m.renderOrder = 3;
  scene.add(m);
  ripples.push({ mesh: m, t: 0, life: 0.85, s0: m.scale.x });
  if (ripples.length > 24) {
    const old = ripples.shift();
    scene.remove(old.mesh); old.mesh.material.dispose();
  }
}
function updateRipples(dt) {
  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i];
    r.t += dt;
    const k = r.t / r.life;
    if (k >= 1) {
      scene.remove(r.mesh); r.mesh.material.dispose(); ripples.splice(i, 1); continue;
    }
    r.mesh.scale.setScalar(r.s0 * (1 + k * 3.2));
    r.mesh.material.opacity = 0.75 * (1 - k);
  }
}

/* ============================== 物体库 / 投放 ============================== */
const library = [];      // {name, tpl}
const entryByRoot = new Map();
const pickables = [];
let currentLibIndex = 0;

for (const p of PRIMITIVE_TYPES) {
  library.push({ name: p.label, tpl: createPrimitive(p.id, 1.2), builtin: p.id });
}

const libSelect = document.getElementById('libSelect');
function refreshLibUI() {
  libSelect.innerHTML = '';
  library.forEach((it, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = it.name;
    libSelect.appendChild(o);
  });
  libSelect.value = String(currentLibIndex);
}
libSelect.onchange = () => { currentLibIndex = parseInt(libSelect.value, 10) || 0; };
refreshLibUI();

function spawn(x, z, libIndex = currentLibIndex, yOffset = null) {
  const item = library[libIndex] || library[0];
  const tpl = item.tpl;
  const root = tpl.root.clone(true);
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  const y = yOffset !== null ? yOffset : params.waterLevel + Math.max(1.6, tpl.size) + 0.4 + Math.random() * 0.8;
  const mass = Math.max(0.08, tpl.volume * params.density * params.waterDensity);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    (Math.random() - 0.5) * 0.8, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.8));

  const entry = physics.addBody({
    shape: tpl.shape,
    mass,
    position: { x, y, z },
    quaternion: q,
    volume: tpl.volume,
    probes: tpl.probes,
    size: tpl.size,
    mesh: root,
    seed: Math.random() * 10,
  });
  entry.libIndex = libIndex;
  entryByRoot.set(root, entry);
  pickables.push(root);
  scene.add(root);
  updateCount();
  return entry;
}

function spawnRandom(n = 1, libIndex = currentLibIndex) {
  const mx = POOL.innerX / 2 - 1.6, mz = POOL.innerZ / 2 - 1.6;
  for (let i = 0; i < n; i++) {
    spawn((Math.random() * 2 - 1) * mx, (Math.random() * 2 - 1) * mz, libIndex);
  }
}

function clearAll() {
  physics.clear();
  for (const r of pickables) scene.remove(r);
  pickables.length = 0;
  entryByRoot.clear();
  updateCount();
}

function updateCount() {
  document.getElementById('sCount').textContent = String(physics.bodies.length);
}

/* ============================== 交互：投放 / 拖动 ============================== */
let mode = 'drop';   // drop | orbit
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const waterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hitPoint = new THREE.Vector3();
let dragging = null;
let dragged = false;

const btnMode = document.getElementById('btnMode');
function setMode(m) {
  mode = m;
  if (m === 'drop') {
    btnMode.textContent = '投放模式';
    btnMode.classList.add('primary');
    controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  } else {
    btnMode.textContent = '视角模式';
    btnMode.classList.remove('primary');
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  }
}
btnMode.onclick = () => setMode(mode === 'drop' ? 'orbit' : 'drop');
setMode('drop');

function setPointer(e) {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (mode !== 'drop' || e.button !== 0) return;
  setPointer(e);
  raycaster.setFromCamera(pointer, camera);

  // 1) 抓已有物体
  if (pickables.length) {
    const hits = raycaster.intersectObjects(pickables, true);
    if (hits.length) {
      let o = hits[0].object;
      while (o && !entryByRoot.has(o)) o = o.parent;
      if (o) {
        const entry = entryByRoot.get(o);
        dragging = { entry, y: entry.body.position.y };
        dragPlane.constant = -Math.max(entry.body.position.y, params.waterLevel + 0.3);
        entry.body.wakeUp();
        entry.body.allowSleep = false;
        controls.enabled = false;
        dragged = false;
        return;
      }
    }
  }

  // 2) 点到水面 → 在该处投放
  waterPlane.constant = -params.waterLevel;
  if (raycaster.ray.intersectPlane(waterPlane, hitPoint)) {
    const mx = POOL.innerX / 2 - 0.9, mz = POOL.innerZ / 2 - 0.9;
    const x = THREE.MathUtils.clamp(hitPoint.x, -mx, mx);
    const z = THREE.MathUtils.clamp(hitPoint.z, -mz, mz);
    spawn(x, z);
  }
});

window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  setPointer(e);
  dragged = true;
});
window.addEventListener('pointerup', () => {
  if (dragging) {
    dragging.entry.body.allowSleep = true;
    dragging = null;
    controls.enabled = true;
  }
});

const DRAG_TARGET = new THREE.Vector3();
function updateDrag() {
  if (!dragging) return;
  const b = dragging.entry.body;
  raycaster.setFromCamera(pointer, camera);
  if (!raycaster.ray.intersectPlane(dragPlane, DRAG_TARGET)) return;
  const k = 26 * b.mass, c = 7 * b.mass;
  b.applyForce(new CANNON.Vec3(
    (DRAG_TARGET.x - b.position.x) * k - b.velocity.x * c,
    (DRAG_TARGET.y - b.position.y) * k * 0.7 - b.velocity.y * c,
    (DRAG_TARGET.z - b.position.z) * k - b.velocity.z * c,
  ));
  b.wakeUp();
}

/* ============================== 越界回收 ============================== */
function recycle() {
  const limX = POOL.innerX / 2 + 6, limZ = POOL.innerZ / 2 + 6;
  for (let i = physics.bodies.length - 1; i >= 0; i--) {
    const e = physics.bodies[i];
    const p = e.body.position;
    if (Math.abs(p.x) > limX || Math.abs(p.z) > limZ || p.y < -POOL.depth - 8 || p.y > 60) {
      scene.remove(e.mesh);
      const k = pickables.indexOf(e.mesh);
      if (k >= 0) pickables.splice(k, 1);
      entryByRoot.delete(e.mesh);
      physics.remove(e);
      updateCount();
    }
  }
}

/* ============================== 模型导入 ============================== */
const fileInput = document.getElementById('fileInput');
document.getElementById('btnImport').onclick = () => fileInput.click();
fileInput.onchange = () => { importFiles(fileInput.files); fileInput.value = ''; };

const dropmask = document.getElementById('dropmask');
window.addEventListener('dragover', (e) => { e.preventDefault(); dropmask.classList.add('show'); });
window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) dropmask.classList.remove('show'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropmask.classList.remove('show');
  if (e.dataTransfer && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
});

async function importFiles(files) {
  for (const f of files) {
    try {
      toast(`正在解析 ${f.name} …`);
      const obj = await loadModelFile(f);
      const tpl = buildFloatingTemplate(obj, params.objectScale);
      library.push({ name: f.name, tpl });
      currentLibIndex = library.length - 1;
      refreshLibUI();
      toast(`已导入 ${f.name}，点击水面即可投放`);
    } catch (err) {
      console.error(err);
      toast(`导入失败：${f.name}（${err.message || '未知错误'}）`);
    }
  }
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ============================== 工具栏 ============================== */
document.getElementById('btnDropOne').onclick = () => {
  setMode('drop');
  spawnRandom(1, currentLibIndex);
};
document.getElementById('btnDrop5').onclick = () => {
  setMode('drop');
  spawnRandom(5, currentLibIndex);
};
document.getElementById('btnClear').onclick = () => { clearAll(); toast('已清空所有漂浮物'); };
const btnPause = document.getElementById('btnPause');
btnPause.onclick = () => {
  params.paused = !params.paused;
  btnPause.textContent = params.paused ? '继续' : '暂停';
  btnPause.classList.toggle('on', params.paused);
};
document.getElementById('btnView').onclick = () => {
  camera.position.copy(HOME_POS);
  controls.target.copy(HOME_TARGET);
  controls.update();
};
document.getElementById('hintClose').onclick = () => {
  document.getElementById('hint').style.display = 'none';
};

/* ============================== 场景预设 ============================== */
function applyPreset(kind) {
  if (kind === 'dusk') {
    params.sunAzimuth = 302;
    params.sunElevation = 5.5;
    params.exposure = 1.45;
    params.bloomStrength = 0.5;
    for (const l of params.lights) { l.on = true; l.intensity = Math.max(l.intensity, 260); }
    toast('已切到黄昏 · 三盏灯的效果此时最明显');
  } else {
    params.sunAzimuth = 135;
    params.sunElevation = 38;
    params.exposure = 1.05;
    params.bloomStrength = 0.22;
    for (const l of params.lights) { l.intensity = 90; }
    toast('已恢复白天光照');
  }
  renderer.toneMappingExposure = params.exposure;
  if (bloomPass) bloomPass.strength = params.bloomStrength;
  updateSun();
  updateLights();
  ui.refresh();
}

/* ============================== 控制面板 ============================== */
const ui = createUI({
  params,
  host: document.getElementById('panel'),
  onChange(key, value, tag, action) {
    switch (tag) {
      case 'wave':
        waveField.rebuild();
        water.refresh();
        physics.wakeAll();
        audio.markDirty(); audio.update();
        break;
      case 'water':
        water.refresh();
        physics.wakeAll();
        updateLights();
        break;
      case 'physics':
        physics.refresh();
        break;
      case 'density':
        physics.applyDensity(params.density);
        break;
      case 'sun':
        updateSun();
        break;
      case 'lights':
        updateLights();
        break;
      case 'action':
        applyPreset(action);
        break;
      case 'audio':
        if (key === 'soundOn' && value) {
          audio.init();
          toast('声音已开启（海浪声需要一点时间淡入）');
        }
        audio.applyVolumes();
        break;
      case 'render':
        if (key === 'exposure') renderer.toneMappingExposure = value;
        if (key === 'shadows') {
          renderer.shadowMap.enabled = value;
          dirLight.castShadow = value;
          scene.traverse((o) => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
          updateLights();
        }
        if (key === 'bloomStrength' && bloomPass) bloomPass.strength = value;
        break;
    }
  },
});

/* ============================== 后处理 ============================== */
let composer = null, bloomPass = null;
function setupComposer() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    params.bloomStrength, 0.6, 0.82);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  composer.setSize(window.innerWidth, window.innerHeight);
}
setupComposer();

/* ============================== 主循环 ============================== */
const sFps = document.getElementById('sFps');
const sWave = document.getElementById('sWave');
let last = performance.now();
let fpsAcc = 0, fpsFrames = 0, recycleTimer = 0;

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (!params.paused) {
    waveField.update(dt);
    updateDrag();
    physics.step(dt);
    physics.syncMeshes();
    pool.update(dt);
    updateRipples(dt);

    recycleTimer += dt;
    if (recycleTimer > 0.5) { recycleTimer = 0; recycle(); }

    envTimer += dt;
    if (envDirty && envTimer > 0.2) { envTimer = 0; updateEnv(); }
  }

  controls.update();

  if (params.bloom && composer) composer.render();
  else renderer.render(scene, camera);

  fpsAcc += dt; fpsFrames++;
  if (fpsAcc >= 0.5) {
    sFps.textContent = Math.round(fpsFrames / fpsAcc);
    fpsAcc = 0; fpsFrames = 0;
    sWave.textContent = waveField.heightAt(0, 0).toFixed(2);
  }
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  if (composer) composer.setSize(w, h);
}
window.addEventListener('resize', onResize);

/* ============================== 启动 ============================== */
updateSun();
updateEnv();
water.refresh();
physics.refresh();
updateLights();

// 预置一批物体（集中在中央，打开就能看到互相碰撞）
function spawnCluster(n, libIndex, radius = 4.5) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius;
    spawn(Math.cos(a) * r * 1.3, Math.sin(a) * r * 0.75, libIndex);
  }
}
spawnCluster(4, 0, 5.0);
spawnCluster(3, 1, 4.0);
spawnCluster(2, 3, 4.5);
updateCount();

document.getElementById('loading').style.display = 'none';
requestAnimationFrame(animate);

// 首次点击任何位置时准备好音频上下文（浏览器策略要求）
window.addEventListener('pointerdown', function once() {
  if (params.soundOn) audio.init();
  window.removeEventListener('pointerdown', once);
});

window.__sim = { params, physics, waveField, spawn, spawnRandom, clearAll };
