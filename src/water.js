import * as THREE from 'three';
import { POOL } from './config.js';

export const WAVE_COUNT = 6;
const G = 9.81;

/**
 * 波浪场：同一套波参数同时供 JS（浮力/物理）与 GLSL（水面渲染）使用，
 * 保证“看到的水面”和“托住物体的水面”完全一致。
 *   h(p) = Σ amp_i * sin( k_i * dot(dir_i, p) - phase_i )
 */
export class WaveField {
  constructor(params) {
    this.params = params;
    this.time = 0;
    // 传给 shader 的数据
    this.waveA = [];      // Vector4(dirX, dirZ, amp, k)
    this.phase = new Float32Array(WAVE_COUNT);
    this.omega = new Float32Array(WAVE_COUNT);
    this.maxAmp = 1;
    for (let i = 0; i < WAVE_COUNT; i++) this.waveA.push(new THREE.Vector4());
    this._seed = [];
    for (let i = 0; i < WAVE_COUNT; i++) this._seed.push(Math.random() * Math.PI * 2);
    this.rebuild();
  }

  /** 依据滑块参数重建波形（滑块变化时调用，不会跳变相位） */
  rebuild() {
    const p = this.params;
    const base = THREE.MathUtils.degToRad(p.windDirection);
    const spread = THREE.MathUtils.degToRad(p.waveSpread);
    let maxAmp = 0;
    for (let i = 0; i < WAVE_COUNT; i++) {
      const t = i / (WAVE_COUNT - 1) - 0.5;              // -0.5 .. 0.5
      const a = base + t * spread;
      const wl = Math.max(0.4, p.wavelength * Math.pow(0.66, i));
      const k = (Math.PI * 2) / wl;
      let amp = p.waveHeight * Math.pow(0.66, i);
      if (i > 0) amp *= (0.35 + 1.05 * p.choppiness);
      amp = Math.min(amp, 0.85 / k);                      // 限制陡度，避免自交
      const omega = Math.sqrt(G * k) * p.waveSpeed;
      this.waveA[i].set(Math.cos(a), Math.sin(a), amp, k);
      this.omega[i] = omega;
      maxAmp += amp;
    }
    this.maxAmp = Math.max(maxAmp, 0.001);
  }

  /** 推进相位（用累积相位，滑块改速度时不会突跳） */
  update(dt) {
    this.time += dt;
    for (let i = 0; i < WAVE_COUNT; i++) {
      this.phase[i] = (this.phase[i] + this.omega[i] * dt) % (Math.PI * 2);
    }
  }

  /** 世界坐标 (x,z) 处的水面高度（已含水位） */
  heightAt(x, z) {
    const p = this.params;
    let h = 0;
    for (let i = 0; i < WAVE_COUNT; i++) {
      const w = this.waveA[i];
      h += w.z * Math.sin(w.w * (w.x * x + w.y * z) - this.phase[i]);
    }
    return p.waterLevel + h;
  }

  /** 水面斜率（用于让漂浮物顺着浪面倾斜） */
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

  /** 水面法线 */
  normalAt(x, z) {
    const { dx, dz } = this.slopeAt(x, z);
    return new THREE.Vector3(-dx, 1, -dz).normalize();
  }
}

/* ------------------------------------------------------------------ */
/*  水面渲染：PBR 材质 + 顶点位移（与 WaveField 同一公式）              */
/* ------------------------------------------------------------------ */

const waveGLSL = /* glsl */`
uniform vec4 uWaveA[${WAVE_COUNT}];   // dirX, dirZ, amp, k
uniform float uPhase[${WAVE_COUNT}];
uniform float uMaxAmp;
uniform float uFoam;
varying float vFoam;
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

export function createWater(waveField, environment) {
  const p = waveField.params;
  const seg = 200;
  const geo = new THREE.PlaneGeometry(POOL.innerX, POOL.innerZ, seg, seg);
  geo.rotateX(-Math.PI / 2);

  const uniforms = {
    uWaveA: { value: waveField.waveA },
    uPhase: { value: waveField.phase },
    uMaxAmp: { value: waveField.maxAmp },
    uFoam: { value: p.foamAmount },
  };

  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(p.waterColor),
    roughness: p.waterRoughness,
    metalness: 0.0,
    transparent: true,
    opacity: p.waterOpacity,
    side: THREE.DoubleSide,
    envMapIntensity: 1.25,
    clearcoat: 1.0,
    clearcoatRoughness: 0.06,
    depthWrite: true,
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWaveA = uniforms.uWaveA;
    shader.uniforms.uPhase = uniforms.uPhase;
    shader.uniforms.uMaxAmp = uniforms.uMaxAmp;
    shader.uniforms.uFoam = uniforms.uFoam;

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
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vFoam;\nvarying vec3 vWPos;`)
      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), vFoam * 0.85);
      `);
  };
  mat.customProgramCacheKey = () => 'poolWater';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = p.waterLevel;
  mesh.receiveShadow = true;
  mesh.renderOrder = 2;
  mesh.name = 'waterSurface';
  mesh.userData.pickable = 'water';

  // 水体侧壁（水面以下的一层淡蓝体积感），让“水”看起来是有厚度的
  const bodyGeo = new THREE.BoxGeometry(POOL.innerX, POOL.depth, POOL.innerZ);
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(p.waterColor),
    transparent: true,
    opacity: 0.18,
    roughness: 0.25,
    metalness: 0,
    side: THREE.BackSide,
    depthWrite: false,
    envMapIntensity: 0.8,
  });
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.renderOrder = 1;
  bodyMesh.name = 'waterVolume';

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

  return {
    group,
    surface: mesh,
    volume: bodyMesh,
    material: mat,
    bodyMaterial: bodyMat,
    uniforms,
    syncLevel,
    setEnvironment(envTex) {
      mat.envMap = envTex;
      bodyMat.envMap = envTex;
      mat.needsUpdate = true;
      bodyMat.needsUpdate = true;
    },
    refresh() {
      mat.color.set(p.waterColor);
      mat.opacity = p.waterOpacity;
      mat.roughness = p.waterRoughness;
      bodyMat.color.set(p.waterColor);
      bodyMat.opacity = Math.min(0.45, p.waterOpacity * 0.32);
      uniforms.uMaxAmp.value = waveField.maxAmp;
      uniforms.uFoam.value = p.foamAmount;
      syncLevel();
    },
  };
}
