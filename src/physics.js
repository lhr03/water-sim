import * as CANNON from 'cannon-es';

const G = 9.82;
const FIXED = 1 / 60;

/**
 * 水物理世界：
 *  - 浮力：用“浮力探针”(probe) 估算浸没体积，并把合力施加在水下部分的几何中心（浮心）
 *          → 自然产生扶正力矩，物体会随浪面倾斜、翻滚。
 *  - 水阻力 / 角阻尼：只作用于浸没部分。
 *  - 风力：只作用于露出水面的部分，带阵风扰动。
 *  - 池壁 / 池底：静态刚体，形成有边界的“游泳池”。
 */
export class WaterPhysics {
  constructor(params, waveField) {
    this.params = params;
    this.wave = waveField;
    this.time = 0;
    this.acc = 0;

    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -G, 0) });
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.solver.iterations = 14;
    world.solver.tolerance = 0.001;
    world.allowSleep = true;
    const dcm = world.defaultContactMaterial;
    dcm.friction = params.friction;
    dcm.restitution = params.restitution;
    dcm.contactEquationStiffness = 1e7;
    dcm.contactEquationRelaxation = 3;
    this.world = world;

    this.bodies = [];         // 动态漂浮体
    this.statics = [];        // 池壁等
    this.onImpact = null;     // ({strength, wet, pool, x, z, size})
    this.onSplash = null;     // ({strength, x, z})

    this._tmp = new CANNON.Vec3();
    this._tmp2 = new CANNON.Vec3();
  }

  addStaticBox(half, pos, tag = 'pool') {
    const body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.STATIC,
      shape: new CANNON.Box(new CANNON.Vec3(half[0], half[1], half[2])),
      position: new CANNON.Vec3(pos[0], pos[1], pos[2]),
    });
    body.userData = { isPool: true, tag };
    this.world.addBody(body);
    this.statics.push(body);
    return body;
  }

  /**
   * @param {object} o {shape, mass, position, quaternion, volume, probes, size, mesh, seed}
   */
  addBody(o) {
    const p = this.params;
    const body = new CANNON.Body({
      mass: o.mass,
      shape: o.shape,
      position: new CANNON.Vec3(o.position.x, o.position.y, o.position.z),
      linearDamping: p.linearDamping,
      angularDamping: p.angularDamping,
    });
    if (o.quaternion) body.quaternion.set(o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w);
    body.userData = { isPool: false, lastSound: -1, ref: null };
    body.allowSleep = true;
    body.sleepSpeedLimit = 0.18;
    body.sleepTimeLimit = 1.2;

    const entry = {
      body,
      mesh: o.mesh,
      volume: o.volume,
      probes: o.probes,
      size: o.size,
      seed: o.seed ?? Math.random() * 10,
      lastRatio: 0,
      prevRatio: 0,
      wet: false,
    };
    body.userData.ref = entry;
    this.bodies.push(entry);

    const self = this;
    body.addEventListener('collide', (e) => {
      const contact = e.contact;
      const rel = contact ? Math.abs(contact.getImpactVelocityAlongNormal()) : 0;
      if (rel < 0.55) return;
      const now = self.time;
      if (now - body.userData.lastSound < 0.07) return;
      body.userData.lastSound = now;
      const other = e.body;
      const pool = !!(other && other.userData && other.userData.isPool);
      if (!self.onImpact) return;
      self.onImpact({
        strength: Math.min(1, rel / 6.5),
        pool,
        wet: entry.lastRatio > 0.3,
        x: body.position.x,
        y: body.position.y,
        z: body.position.z,
        size: entry.size,
        volume: entry.volume,
      });
    });

    this.world.addBody(body);
    return entry;
  }

  remove(entry) {
    const i = this.bodies.indexOf(entry);
    if (i >= 0) this.bodies.splice(i, 1);
    this.world.removeBody(entry.body);
  }

  clear() {
    for (const e of [...this.bodies]) this.remove(e);
  }

  wakeAll() {
    for (const e of this.bodies) e.body.wakeUp();
  }

  step(dt) {
    this.acc += Math.min(dt, 0.12);
    let n = 0;
    while (this.acc >= FIXED && n < 5) {
      this.substep(FIXED);
      this.acc -= FIXED;
      n++;
    }
    if (n >= 5) this.acc = 0;
  }

  substep(h) {
    const p = this.params;
    this.time += h;

    const windRad = (p.windDirection * Math.PI) / 180;
    const wx = Math.cos(windRad);
    const wz = Math.sin(windRad);

    for (const e of this.bodies) {
      const body = e.body;
      e.prevRatio = e.lastRatio;
      if (body.sleepState === CANNON.Body.SLEEPING) continue;

      // ---- 1. 采样浸没情况 ----
      let sub = 0, cx = 0, cy = 0, cz = 0;
      const tmp = this._tmp;
      const probes = e.probes;
      for (let i = 0; i < probes.length; i++) {
        body.pointToWorldFrame(probes[i], tmp);
        const surf = this.wave.heightAt(tmp.x, tmp.z);
        if (surf - tmp.y > 0) { sub++; cx += tmp.x; cy += tmp.y; cz += tmp.z; }
      }
      const ratio = sub / probes.length;
      e.lastRatio = ratio;

      // 入水瞬间 → 水花（用状态机，避免慢速入水时漏判）
      if (!e.wet && ratio > 0.12) {
        e.wet = true;
        if (this.onSplash) {
          const speed = Math.abs(body.velocity.y);
          this.onSplash({
            strength: Math.min(1, (speed * 0.25 + 0.25) * Math.min(1, e.volume / 0.15 + 0.35)),
            x: body.position.x, z: body.position.z,
          });
        }
      } else if (e.wet && ratio < 0.02) {
        e.wet = false;      // 完全离开水面，允许下次再触发
      }

      if (ratio > 0) {
        // ---- 2. 浮力（作用于浮心，产生扶正/倾覆力矩）----
        const V = e.volume * ratio;
        const F = p.waterDensity * G * V;
        cx /= sub; cy /= sub; cz /= sub;
        const ox = cx - body.position.x;
        const oy = cy - body.position.y;
        const oz = cz - body.position.z;
        this._tmp2.set(0, F, 0);
        tmp.set(ox, oy, oz);
        body.applyForce(this._tmp2, tmp);

        // ---- 3. 水阻力（线性 + 垂直方向更强）----
        const k = p.waterDrag * ratio * body.mass * 2.0;
        const v = body.velocity;
        this._tmp2.set(-v.x * k, -v.y * k * 1.6, -v.z * k);
        body.applyForce(this._tmp2);

        // ---- 4. 角阻尼（水的粘滞）----
        const ad = Math.max(0, 1 - 0.028 * p.waterDrag * ratio);
        body.angularVelocity.scale(ad, body.angularVelocity);
      }

      // ---- 5. 风（只推露出水面的部分，作用点抬高 → 有倾覆感）----
      const exposed = 1 - ratio;
      if (exposed > 0.02 && p.windStrength > 0) {
        const gust = 1 + p.windGust * (
          0.7 * Math.sin(this.time * 0.9 + e.seed) +
          0.3 * Math.sin(this.time * 2.7 + e.seed * 1.7)
        );
        const area = Math.pow(e.volume, 2 / 3);
        const mag = p.windStrength * area * 9.0 * gust * exposed;
        this._tmp2.set(wx * mag, 0, wz * mag);
        tmp.set(0, e.size * 0.18, 0);
        body.applyForce(this._tmp2, tmp);
      }
    }

    this.world.step(h);
  }

  /** 滑块调整后同步材质/阻尼属性 */
  refresh() {
    const p = this.params;
    const dcm = this.world.defaultContactMaterial;
    dcm.friction = p.friction;
    dcm.restitution = p.restitution;
    for (const e of this.bodies) {
      e.body.linearDamping = p.linearDamping;
      e.body.angularDamping = p.angularDamping;
    }
  }

  /** 改变密度（影响浮沉） */
  applyDensity(density) {
    for (const e of this.bodies) {
      const m = Math.max(0.05, e.volume * density * this.params.waterDensity);
      e.body.mass = m;
      e.body.updateMassProperties();
      e.body.wakeUp();
    }
  }

  syncMeshes() {
    for (const e of this.bodies) {
      if (!e.mesh) continue;
      e.mesh.position.set(e.body.position.x, e.body.position.y, e.body.position.z);
      e.mesh.quaternion.set(e.body.quaternion.x, e.body.quaternion.y, e.body.quaternion.z, e.body.quaternion.w);
    }
  }
}

