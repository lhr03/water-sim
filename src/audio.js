/**
 * 纯程序化音频：不依赖任何音频文件，全部用 WebAudio 实时合成
 *  - 海浪：粉噪 → 低通，两个慢速 LFO 调制音量与亮度（涌浪 + 拍岸）
 *  - 风声：噪声 → 带通，随风力变化
 *  - 碰撞：噪声脉冲 + 低频“咚”，按撞击强度决定音量/音色，水下更闷
 *  - 入水：带通扫频噪声（“哗啦”的水花）
 */
export class AudioEngine {
  constructor(params) {
    this.params = params;
    this.ctx = null;
    this.ready = false;
    this.active = 0;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    const ctx = new AC();
    this.ctx = ctx;

    // 噪声源
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + w * 0.029;
      b1 = 0.985 * b1 + w * 0.075;
      b2 = 0.95 * b2 + w * 0.15;
      d[i] = (b0 + b1 + b2) * 0.9;   // 近似粉噪
    }
    this.noise = buf;

    // 总线
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 20; comp.ratio.value = 4;
    comp.attack.value = 0.003; comp.release.value = 0.25;
    const master = ctx.createGain();
    master.gain.value = this.params.masterVolume;
    master.connect(comp);
    comp.connect(ctx.destination);
    this.master = master;

    // ---- 海浪 ----
    const wSrc = ctx.createBufferSource();
    wSrc.buffer = buf; wSrc.loop = true;
    const wLP = ctx.createBiquadFilter();
    wLP.type = 'lowpass'; wLP.frequency.value = 420; wLP.Q.value = 0.6;
    const wGain = ctx.createGain();
    wGain.gain.value = 0.0;
    wSrc.connect(wLP); wLP.connect(wGain); wGain.connect(master);
    // 涌浪 LFO（音量）
    const lfo1 = ctx.createOscillator();
    lfo1.frequency.value = 0.075;
    const lfo1g = ctx.createGain(); lfo1g.gain.value = 0.30;
    lfo1.connect(lfo1g); lfo1g.connect(wGain.gain);
    // 明暗 LFO（滤波器）
    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.11;
    const lfo2g = ctx.createGain(); lfo2g.gain.value = 180;
    lfo2.connect(lfo2g); lfo2g.connect(wLP.frequency);
    // 细碎水声（高频层）
    const wHP = ctx.createBiquadFilter();
    wHP.type = 'highpass'; wHP.frequency.value = 1800;
    const wGain2 = ctx.createGain(); wGain2.gain.value = 0.0;
    wSrc.connect(wHP); wHP.connect(wGain2); wGain2.connect(master);

    wSrc.start(); lfo1.start(); lfo2.start();
    this.waveGain = wGain;
    this.waveGain2 = wGain2;

    // ---- 风 ----
    const fSrc = ctx.createBufferSource();
    fSrc.buffer = buf; fSrc.loop = true;
    const fBP = ctx.createBiquadFilter();
    fBP.type = 'bandpass'; fBP.frequency.value = 700; fBP.Q.value = 0.7;
    const fGain = ctx.createGain(); fGain.gain.value = 0.0;
    fSrc.connect(fBP); fBP.connect(fGain); fGain.connect(master);
    const lfo3 = ctx.createOscillator(); lfo3.frequency.value = 0.19;
    const lfo3g = ctx.createGain(); lfo3g.gain.value = 0.16;
    lfo3.connect(lfo3g); lfo3g.connect(fGain.gain);
    fSrc.start(); lfo3.start();
    this.windGain = fGain;

