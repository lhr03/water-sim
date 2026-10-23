import * as THREE from '../lib/build/three.module.js';
import { POOL } from './config.js';

export const WAVE_COUNT = 6;
const G = 9.81;

// 天空反射的两层颜色：地平线偏白、天顶偏蓝。
// 没有环境贴图（手机上做真反射要么立方体贴图要么平面镜，都太贵），
// 所以用一个双色渐变当「天空」，掠射角时把水染成它的颜色，观感上就是反射。
const SKY_TOP = new THREE.Color('#7fb2dd');
const SKY_HORIZON = new THREE.Color('#e9f4fc');

/** mulberry32：确定性伪随机，用于可复现的波面种子 */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 波浪场：同一套波参数同时供 JS（浮力/物理）与 GLSL（水面渲染）使用。
 *   h(p) = Σ amp_i * sin( k_i * dot(dir_i, p) - phase_i )
 * @param seed 传入固定值可得到可复现波面；不传则每次随机。
 */
export class WaveField {
  constructor(params, seed = null) {
    this.params = params;
    this.time = 0;
    this.waveA = [];
    this.phase = new Float32Array(WAVE_COUNT);
    this.omega = new Float32Array(WAVE_COUNT);
    this.maxAmp = 1;
    for (let i = 0; i < WAVE_COUNT; i++) this.waveA.push(new THREE.Vector4());
    this._seed = [];
    const rand = seed === null ? Math.random : mulberry32(seed);
    for (let i = 0; i < WAVE_COUNT; i++) this._seed.push(rand() * Math.PI * 2);
    this.rebuild();
  }

  rebuild() {
    const p = this.params;
    const base = THREE.MathUtils.degToRad(p.windDirection);
    const spread = THREE.MathUtils.degToRad(p.waveSpread);
    let maxAmp = 0;
    for (let i = 0; i < WAVE_COUNT; i++) {
      const t = i / (WAVE_COUNT - 1) - 0.5;
      const a = base + t * spread;
      const wl = Math.max(0.4, p.wavelength * Math.pow(0.66, i));
      const k = (Math.PI * 2) / wl;
      let amp = p.waveHeight * Math.pow(0.66, i);
      if (i > 0) amp *= (0.35 + 1.05 * p.choppiness);
      amp = Math.min(amp, 0.85 / k);
      const omega = Math.sqrt(G * k) * p.waveSpeed;
      this.waveA[i].set(Math.cos(a), Math.sin(a), amp, k);
      this.omega[i] = omega;
      maxAmp += amp;
    }
    this.maxAmp = Math.max(maxAmp, 0.001);
  }

  update(dt) {
    this.time += dt;
    for (let i = 0; i < WAVE_COUNT; i++) {
      this.phase[i] = (this.phase[i] + this.omega[i] * dt) % (Math.PI * 2);
    }
  }

  heightAt(x, z) {
    const p = this.params;
    let h = 0;
    for (let i = 0; i < WAVE_COUNT; i++) {
      const w = this.waveA[i];
      h += w.z * Math.sin(w.w * (w.x * x + w.y * z) - this.phase[i]);
    }
    return p.waterLevel + h;
  }

  slopeAt(x, z) {
    let dx = 0, dz = 0;
    for (let i = 0; i < WAVE_COUNT; i++) {
      const w = this.waveA[i];
      const c = Math.cos(w.w * (w.x * x + w.y * z) - this.phase[i]) * w.z * w.w;
      dx += c * w.x;
      dz += c * w.y;
    }
    return { dx, dz };
  }

  normalAt(x, z) {
    const { dx, dz } = this.slopeAt(x, z);
    return new THREE.Vector3(-dx, 1, -dz).normalize();
  }
}

/* ------------------------------------------------------------------ */
/*  水面渲染：顶点位移，与 WaveField 同一公式                            */
/* ------------------------------------------------------------------ */

/** 顶点着色器里用到的：波形函数 + 三个 varying */
const waveGLSL = /* glsl */`
uniform vec4 uWaveA[${WAVE_COUNT}];
uniform float uPhase[${WAVE_COUNT}];
uniform float uMaxAmp;
varying float vHeight;
varying float vSteep;
varying vec3 vWPos;

float waveHeightAt(vec2 p){
  float h = 0.0;
  for (int i = 0; i < ${WAVE_COUNT}; i++) {
    vec4 w = uWaveA[i];
    h += w.z * sin(w.w * dot(w.xy, p) - uPhase[i]);
  }
  return h;
}

vec3 waveNormalAt(vec2 p){
  float dx = 0.0;
  float dz = 0.0;
  for (int i = 0; i < ${WAVE_COUNT}; i++) {
    vec4 w = uWaveA[i];
    float c = cos(w.w * dot(w.xy, p) - uPhase[i]) * w.z * w.w;
    dx += c * w.x;
    dz += c * w.y;
  }
  return normalize(vec3(-dx, 1.0, -dz));
}
`;

