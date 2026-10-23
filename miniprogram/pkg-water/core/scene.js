import * as THREE from '../lib/build/three.module.js';
import { WechatPlatform } from '../lib/src/WechatPlatform/index.js';
import { OrbitControls } from '../lib/examples/jsm/controls/OrbitControls.js';
import { params as defaultParams, POOL } from './config.js';
import { WaveField, createWater } from './water.js';
import { createPool } from './pool.js';
import { WaterPhysics } from './physics.js';
import { createPrimitive, PRIMITIVE_TYPES } from './objects.js';
import { AudioEngine } from './audio.js';

const QUALITY = {
  low:  { pixelRatio: 1.0, shadow: false, shadowMap: 0,    antialias: false },
  mid:  { pixelRatio: 1.5, shadow: true,  shadowMap: 1024, antialias: false },
  high: { pixelRatio: 2.0, shadow: true,  shadowMap: 2048, antialias: true  },
};

// 同屏物体上限。每个物体每帧要跑 32 次水面采样做浮力，40 个已经是这台机器的极限
const MAX_OBJECTS = 40;

/**
 * 3D 场景封装。页面只负责 UI，所有 three / 物理逻辑都在这里。
 */
export class WaterScene {
  constructor({ canvas, width, height, dpr, quality = 'mid', onEvent }) {
    this.canvas = canvas;
    // 小程序画布没有 CSS 像素尺寸的概念，布局尺寸要由页面量出来传进来。
    // three 的 setSize 会按 pixelRatio 自动算缓冲区，所以这里必须传布局尺寸，
    // 传 canvas.width 会导致再乘一次 pixelRatio，画面被放大裁切。
    this.viewW = Math.max(1, Math.floor(width || canvas.width || 1));
    this.viewH = Math.max(1, Math.floor(height || canvas.height || 1));
    this.dpr = Math.min(dpr || 2, 2);
    this.quality = QUALITY[quality] ? quality : 'mid';
    this.q = QUALITY[this.quality];
    this.onEvent = onEvent || (() => {});
    this.params = JSON.parse(JSON.stringify(defaultParams));
    this.objects = [];
    this.mode = 'drop';          // 'drop' | 'view' | 'orbit'
    this.dropType = 'random';    // 点水面时丢什么
    this.running = false;
    this._grab = null;
    this._lastT = 0;

    this.platform = new WechatPlatform(canvas);
    THREE.PLATFORM.set(this.platform);

    this._initRenderer();
    this._initScene();
    this._initPhysics();
    this._initWater();
    this._initLights();
    this._initControls();

    this.audio = new AudioEngine(this.params);
    this.physics.onImpact = (e) => this.audio.impact(e.strength, !e.wet);
    this.physics.onSplash = (e) => this.audio.splash(e.strength);
  }

  /* ------------------------------ 初始化 ------------------------------ */