    this.ready = true;
    this.applyVolumes();
    return true;
  }

  applyVolumes() {
    if (!this.ready) return;
    const p = this.params;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(p.soundOn ? p.masterVolume : 0, t, 0.08);
    const waveBase = p.soundOn ? p.waveVolume * (0.12 + Math.min(1, p.waveHeight / 0.9) * 0.5 + Math.min(1, p.windStrength / 12) * 0.25) : 0;
    const chop = p.soundOn ? p.waveVolume * p.choppiness * 0.16 : 0;
    const windBase = p.soundOn ? p.windVolume * Math.min(1, p.windStrength / 10) * 0.5 : 0;
    this.waveGain.gain.setTargetAtTime(waveBase * 0.55, t, 0.4);
    this.waveGain2.gain.setTargetAtTime(chop, t, 0.4);
    this.windGain.gain.setTargetAtTime(windBase * 0.4, t, 0.4);
  }

  _pan(x) {
    if (!this.ctx.createStereoPanner) return null;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, x / 14));
    return p;
  }

  /** 碰撞：strength 0-1，wet 表示在水里（更闷），pool 表示撞池壁 */
  playImpact({ strength = 0.5, wet = false, pool = false, x = 0, size = 1 } = {}) {
    if (!this.ready || !this.params.soundOn || this.active > 16) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const vol = this.params.impactVolume * Math.min(1, strength * 1.1 + 0.12) * (wet ? 0.55 : 1.0);
    if (vol < 0.01) return;
    this.active++;

    const dest = this._pan(x) || this.master;
    if (dest !== this.master) dest.connect(this.master);

    // 噪声脉冲（撞击的“擦/拍”）
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    src.playbackRate.value = 0.7 + Math.random() * 0.7;
    const f = ctx.createBiquadFilter();
    if (wet) { f.type = 'lowpass'; f.frequency.value = 300 + strength * 260; f.Q.value = 0.9; }
    else { f.type = 'bandpass'; f.frequency.value = (pool ? 900 : 1500) + Math.random() * 1800 - strength * 300; f.Q.value = 1.1; }
    const g = ctx.createGain();
    const dur = (wet ? 0.10 : 0.14) + strength * 0.14;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.002, vol * 0.85), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(t); src.stop(t + dur + 0.05);

    // 低频“咚”（体积感），大物体更低沉
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const base = (wet ? 62 : 96) * (1 / (0.6 + size * 0.6)) + 30;
    osc.frequency.setValueAtTime(base * 1.5, t);
    osc.frequency.exponentialRampToValueAtTime(base * 0.7, t + 0.12);
    const og = ctx.createGain();
    const odur = 0.10 + strength * 0.16;
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(Math.max(0.002, vol * (wet ? 0.35 : 0.6)), t + 0.008);
    og.gain.exponentialRampToValueAtTime(0.0001, t + odur);
    osc.connect(og); og.connect(dest);
    osc.start(t); osc.stop(t + odur + 0.05);

    setTimeout(() => { this.active--; }, (dur + 0.1) * 1000);
  }

  /** 入水水花 */
  playSplash({ strength = 0.5, x = 0 } = {}) {
    if (!this.ready || !this.params.soundOn || this.active > 16) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const vol = this.params.impactVolume * Math.min(1, strength * 0.9 + 0.15);
    if (vol < 0.01) return;
    this.active++;

    const dest = this._pan(x) || this.master;
    if (dest !== this.master) dest.connect(this.master);

    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    src.playbackRate.value = 1.2 + Math.random() * 0.5;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 0.8;
    f.frequency.setValueAtTime(2800, t);
    f.frequency.exponentialRampToValueAtTime(700, t + 0.34);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.002, vol * 0.7), t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(t); src.stop(t + 0.45);

    // 低频“咕咚”
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(190, t);
    osc.frequency.exponentialRampToValueAtTime(85, t + 0.18);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(Math.max(0.002, vol * 0.35), t + 0.015);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(og); og.connect(dest);
    osc.start(t); osc.stop(t + 0.3);

    setTimeout(() => { this.active--; }, 500);
  }

  update() {
    if (!this.ready) return;
    // 音量随滑块变化（节流在 UI 侧，这里只做兜底平滑）
    if (this._dirty) { this.applyVolumes(); this._dirty = false; }
  }

  markDirty() { this._dirty = true; }
}