/**
 * 片元着色器里用到的：噪声 + 白沫 + 菲涅尔。
 *
 * 注意事项（踩过的坑）：
 *  - varying 只能声明一次。waveGLSL 已经声明了 vHeight/vSteep/vWPos，这里必须再声明一遍
 *    （两个 shader 是独立编译单元，各自需要声明），但同一个 shader 内绝不能重复。
 *  - 不要用 dFdx/dFdy 求坡度：WebGL1 需要显式开启 OES_standard_derivatives，
 *    没开就是编译失败 → 水面直接不渲染。坡度改由顶点算好传下来。
 */
const surfaceGLSL = /* glsl */`
uniform float uMaxAmp;
uniform float uFoam;
uniform float uFresnel;
uniform float uTime;
uniform vec2 uHalf;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSunDir;
varying float vHeight;
varying float vSteep;
varying vec3 vWPos;

// 无 sin 的哈希（Dave Hoskins 那套）。不用 sin(dot()) 的原因有两个：
// 一是快，二是手机 GPU 的 sin 精度低，用 sin 做哈希会在水面上出现明显的斜条纹。
float wHash(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// 二维值噪声。比贴图便宜，也不需要 UV——水面 UV 是平铺的，跟着顶点位移会拉伸
float wNoise(vec2 p){
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = wHash(i);
  float b = wHash(i + vec2(1.0, 0.0));
  float c = wHash(i + vec2(0.0, 1.0));
  float d = wHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// 白沫 = 浪尖 + 陡坡 + 舔岸，再被流动噪声打碎成斑块。
// 只用「高度阈值」会得到一条条整齐的白色横带，像斑马纹，非常假。
float poolFoam(vec2 pos, float h, float steep){
  float n1 = wNoise(pos * 1.55 + vec2(uTime * 0.21, uTime * 0.13));
  float n2 = wNoise(pos * 4.10 - vec2(uTime * 0.11, uTime * 0.29));
  float n = n1 * 0.62 + n2 * 0.38;

  float amp = max(uMaxAmp, 0.02);
  float crest = smoothstep(0.34 * amp, 0.92 * amp, h);
  float slope = smoothstep(0.08, 0.34, steep) * (0.5 + 0.5 * n);

  // 池壁附近的水被墙“堵住”，会堆出一圈白边，而且随浪一涨一退
  vec2 d = uHalf - abs(pos);
  float shore = 1.0 - smoothstep(0.0, 1.7, min(d.x, d.y));
  shore *= 0.40 + 0.60 * n;

  float f = (crest * (0.30 + 0.70 * n) + slope * 0.60 + shore * 0.70) * uFoam;
  f *= smoothstep(0.14, 0.50, f * 0.85 + n * 0.42);
  return clamp(f * 1.45, 0.0, 1.0);
}
`;

/**
 * 创建水面。
 * @param quality 'low' | 'mid' | 'high' —— 决定网格密度与材质开销
 */
