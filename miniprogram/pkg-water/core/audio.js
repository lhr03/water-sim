/**
 * 小程序版程序化音效：不依赖音频文件，用 wx.createWebAudioContext 实时合成。
 *  - 海浪：粉噪 → 低通，慢速 LFO 调制音量与亮度
 *  - 风声：噪声 → 带通，随风力变化
 *  - 碰撞：噪声脉冲 + 低频“咚”，按撞击强度决定音量与音色
 *  - 入水：带通扫频噪声（水花）
 *  - 鸭叫：锯齿波快速下滑 + 带通共鸣，两声「嘎-啊克」
 *
 * 注意：小程序 WebAudio 的支持面比浏览器窄，所以每个节点的创建都做了容错，
 * 拿不到就直接跳过该效果，绝不让整条音频链崩掉。
 */

const safe = (fn, fallback = null) => {
  try { const r = fn(); return r === undefined ? fallback : r; } catch (e) { return fallback; }
};

export class AudioEngine {
  constructor(params) {
    this.params = params;
    this.ctx = null;
    this.ready = false;
    this.degraded = [];   // 记录哪些效果被降级，便于排查
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') safe(() => this.ctx.resume());
      return this.ready;
    }
    if (typeof wx === 'undefined' || !wx.createWebAudioContext) return false;

    const ctx = safe(() => wx.createWebAudioContext());
    if (!ctx) return false;
    this.ctx = ctx;

