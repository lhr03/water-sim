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

/* 石灯笼的石材与熄灭时的灯芯颜色 */
const STONE_ON = new THREE.Color(0xa9a29a);
const GLOW_OFF = new THREE.Color(0x3a3630);
const _tmpColor = new THREE.Color();

/**
 * 火袋（灯室）中心离灯座底面的高度，单位米。
 * 高度滑块调的是「火袋离地多高」，所以整盏灯按 FIREBOX_Y 等比缩放，
 * 点光源也必须正好落在这个高度上。这个常量同时被 updateLights 和自检引用，
 * 以前在三个地方各写了一遍 1.34，改结构时很容易漏掉一处。
 */
export const FIREBOX_Y = 1.19;

/**
 * 石灯笼该站在哪儿。
 *
 * 直接按 (cos, sin) * radius 摆会出事：方位 165°、半径 10.5 时落点 x=-10.1、z=2.7，
 * 落在水池正上方——一盏石灯悬在水面中央。
 * 所以先沿方位找到池口外沿，再把 outset（离池边多远）往平台上加。
 *
 * @param outset 从池边外沿往平台外挪的米数（平台宽 4 米）
 * @returns {{x:number, z:number}} 一定落在池壁外侧的平台上
 */
export function lanternSpot(azimuthDeg, outset = 0) {
  const a = THREE.MathUtils.degToRad(azimuthDeg);
  const dx = Math.cos(a), dz = Math.sin(a);
  const hx = POOL.innerX / 2 + POOL.wallThickness + 0.55;
  const hz = POOL.innerZ / 2 + POOL.wallThickness + 0.55;
  const bound = Math.min(
    Math.abs(dx) > 1e-4 ? hx / Math.abs(dx) : Infinity,
    Math.abs(dz) > 1e-4 ? hz / Math.abs(dz) : Infinity,
  );
  const d = bound + Math.max(0, Math.min(outset, 2.4));
  return { x: dx * d, z: dz * d };
}

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
    // 拷一份：自动降档会就地改 pixelRatio / shadow，直接引用会污染共享的质量表
    this.q = { ...QUALITY[this.quality] };
    // 同屏上限也要能降（不是常量：降到「流畅」档时会收到 24）
    this.maxObjects = MAX_OBJECTS;
    this.onEvent = onEvent || (() => {});
    this.params = JSON.parse(JSON.stringify(defaultParams));
    this.objects = [];
    this.mode = 'drop';          // 'drop' | 'view' | 'orbit'
    this.dropType = 'random';    // 点水面时丢什么
    this.running = false;
    this._grab = null;
    this._lastT = 0;
    this.perf = null;            // 帧率监视，start() 时才建
    this._perfNote = '';

    this.platform = new WechatPlatform(canvas);
    THREE.PLATFORM.set(this.platform);

    this._initRenderer();
    this._initScene();
    this._initPhysics();
    this._initWater();
    this._initLights();
    this._initControls();

    this.audio = new AudioEngine(this.params);
    this.physics.onImpact = (e) => {
      // 鸭子：撞击 + 一声「嘎」。撞得越狠叫得越响、音调越高
      this.audio.impact(e.strength, !e.wet);
      if (e.quack) this.audio.quack(0.35 + 0.65 * e.strength, e.wet ? 1.0 : 1.14);
    };
    this.physics.onSplash = (e) => {
      this.audio.splash(e.strength);
      if (e.quack) this.audio.quack(0.45 + 0.55 * e.strength, 1.2);
    };
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
    // PCFSoft 才是边缘最平滑的一档。注意 three r133 的 PCF_SOFT 分支里
    // 采样偏移写死成 1 个 texel，LightShadow.radius 对它无效——想真的加宽半影
    // 只能换 PCFShadowMap（但 radius 大于 3 会出现 4 个分离的影子，反而更假）。
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
      dir.shadow.bias = -0.0004;
      // normalBias 稍大一点：石板是平的，太小的值会在接缝处出现自阴影条纹
      dir.shadow.normalBias = 0.05;
      const sc = dir.shadow.camera;
      sc.left = -22; sc.right = 22; sc.top = 22; sc.bottom = -22;
      sc.near = 1; sc.far = 170;
    }
    this.scene.add(dir, dir.target);
    this.dirLight = dir;

    // 阴影软化靠「补光」而不是靠模糊：太阳被挡住的地方如果纯黑，边缘再软也显得硬。
    // 半球光给天空/地面的漫反射，环境光再垫一点，阴影里就能看到石头的本色。
    // 两者加起来别超过太阳的三分之一，否则整个场景会发灰、石头失去体积感。
    this.scene.add(new THREE.HemisphereLight(0xd6ecff, 0x4a6b60, 0.58));
    this.scene.add(new THREE.AmbientLight(0xcfe0ee, 0.18));

    // 3 盏可控的日式石灯笼
    this.lampGroup = new THREE.Group();
    this.stoneMat = new THREE.MeshStandardMaterial({
      color: STONE_ON,
      roughness: 0.94,
      metalness: 0.0,
      flatShading: true,     // 六角面要平着反光，才有“凿出来的石头”的感觉
    });
    this.lamps = this.params.lights.map((_, i) => this._makeLamp(i));
    this.scene.add(this.lampGroup);
    this.updateSun();
    this.updateLights();
  }

  /**
   * 一盏日式石灯笼（織部灯籠）。
   *
   * 参照实物照片，自下而上是：
   *   基座（一块石头雕出两条拱腿，顶上开尖拱洞）
   *   → 中台（比火袋宽一圈的六角台）
   *   → 火袋（上下六角板 + 6 根角柱，中腰一道窗棂，把窗口分成上下两格）
   *   → 笠（很宽很扁的伞盖，直径约为火袋的 2.6 倍）
   *   → 宝珠（莲座 + 圆珠 + 顶上的尖）
   *
   * 和最常见的「基础 + 长竿 + 火袋」三段式不同，这种没有竿，整盏灯中心很低，
   * 摆在池边才像庭院里的真东西。发光内芯藏在火袋里，光从柱缝中漏出来。
   */
  _makeLamp(i) {
    const p = this.params.lights[i];
    const group = new THREE.Group();
    group.name = `stoneLantern-${i}`;

    const stone = this.stoneMat;
    const part = (geo, y, cast = true) => {
      const m = new THREE.Mesh(geo, stone);
      m.position.y = y;
      m.castShadow = cast && this.q.shadow;
      m.receiveShadow = this.q.shadow;
      group.add(m);
      return m;
    };

    /* ---- 基座：一块石头，正面雕出尖拱洞，剩下的就是两条腿 ---- */
    const legHalfW = 0.46;
    const legH = 0.72;
    const archHalf = 0.20;
    const archTop = 0.50;
    const outline = new THREE.Shape();
    outline.moveTo(-legHalfW, 0);
    outline.lineTo(-legHalfW, legH);
    outline.lineTo(legHalfW, legH);
    outline.lineTo(legHalfW, 0);
    outline.lineTo(archHalf, 0);
    outline.lineTo(archHalf, archTop * 0.45);
    // 两条二次曲线收到同一个尖点，就是照片里那种「尖拱」
    outline.quadraticCurveTo(archHalf * 0.92, archTop * 0.88, 0, archTop);
    outline.quadraticCurveTo(-archHalf * 0.92, archTop * 0.88, -archHalf, archTop * 0.45);
    outline.lineTo(-archHalf, 0);
    outline.closePath();
    const baseGeo = new THREE.ExtrudeGeometry(outline, {
      depth: 0.30,
      bevelEnabled: false,
      curveSegments: 5,   // 手机上够圆了，再多只是白烧三角形
    });
    baseGeo.translate(0, 0, -0.15);   // 挤出沿 +z，挪回来让厚度居中
    part(baseGeo, 0);

    /* ---- 中台：六角扁台，比火袋宽一圈 ---- */
    part(new THREE.CylinderGeometry(0.50, 0.34, 0.16, 6), 0.80);

    /* ---- 火袋：底板 + 6 根角柱 + 窗棂 ---- */
    part(new THREE.CylinderGeometry(0.32, 0.36, 0.05, 6), 0.905, false);
    const postH = 0.52;                       // 火袋净高：窗口才会接近方形
    const postGeo = new THREE.BoxGeometry(0.075, postH, 0.075);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const post = new THREE.Mesh(postGeo, stone);
      // CylinderGeometry 的第 0 个顶点在 +z（x=r·sinθ, z=r·cosθ），
      // 所以角柱也必须用 (sin, cos) 摆，否则会错开 30°、长在六角面的正中间。
      post.position.set(Math.sin(a) * 0.295, FIREBOX_Y, Math.cos(a) * 0.295);
      post.rotation.y = a - Math.PI / 2;   // 让方柱的一个面朝外，贴着六角的棱
      post.castShadow = false;   // 6 根细柱子不进退影 pass，省一次绘制
      group.add(post);
    }
    // 中腰的窗棂会把每个窗口分成上下两格，和照片一致；没有它就是个空框，像鸟笼
    part(new THREE.CylinderGeometry(0.278, 0.278, 0.028, 6), FIREBOX_Y, false);

    const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(p.color) });
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.235, 0.46, 6), glowMat);
    glow.position.y = FIREBOX_Y;
    group.add(glow);

    // 灯周围一圈加法混合的雾光，手机上比后期 bloom 便宜得多。
    // 压扁一点，别鼓成球把笠的底面也糊亮。
    const haloMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(p.color),
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 10), haloMat);
    halo.position.y = FIREBOX_Y;
    halo.scale.set(1, 0.85, 1);
    halo.renderOrder = 3;
    group.add(halo);

    /* ---- 顶板 + 笠 ---- */
    part(new THREE.CylinderGeometry(0.38, 0.32, 0.05, 6), 1.475, false);
    // 笠：底半径 0.80、高只有 0.20 —— 又宽又扁才是伞盖，压厚了就像一块石饼
    part(new THREE.CylinderGeometry(0.24, 0.80, 0.20, 6), 1.60);

    /* ---- 宝珠 ---- */
    part(new THREE.CylinderGeometry(0.20, 0.12, 0.07, 6), 1.735, false);  // 莲座
    part(new THREE.SphereGeometry(0.14, 10, 8), 1.845, false);            // 珠
    part(new THREE.ConeGeometry(0.05, 0.14, 8), 1.975, false);            // 尖

    const light = new THREE.PointLight(new THREE.Color(p.color), p.on ? p.intensity : 0, 60, 2);
    this.lampGroup.add(group, light);
    return { group, light, glow, halo };
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
    if (this.audio) this.audio.splash(0.7);
    this.physics.kick(dv);
    // 被踹了一脚的鸭子会叫，虽然还没撞到东西
    if (this.objects.some((o) => o.quack)) this.audio.quack(0.85, 1.05);
  }

  _tryGrab(e) {
    const hit = this._pick(e);
    if (!hit) return;
    let o = hit.object;
    while (o && !o.userData.bodyIndex && o.parent) o = o.parent;
    const ent = o && this.objects[o.userData.bodyIndex];
    if (ent) {
      this._grab = { ent, plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.params.waterLevel - 0.4) };
      this.onEvent({ type: 'grabbed' });
      // 捏起来也叫一声，像真的抓了只鸭子
      if (this.audio) {
        if (ent.quack) this.audio.quack(0.6, 1.1);
        else this.audio.impact(0.15, false);
      }
    }
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
    if (this.objects.length >= this.maxObjects) this._removeOldest();
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
      quack: tpl.quack,
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
    // 水面上的碎光要跟着太阳走，否则太阳挪了、反光还停在原处
    if (this.water) this.water.setSun(dir);
  }

  updateLights() {
    const deckY = POOL.wallHeight;
    this.params.lights.forEach((p, i) => {
      const L = this.lamps[i];
      if (!L) return;
      const spot = lanternSpot(p.azimuth, p.outset);
      // 高度滑块指的是「火袋离地多高」，整盏灯按比例缩放，灯室才会正好对上光点
      const s = THREE.MathUtils.clamp((p.height - deckY) / FIREBOX_Y, 0.45, 2.4);
      L.group.position.set(spot.x, deckY, spot.z);
      L.group.scale.setScalar(s);
      L.group.rotation.y = -THREE.MathUtils.degToRad(p.azimuth);
      L.light.color.set(p.color);
      L.light.intensity = p.on ? p.intensity : 0;
      L.light.position.set(spot.x, deckY + FIREBOX_Y * s, spot.z);
      _tmpColor.set(p.color);
      L.glow.material.color.copy(p.on ? _tmpColor : GLOW_OFF);
      L.halo.material.color.copy(_tmpColor);
      L.halo.material.opacity = p.on ? 0.16 : 0;
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
    this.water.setFresnel(this.params.fresnelOn !== false, this.params.fresnelStrength);
    this.water.refresh();
    this.physics.wakeAll();
  }

  /** 菲涅尔反射开关 / 强度 */
  setFresnel(on) {
    this.params.fresnelOn = !!on;
    this.water.setFresnel(!!on, this.params.fresnelStrength);
  }

  refreshPhysics() { this.physics.refresh(); }

  applyDensity(d) { this.physics.applyDensity(d); }

  setExposure(v) { this.renderer.toneMappingExposure = v; }

  setShadows(on) {
    // 手动打开视为「我知道我在做什么」，覆盖自动降档的结果；关掉就照办
    if (on) this.q.shadow = QUALITY[this.quality].shadow;
    this._applyShadowEnabled(!!on && this.q.shadow);
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
    if (!this.perf) {
      this.perf = {
        t: 0,          // 当前统计窗口累计的真实秒数
        frames: 0,
        fps: 60,       // 平滑后的帧率
        windows: 0,    // 已经结算过几个窗口
        low: 0,        // 连续几个窗口低于阈值
        warmup: 3.0,   // 预热：着色器编译 / 纹理上传会掉帧，这几秒不判定
        cool: 0,       // 降档后的观察期，避免一口气降到底
        step: 0,       // 已经降了几档
      };
    }
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
    const rawDt = (now - this._lastT) / 1000;
    this._lastT = now;
    const dt = Math.min(rawDt, 1 / 20);   // 掉帧时钳制，避免物理炸开

    if (!this.params.paused) {
      this.waveField.update(dt);
      this.water.tick(dt);
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
    // 帧率统计必须用未钳制的 rawDt：dt 被钳到 1/20 后，5 fps 的机器会算成 20 fps
    this._trackPerf(rawDt);
  }

  /* ---------------------------- 性能兜底 ---------------------------- */

  /**
   * 手机最容易出问题的不是「一直慢」，而是玩两分钟以后发热降频——同一份代码，
   * 前面 60 fps 后面 20 fps。所以不按机型猜，直接看真实帧率，低了就退档。
   *
   * 退的顺序有讲究：先降分辨率（最有效、最不容易看出来），再关阴影，
   * 最后才减同屏物体（会丢东西，观感损失最大）。
   */
  _trackPerf(rawDt) {
    const p = this.perf;
    if (!p || this.params.paused) return;
    if (p.warmup > 0) { p.warmup -= rawDt; return; }
    if (p.cool > 0) { p.cool -= rawDt; return; }

    p.t += rawDt;
    p.frames++;
    if (p.t < 1.5) return;

    const fps = p.frames / p.t;
    // 第一个窗口直接用实测值，别拿 60 去平滑：EMA 从 60 起跳要三个窗口才能跌到阈值下，
    // 真卡的时候等于白等 4 秒。之后再用 EMA 抹平单次抖动。
    p.fps = p.windows ? p.fps * 0.55 + fps * 0.45 : fps;
    p.windows = (p.windows || 0) + 1;
    p.t = 0;
    p.frames = 0;

    if (p.fps < 24) {
      if (++p.low >= 2) this._downgrade();   // 连续两个窗口都慢才动手
    } else {
      p.low = 0;
    }
  }

  _downgrade() {
    const p = this.perf;
    let note = '';
    if (this.q.pixelRatio > 1.01) {
      this.q.pixelRatio = 1.0;
      this.renderer.setPixelRatio(Math.min(1.0, this.dpr, 2));
      note = '已降分辨率';
    } else if (this.q.shadow) {
      this.q.shadow = false;
      this._applyShadowEnabled(false);
      note = '已关阴影';
    } else if (this.maxObjects > 24) {
      this.maxObjects = 24;
      while (this.objects.length > this.maxObjects) this._removeOldest();
      note = '已减少物体';
    } else {
      // 已经退到底了：拉长冷却，别再每三秒弹一次
      p.cool = 30;
      p.low = 0;
      return;
    }
    p.step++;
    p.low = 0;
    p.cool = 5;
    this._perfNote = note;
    this.onEvent({ type: 'perf', note, fps: Math.round(p.fps), step: p.step });
  }

  /**
   * 开关阴影。
   * shadowMap.enabled 参与材质编译（USE_SHADOWMAP 宏），光改这个开关不重编译不生效，
   * 所以要把场景里的材质逐个标记重编译——一次性开销，几十毫秒。
   */
  _applyShadowEnabled(on) {
    this.renderer.shadowMap.enabled = on;
    if (this.dirLight) {
      this.dirLight.castShadow = on;
      // 关掉后把深度图也还回去，不然这张贴图一直占着显存
      if (!on && this.dirLight.shadow && this.dirLight.shadow.map) {
        this.dirLight.shadow.map.dispose();
        this.dirLight.shadow.map = null;
      }
    }
    this.scene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) m.needsUpdate = true;
    });
  }

  dispose() {
    this.stop();
    this.clearObjects();
    this.audio.dispose();
    this.controls.dispose && this.controls.dispose();
    // 石灯笼：石材是 3 盏共用的，只释放一次
    if (this.lampGroup) {
      this.lampGroup.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry && o.geometry.dispose();
        if (o.material && o.material !== this.stoneMat) o.material.dispose();
      });
      this.stoneMat && this.stoneMat.dispose();
    }
    this.water.dispose && this.water.dispose();
    this.pool.dispose && this.pool.dispose();
    this.renderer.dispose();
    THREE.PLATFORM.dispose();
  }
}