  _initRenderer() {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.q.antialias,
      alpha: false,
    });
    renderer.setPixelRatio(Math.min(this.q.pixelRatio, this.dpr, 2)); // 微信建议不要超过 2
    renderer.setSize(this.viewW, this.viewH, false);
    // three 0.133 用 outputEncoding（0.152+ 才改叫 outputColorSpace）
    if (THREE.sRGBEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
    // 与网页版保持一致：用物理光照单位，灯光强度可直接沿用网页版数值
    renderer.physicallyCorrectLights = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = this.params.exposure;
    renderer.shadowMap.enabled = this.q.shadow;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xcfe6f5);
    this.scene.fog = new THREE.Fog(0xcfe6f5, 45, 110);

    const aspect = this.viewW / this.viewH;
    this.camera = new THREE.PerspectiveCamera(52, aspect, 0.1, 300);
    this.camera.position.set(17, 11, 20);
    this.camera.lookAt(0, 0, 0);
  }

  _initPhysics() {
    this.waveField = new WaveField(this.params);
    this.physics = new WaterPhysics(this.params, this.waveField);
    const pool = createPool(this.scene, this.quality);
    this.pool = pool;
    for (const c of pool.colliders) {
      this.physics.addStaticBox(c.half, c.pos);
    }
  }

  _initWater() {
    this.water = createWater(this.waveField, this.quality);
    this.scene.add(this.water.group);
  }

  _initLights() {
    // 太阳
    const dir = new THREE.DirectionalLight(0xfff4e0, 2.7);
    dir.castShadow = this.q.shadow;
    if (this.q.shadow) {
      dir.shadow.mapSize.set(this.q.shadowMap, this.q.shadowMap);
      dir.shadow.bias = -0.0006;
      dir.shadow.normalBias = 0.035;
      const sc = dir.shadow.camera;
      sc.left = -20; sc.right = 20; sc.top = 20; sc.bottom = -20;
      sc.near = 1; sc.far = 160;
    }
    this.scene.add(dir, dir.target);
    this.dirLight = dir;

    this.scene.add(new THREE.HemisphereLight(0xcfe9ff, 0x2f5d7a, 0.45));

    // 3 盏可控舞台灯
    this.lampGroup = new THREE.Group();
    this.lamps = this.params.lights.map((_, i) => this._makeLamp(i));
    this.scene.add(this.lampGroup);
    this.updateSun();
    this.updateLights();
  }

  _makeLamp(i) {
    const p = this.params.lights[i];
    const light = new THREE.PointLight(new THREE.Color(p.color), p.on ? p.intensity : 0, 60, 2);
    // 可见灯泡
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 12, 10),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(p.color) }),
    );
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.055, 1, 8),
      new THREE.MeshStandardMaterial({ color: 0x51606b, roughness: 0.6, metalness: 0.3 }),
    );
    this.lampGroup.add(light, bulb, pole);
    return { light, bulb, pole };
  }

  _initControls() {
    const controls = new OrbitControls(this.camera, this.canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 6;
    controls.maxDistance = 60;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.target.set(0, 0, 0);
    controls.enabled = false;    // 默认投放模式
    this.controls = controls;
  }

  /* ------------------------------ 交互 ------------------------------ */

  setMode(mode) {
    this.mode = mode;
    // 环绕 = 视角模式 + 自动转圈，适合放在桌上当动态摆件 / 录屏
    this.controls.enabled = (mode === 'view' || mode === 'orbit');
    this.controls.autoRotate = (mode === 'orbit');
    this.controls.autoRotateSpeed = 0.6;
    if (!this.controls.enabled) this._grab = null;
  }

  setDropType(t) {
    this.dropType = t || 'random';
  }

  /** 页面把 touch 事件转发进来；视角模式交给 OrbitControls，投放模式自己处理 */
  handleTouch(type, e) {
    if (type === 'tap') {
      if (this.mode === 'drop') this._tapDrop(e);
      return;
    }
    if (this.controls.enabled) {
      this.platform.dispatchTouchEvent(this._toTouchEvent(type, e));
      return;
    }
    // 投放模式：按住拖动已存在的物体
    if (type === 'touchstart') this._tryGrab(e);
    else if (type === 'touchmove' && this._grab) this._moveGrab(e);
    else if (type === 'touchend') this._grab = null;
  }

  _toTouchEvent(type, e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
    const single = [{ pageX: t.x || t.pageX || 0, pageY: t.y || t.pageY || 0, identifier: 0 }];
    return {
      type,
      touches: e.touches ? e.touches.map((x) => ({ pageX: x.x, pageY: x.y, identifier: x.identifier })) : single,
      changedTouches: e.changedTouches
        ? e.changedTouches.map((x) => ({ pageX: x.x, pageY: x.y, identifier: x.identifier }))
        : single,
      timeStamp: e.timeStamp || Date.now(),
    };
  }

  /** 屏幕坐标 → NDC */
  _ndc(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
    const x = (t.x !== undefined ? t.x : t.clientX) || 0;
    const y = (t.y !== undefined ? t.y : t.clientY) || 0;
    // 触点坐标是布局像素，必须除以布局尺寸（不是缓冲区尺寸）
    return new THREE.Vector2(
      (x / this.viewW) * 2 - 1,
      -(y / this.viewH) * 2 + 1,
    );
  }

  _pick(e) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(this._ndc(e), this.camera);
    const hits = ray.intersectObjects(this.scene.children, true);
    return hits.length ? hits[0] : null;
  }

  _tapDrop(e) {
    const hit = this._pick(e);
    if (hit && hit.object && hit.object.name === 'waterSurface') {
      this.spawn(this.dropType, hit.point.x, hit.point.z);
      this.onEvent({ type: 'spawned' });
    }
  }

  _removeOldest() {
    const ent = this.objects.shift();
    if (!ent) return;
    if (ent.mesh) this.scene.remove(ent.mesh);
    this.physics.remove(ent);
    // bodyIndex 必须跟着重排，否则点击拾取会抓到隔壁物体
    this.objects.forEach((o, i) => { if (o.mesh) o.mesh.userData.bodyIndex = i; });
  }

  /** 「推一把」：给所有漂浮物一个随机冲量，像有人踹了一脚泳池 */
  kick(dv = 2.2) {
    this.physics.kick(dv);
    if (this.audio) this.audio.splash(0.7);
  }

  _tryGrab(e) {
    const hit = this._pick(e);
    if (!hit) return;
    let o = hit.object;
    while (o && !o.userData.bodyIndex && o.parent) o = o.parent;
    const ent = o && this.objects[o.userData.bodyIndex];
    if (ent) this._grab = { ent, plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.params.waterLevel - 0.4) };
  }

  _moveGrab(e) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(this._ndc(e), this.camera);
    const p = new THREE.Vector3();
    if (!ray.ray.intersectPlane(this._grab.plane, p)) return;
    const b = this._grab.ent.body;
    b.velocity.set((p.x - b.position.x) * 8, (p.y - b.position.y) * 8, (p.z - b.position.z) * 8);
    b.angularVelocity.set(0, 0, 0);
    b.wakeUp();
  }

  /* ------------------------------ 物体 ------------------------------ */

  /** @param type 'ball' | 'duck' | ... | 'random' */
  spawn(type, x, z) {
    // 连点很爽，但物体无限堆会掉帧：满了就把最早的捞走
    if (this.objects.length >= MAX_OBJECTS) this._removeOldest();
    const t = type === 'random' || type === undefined
      ? PRIMITIVE_TYPES[Math.floor(Math.random() * PRIMITIVE_TYPES.length)].id
      : type;
    const tpl = createPrimitive(t, this.params.objectScale);
    const mx = POOL.innerX / 2 - 1.5;
    const mz = POOL.innerZ / 2 - 1.5;
    const px = x === undefined ? (Math.random() * 2 - 1) * mx : Math.max(-mx, Math.min(mx, x));
    const pz = z === undefined ? (Math.random() * 2 - 1) * mz : Math.max(-mz, Math.min(mz, z));

    // createPrimitive 返回的是 root（一个 Group），不是 mesh
    const mesh = tpl.root;
    mesh.traverse((o) => {
      if (o.isMesh) { o.castShadow = this.q.shadow; o.receiveShadow = this.q.shadow; }
    });
    this.scene.add(mesh);

    const idx = this.objects.length;
    mesh.userData.bodyIndex = idx;

    const ent = this.physics.addBody({
      shape: tpl.shape,
      mass: tpl.volume * this.params.density * this.params.waterDensity,
      position: { x: px, y: this.params.waterLevel + Math.max(1.6, tpl.size) + 0.5, z: pz },
      quaternion: new THREE.Quaternion(),
      volume: tpl.volume,
      probes: tpl.probes,
      size: tpl.size,
      mesh,
      seed: Math.random() * 10,
      upright: tpl.upright,
    });
    ent.mesh = mesh;
    this.objects.push(ent);
    return ent;
  }

  clearObjects() {
    for (const e of this.objects) {
      if (e.mesh) {
        this.scene.remove(e.mesh);
        e.mesh.traverse && e.mesh.traverse((o) => {
          if (o.isMesh) { o.geometry && o.geometry.dispose(); }
        });
      }
      this.physics.remove(e);
    }
    this.objects = [];
  }

  get count() { return this.objects.length; }

  /* ------------------------------ 参数更新 ------------------------------ */

  updateSun() {
    const p = this.params;
    const az = THREE.MathUtils.degToRad(p.sunAzimuth);
    const el = THREE.MathUtils.degToRad(p.sunElevation);
    const dir = new THREE.Vector3(
      Math.cos(el) * Math.cos(az),
      Math.sin(el),
      Math.cos(el) * Math.sin(az),
    );
    this.dirLight.position.copy(dir).multiplyScalar(70);
    this.dirLight.target.position.set(0, 0, 0);
    const elev = Math.max(0, Math.sin(el));
    this.dirLight.intensity = 0.7 + 2.4 * elev;
    this.dirLight.color.setHSL(0.09, 0.35 * (1 - elev * 0.6) + 0.08, 0.62 + 0.18 * elev);
  }

  updateLights() {
    this.params.lights.forEach((p, i) => {
      const L = this.lamps[i];
      if (!L) return;
      const a = THREE.MathUtils.degToRad(p.azimuth);
      const x = Math.cos(a) * p.radius;
      const z = Math.sin(a) * p.radius;
      L.light.color.set(p.color);
      L.light.intensity = p.on ? p.intensity : 0;
      L.light.position.set(x, p.height, z);
      L.bulb.material.color.set(p.color);
      L.bulb.material.opacity = p.on ? 1 : 0.25;
      L.bulb.position.set(x, p.height, z);
      L.pole.position.set(x, p.height - 0.5, z);
      L.pole.scale.y = Math.max(0.2, p.height);
    });
  }

  /** 波/风参数变了 */
  refreshWave() {
    this.waveField.rebuild();
    this.water.refresh();
    this.physics.wakeAll();
    this.audio.update();
  }

  /** 一键预设：把一组风浪/水体参数整体套上去 */
  applyPreset(obj) {
    Object.assign(this.params, obj);
    this.refreshWave();
  }

  /** 水体外观变了 */
  refreshWater() {
    this.water.refresh();
    this.physics.wakeAll();
  }

  refreshPhysics() { this.physics.refresh(); }

  applyDensity(d) { this.physics.applyDensity(d); }

  setExposure(v) { this.renderer.toneMappingExposure = v; }

  setShadows(on) {
    this.renderer.shadowMap.enabled = on && this.q.shadow;
    this.dirLight.castShadow = on && this.q.shadow;
  }

  /**
   * 画布尺寸变了（比如控制面板展开把画布挤矮了）要同步渲染器与相机，
   * 否则画面会被拉伸变形。
   */
  resize(w, h) {
    if (!w || !h) return;
    const nw = Math.max(1, Math.floor(w));
    const nh = Math.max(1, Math.floor(h));
    if (nw === this.viewW && nh === this.viewH) return;
    this.viewW = nw;
    this.viewH = nh;
    this.renderer.setSize(nw, nh, false);
    this.camera.aspect = nw / nh;
    this.camera.updateProjectionMatrix();
  }

  /* ------------------------------ 主循环 ------------------------------ */

  start() {
    if (this.running) return;
    this.running = true;
    this._lastT = Date.now();
    const loop = () => {
      if (!this.running) return;
      this._frame();
      this.canvas.requestAnimationFrame(loop);
    };
    this.canvas.requestAnimationFrame(loop);
  }

  stop() { this.running = false; }

  _frame() {
    const now = Date.now();
    let dt = (now - this._lastT) / 1000;
    this._lastT = now;
    dt = Math.min(dt, 1 / 20);      // 掉帧时钳制，避免物理炸开

    if (!this.params.paused) {
      this.waveField.update(dt);
      this.physics.step(dt);
      for (const e of this.objects) {
        if (e.mesh) {
          e.mesh.position.copy(e.body.position);
          e.mesh.quaternion.copy(e.body.quaternion);
        }
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.stop();
    this.clearObjects();
    this.audio.dispose();
    this.controls.dispose && this.controls.dispose();
    this.water.dispose && this.water.dispose();
    this.pool.dispose && this.pool.dispose();
    this.renderer.dispose();
    THREE.PLATFORM.dispose();
  }
}