export function createWater(waveField, quality = 'mid') {
  const p = waveField.params;
  // 顶点数：low 约 2.4k，mid 约 9.4k，high 约 26k。
  // 网页版是 200x200（4 万顶点），手机上必须降下来。
  const seg = quality === 'low' ? 48 : quality === 'high' ? 160 : 96;
  const geo = new THREE.PlaneGeometry(POOL.innerX, POOL.innerZ, seg, seg);
  geo.rotateX(-Math.PI / 2);

  const uniforms = {
    uWaveA: { value: waveField.waveA },
    uPhase: { value: waveField.phase },
    uMaxAmp: { value: waveField.maxAmp },
    uFoam: { value: p.foamAmount },
    uFresnel: { value: p.fresnelOn === false ? 0 : (p.fresnelStrength ?? 1) },
    uTime: { value: 0 },
    uHalf: { value: new THREE.Vector2(POOL.innerX / 2, POOL.innerZ / 2) },
    uSkyTop: { value: SKY_TOP.clone() },
    uSkyHorizon: { value: SKY_HORIZON.clone() },
    uSunDir: { value: new THREE.Vector3(0.42, 0.62, 0.66).normalize() },
  };

  // 精简版不走 PBR 清漆与环境贴图：手机上开销大，且没有 envMap 时看不出差别
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(p.waterColor),
    roughness: p.waterRoughness,
    metalness: 0.05,
    transparent: true,
    opacity: p.waterOpacity,
    side: THREE.DoubleSide,
  });

  mat.onBeforeCompile = (shader) => {
    // 统一挂上去：新增 uniform 只要往 uniforms 里加一行，这里不用跟着改
    for (const k of Object.keys(uniforms)) shader.uniforms[k] = uniforms[k];

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${waveGLSL}`)
      .replace('#include <beginnormal_vertex>', /* glsl */`
        vec3 objectNormal = waveNormalAt(position.xz);
        vSteep = clamp(1.0 - objectNormal.y, 0.0, 1.0);
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        float waveH = waveHeightAt(position.xz);
        vec3 transformed = vec3(position.x, position.y + waveH, position.z);
        vHeight = waveH;
      `)
      .replace('#include <project_vertex>', /* glsl */`
        #include <project_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${surfaceGLSL}`)
      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        float foam = poolFoam(vWPos.xz, vHeight, vSteep);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.94, 0.97, 1.0), foam * 0.92);
        // 白沫处不能透光，否则能看见底下的瓷砖，白沫就“虚”了
        diffuseColor.a = mix(diffuseColor.a, 1.0, foam * 0.85);
      `)
      .replace('#include <normal_fragment_begin>', /* glsl */`
        #include <normal_fragment_begin>

        // ---- 菲涅尔：垂直看是水色，越接近平视越像镜子 ----
        vec3 wN = normalize(inverseTransformDirection(normal, viewMatrix));
        vec3 wV = normalize(cameraPosition - vWPos);
        float ndv = clamp(dot(wN, wV), 0.0, 1.0);
        float fres = clamp(uFresnel * (0.02 + 0.98 * pow(1.0 - ndv, 5.0)), 0.0, 1.0);

        vec3 refl = reflect(-wV, wN);
        float skyMix = clamp(refl.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 skyCol = mix(uSkyHorizon, uSkyTop, pow(skyMix, 0.75));

        diffuseColor.rgb = mix(diffuseColor.rgb, skyCol, fres);
        diffuseColor.a = mix(diffuseColor.a, 1.0, fres * 0.55);

        // 太阳在水面拉出的那道碎光。指数越大光点越细，220 大约是“细碎”的临界
        float glint = pow(max(dot(refl, uSunDir), 0.0), 220.0) * 2.4 * uFresnel;
        totalEmissiveRadiance += vec3(1.0, 0.96, 0.88) * glint + skyCol * fres * 0.22;
      `);
  };
  mat.customProgramCacheKey = () => 'poolWater';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = p.waterLevel;
  mesh.receiveShadow = quality !== 'low';
  mesh.renderOrder = 2;
  mesh.name = 'waterSurface';
  mesh.userData.pickable = 'water';

  // 水体侧壁（水面下的一层淡蓝），让水看起来有厚度
  const bodyGeo = new THREE.BoxGeometry(POOL.innerX, POOL.depth, POOL.innerZ);
  const bodyMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(p.waterColor),
    transparent: true,
    opacity: 0.22,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.renderOrder = 1;

  const group = new THREE.Group();
  group.add(mesh, bodyMesh);

  function syncLevel() {
    mesh.position.y = p.waterLevel;
    const top = p.waterLevel;
    const h = Math.max(0.2, POOL.depth + p.waterLevel - 1.0);
    bodyMesh.scale.y = h / POOL.depth;
    bodyMesh.position.y = top - h / 2;
  }
  syncLevel();

  /** 开关 + 强度。做成 uniform 而不是改着色器，切换时会立刻生效、不用重编译 */
  function setFresnel(on, strength) {
    const k = strength === undefined ? (p.fresnelStrength ?? 1) : strength;
    uniforms.uFresnel.value = on ? Math.max(0, Math.min(1, k)) : 0;
  }

  /** 太阳方向（世界空间单位向量），用来画水面上的碎光 */
  function setSun(dir) {
    if (dir) uniforms.uSunDir.value.copy(dir).normalize();
  }

  /**
   * 反射里那层天空的颜色。
   * 必须跟着昼夜一起变：夜里天空黑了、水面还映着白天的蓝，一眼就假。
   */
  function setSky(horizon, top) {
    if (horizon) uniforms.uSkyHorizon.value.copy(horizon);
    if (top) uniforms.uSkyTop.value.copy(top);
  }

  function refresh() {
    mat.color.set(p.waterColor);
    mat.opacity = p.waterOpacity;
    mat.roughness = p.waterRoughness;
    uniforms.uFoam.value = p.foamAmount;
    uniforms.uMaxAmp.value = waveField.maxAmp;
    bodyMat.color.set(p.waterColor);
    setFresnel(p.fresnelOn !== false, p.fresnelStrength);
    syncLevel();
  }

  return {
    group,
    mesh,
    material: mat,
    refresh,
    uniforms,
    setFresnel,
    setSun,
    setSky,
    /** 白沫的流动噪声需要时间 */
    tick(dt) { uniforms.uTime.value += dt; },
    dispose() {
      geo.dispose(); mat.dispose(); bodyGeo.dispose(); bodyMat.dispose();
    },
  };
}