    // 粉噪源（2 秒循环，够用且省内存）
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = safe(() => ctx.createBuffer(1, len, ctx.sampleRate));
    if (!buf) return false;
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + w * 0.029;
      b1 = 0.985 * b1 + w * 0.075;
      b2 = 0.95 * b2 + w * 0.15;
      d[i] = (b0 + b1 + b2) * 0.9;
    }
    this.noise = buf;

    // 总线：优先带压缩器，不支持则直接 master
    const master = safe(() => ctx.createGain());
    if (!master) return false;
    master.gain.value = this.params.masterVolume;
    const comp = safe(() => ctx.createDynamicsCompressor());
    if (comp) {
      comp.threshold.value = -12; comp.knee.value = 20; comp.ratio.value = 4;
      comp.attack.value = 0.003; comp.release.value = 0.25;
      safe(() => { master.connect(comp); comp.connect(ctx.destination); });
    } else {
      this.degraded.push('compressor');
      safe(() => master.connect(ctx.destination));
    }
    this.master = master;

    /* ---------------- 海浪 ---------------- */
    const wSrc = safe(() => ctx.createBufferSource());
    if (wSrc) {
      wSrc.buffer = buf; wSrc.loop = true;
      const wLP = safe(() => ctx.createBiquadFilter());
      const wGain = safe(() => ctx.createGain());
      if (wLP && wGain) {
        wLP.type = 'lowpass'; wLP.frequency.value = 520; wLP.Q.value = 0.7;
        wGain.gain.value = 0;
        safe(() => { wSrc.connect(wLP); wLP.connect(wGain); wGain.connect(master); });
        // 涌浪起伏：慢 LFO 调制音量
        const lfo1 = safe(() => ctx.createOscillator());
        const lfo1g = safe(() => ctx.createGain());
        if (lfo1 && lfo1g) {
          lfo1.frequency.value = 0.11; lfo1g.gain.value = 0.28;
          safe(() => { lfo1.connect(lfo1g); lfo1g.connect(wGain.gain); lfo1.start(); });
        } else this.degraded.push('waveLFO');
        // 亮度起伏
        const lfo2 = safe(() => ctx.createOscillator());
        const lfo2g = safe(() => ctx.createGain());
        if (lfo2 && lfo2g) {
          lfo2.frequency.value = 0.07; lfo2g.gain.value = 170;
          safe(() => { lfo2.connect(lfo2g); lfo2g.connect(wLP.frequency); lfo2.start(); });
        }
        this.waveGain = wGain;
        safe(() => wSrc.start());
      }
    }

    /* ---------------- 风 ---------------- */
    const fSrc = safe(() => ctx.createBufferSource());
    if (fSrc) {
      fSrc.buffer = buf; fSrc.loop = true;
      const fBP = safe(() => ctx.createBiquadFilter());
      const fGain = safe(() => ctx.createGain());
      if (fBP && fGain) {
        fBP.type = 'bandpass'; fBP.frequency.value = 780; fBP.Q.value = 0.8;
        fGain.gain.value = 0;
        safe(() => { fSrc.connect(fBP); fBP.connect(fGain); fGain.connect(master); });
        this.windGain = fGain; this.windFilter = fBP;
        safe(() => fSrc.start());
      }
    }

    this.ready = true;
    this.applyVolumes();
    return true;
  }

  /** 按当前参数更新各路音量 */
  applyVolumes() {
    if (!this.ready) return;
    const p = this.params;
    safe(() => { this.master.gain.value = p.soundOn ? p.masterVolume : 0; });
    if (this.waveGain) {
      const t = this.ctx.currentTime;
      safe(() => this.waveGain.gain.setTargetAtTime(
        p.soundOn ? p.waveVolume * (0.35 + 0.65 * Math.min(1, p.waveHeight / 0.6)) : 0, t, 0.4));
    }
    if (this.windGain) {
      const t = this.ctx.currentTime;
      safe(() => this.windGain.gain.setTargetAtTime(
        p.soundOn ? p.windVolume * Math.min(1, p.windStrength / 8) : 0, t, 0.5));
      safe(() => { this.windFilter.frequency.value = 600 + p.windStrength * 130; });
    }
  }

  /** 碰撞音：强度 0-1，underwater 时更闷 */
  impact(strength, underwater) {
    if (!this.ready || !this.params.soundOn) return;
    const ctx = this.ctx;
    const s = Math.max(0.05, Math.min(1, strength));
    const src = safe(() => ctx.createBufferSource());
    const f = safe(() => ctx.createBiquadFilter());
    const g = safe(() => ctx.createGain());
    if (!src || !g) return;
    src.buffer = this.noise;
    src.playbackRate.value = 0.7 + Math.random() * 0.7;
    const t = ctx.currentTime;
    if (f) {
      f.type = 'lowpass';
      f.frequency.value = underwater ? 420 : 1600 + s * 2600;
      f.Q.value = 1.1;
      safe(() => { src.connect(f); f.connect(g); });
    } else {
      safe(() => src.connect(g));
    }
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(this.params.impactVolume * s * 0.9, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18 + s * 0.25);
    safe(() => g.connect(this.master));
    safe(() => { src.start(t); src.stop(t + 0.5); });
  }

  /** 入水水花 */
  splash(strength) {
    if (!this.ready || !this.params.soundOn) return;
    const ctx = this.ctx;
    const s = Math.max(0.08, Math.min(1, strength));
    const src = safe(() => ctx.createBufferSource());
    const f = safe(() => ctx.createBiquadFilter());
    const g = safe(() => ctx.createGain());
    if (!src || !g) return;
    src.buffer = this.noise;
    src.playbackRate.value = 1.2 + Math.random() * 0.5;
    const t = ctx.currentTime;
    if (f) {
      f.type = 'bandpass'; f.Q.value = 1.0;
      f.frequency.setValueAtTime(2600, t);
      f.frequency.exponentialRampToValueAtTime(420, t + 0.34);
      safe(() => { src.connect(f); f.connect(g); });
    } else {
      safe(() => src.connect(g));
    }
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(this.params.impactVolume * s * 0.75, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    safe(() => g.connect(this.master));
    safe(() => { src.start(t); src.stop(t + 0.6); });
  }

  /**
   * 小黄鸭「嘎」。
   *
   * 合成思路：鸭子叫的本质是一个带大量谐波的锯齿波，基频在 50ms 内快速下滑，
   * 再过一层 1kHz 左右的带通做出「鼻腔」共鸣，最后叠一声极短的噪声当气流。
   * 两声连在一起（嘎-啊克），单声听起来像电子音，两声才像鸭子。
   *
   * @param strength 0-1，撞得越狠越响
   * @param pitch    音调倍率，1 = 成年鸭，1.2 = 受惊的小鸭
   */
  quack(strength = 0.8, pitch = 1) {
    if (!this.ready || !this.params.soundOn) return;
    const ctx = this.ctx;
    const now = ctx.currentTime || 0;
    // 一群鸭同时撞墙会变成机关枪，这里限一个最小间隔
    if (now - (this._lastQuack === undefined ? -9 : this._lastQuack) < 0.22) return;
    this._lastQuack = now;

    const vol = (this.params.quackVolume === undefined ? 0.9 : this.params.quackVolume)
      * Math.max(0.15, Math.min(1, strength));
    if (vol <= 0.002) return;

    const osc = safe(() => ctx.createOscillator());
    const g = safe(() => ctx.createGain());
    if (!osc || !g) return;

    const t = now + 0.01;
    const f0 = 560 * pitch * (0.92 + Math.random() * 0.16);

    safe(() => {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + 0.055);
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.86, t + 0.100);  // 第二声翘起来
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.50, t + 0.190);
    });

    const bp = safe(() => ctx.createBiquadFilter());
    if (bp) {
      bp.type = 'bandpass';
      bp.frequency.value = 1150 * pitch;
      bp.Q.value = 2.4;
      safe(() => { osc.connect(bp); bp.connect(g); });
    } else {
      this.degraded.push('quackFilter');
      safe(() => osc.connect(g));
    }

    safe(() => {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.55 * vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.10 * vol, t + 0.062);  // 第一声收尾
      g.gain.linearRampToValueAtTime(0.45 * vol, t + 0.095);       // 第二声起
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.210);
    });

    safe(() => g.connect(this.master));
    safe(() => { osc.start(t); osc.stop(t + 0.30); });

    // 气流噪声：一层很短的「沙」，没有它声音会明显是纯振荡器
    const nSrc = safe(() => ctx.createBufferSource());
    if (nSrc && this.noise) {
      const nb = safe(() => ctx.createBiquadFilter());
      const ng = safe(() => ctx.createGain());
      if (nb && ng) {
        nSrc.buffer = this.noise;
        nSrc.playbackRate.value = 1.6;
        nb.type = 'highpass';
        nb.frequency.value = 1400;
        ng.gain.setValueAtTime(0.0001, t);
        ng.gain.linearRampToValueAtTime(0.12 * vol, t + 0.015);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.130);
        safe(() => { nSrc.connect(nb); nb.connect(ng); ng.connect(this.master); });
        safe(() => { nSrc.start(t); nSrc.stop(t + 0.20); });
      }
    }
  }

  markDirty() { this.applyVolumes(); }
  update() { this.applyVolumes(); }

  dispose() {
    safe(() => this.ctx && this.ctx.close());
    this.ctx = null; this.ready = false;
  }
}
