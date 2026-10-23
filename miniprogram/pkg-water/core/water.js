import * as THREE from '../lib/build/three.module.js';
import { POOL } from './config.js';

export const WAVE_COUNT = 6;
const G = 9.81;

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

const waveGLSL = /* glsl */`
uniform vec4 uWaveA[${WAVE_COUNT}];
uniform float uPhase[${WAVE_COUNT}];
uniform float uMaxAmp;
uniform float uFoam;
varying float vFoam;

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
    shader.uniforms.uWaveA = uniforms.uWaveA;
    shader.uniforms.uPhase = uniforms.uPhase;
    shader.uniforms.uMaxAmp = uniforms.uMaxAmp;
    shader.uniforms.uFoam = uniforms.uFoam;

    // 注意：waveGLSL 里已经声明过 varying float vFoam，这里不能再声明一次，
    // 否则顶点着色器会因「redefinition of vFoam」编译失败，整个水面直接不渲染。
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${waveGLSL}`)
      .replace(
        '#include <beginnormal_vertex>',
        `vec3 objectNormal = waveNormalAt(position.xz);`
      )
      .replace('#include <begin_vertex>', /* glsl */`
        float h = waveHeightAt(position.xz);
        vec3 transformed = vec3(position.x, position.y + h, position.z);
        vFoam = clamp(uFoam * smoothstep(0.45 * uMaxAmp, 0.95 * uMaxAmp, h), 0.0, 1.0);
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vFoam;`)
      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), vFoam * 0.85);
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

  function refresh() {
    mat.color.set(p.waterColor);
    mat.opacity = p.waterOpacity;
    mat.roughness = p.waterRoughness;
    uniforms.uFoam.value = p.foamAmount;
    uniforms.uMaxAmp.value = waveField.maxAmp;
    bodyMat.color.set(p.waterColor);
    syncLevel();
  }

  return { group, mesh, material: mat, refresh, uniforms, dispose() {
    geo.dispose(); mat.dispose(); bodyGeo.dispose(); bodyMat.dispose();
  } };
}