/**
 * 只保留真正落在碰撞体内部的探针。
 *
 * 为什么要过滤：探针原本均匀撒在包围盒里，而球只占盒体积约 52%、圆柱约 78%，
 * 那些落在物体外面、却仍在水面以下的点会被算进「浸没」，系统性高估浮力，
 * 结果是物体浮得比真实位置高——密度 0.25 的球实测偏高约 0.25 m（球心 +0.17 而非 -0.09）。
 * 密度越远离 0.5，误差越明显。
 *
 * @param pts     盒内均匀采样点（本地坐标）
 * @param shape   对应的 cannon 碰撞体
 * @param maxKeep 保留上限，控制每帧 heightAt 的调用次数
 */
export function filterProbesInside(pts, shape, maxKeep = 32) {
  let inside;
  try {
    if (shape && typeof shape.pointIsInside === 'function') {
      inside = pts.filter((p) => shape.pointIsInside(p));        // ConvexPolyhedron
    } else if (shape && shape.halfExtents) {
      const h = shape.halfExtents, e = 1e-6;                     // Box
      inside = pts.filter((p) =>
        Math.abs(p.x) <= h.x + e && Math.abs(p.y) <= h.y + e && Math.abs(p.z) <= h.z + e);
    } else if (shape && shape.radius) {
      inside = pts.filter((p) => p.length() <= shape.radius * 1.0001);   // Sphere
    } else {
      inside = pts;
    }
  } catch (e) {
    inside = pts;               // 判定失败就退回原样，宁可不准也不能崩
  }

  if (!inside || inside.length < 8) return pts;   // 过滤太狠会放大离散误差，不如不滤

  if (inside.length > maxKeep) {                  // 均匀抽稀，控制每帧开销
    const step = inside.length / maxKeep;
    const out = [];
    for (let i = 0; i < maxKeep; i++) out.push(inside[Math.floor(i * step)]);
    return out;
  }
  return inside;
}

export function makeProbes(box, n = 3) {
  // 在本地包围盒内均匀取 n^3 个采样点
  const pts = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) {
        const x = box.min.x + (box.max.x - box.min.x) * ((i + 0.5) / n);
        const y = box.min.y + (box.max.y - box.min.y) * ((j + 0.5) / n);
        const z = box.min.z + (box.max.z - box.min.z) * ((k + 0.5) / n);
        pts.push(new CANNON.Vec3(x, y, z));
      }
    }
  }
  return pts;
}
