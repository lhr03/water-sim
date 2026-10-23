import { WaterScene } from '../../core/scene.js';

const TABS = [
  { id: 'wave', name: '风浪' },
  { id: 'water', name: '水体' },
  { id: 'body', name: '物体' },
  { id: 'light', name: '灯光' },
  { id: 'sound', name: '声音' },
];

const SLIDERS = [
  // 风浪
  { group: 'wave', key: 'windDirection', label: '风向', min: 0, max: 360, step: 1, unit: '°' },
  { group: 'wave', key: 'windStrength', label: '风力', min: 0, max: 12, step: 0.1, unit: '' },
  { group: 'wave', key: 'windGust', label: '阵风', min: 0, max: 1, step: 0.01, unit: '' },
  { group: 'wave', key: 'waveHeight', label: '浪高', min: 0, max: 1.2, step: 0.01, unit: ' m' },
  { group: 'wave', key: 'wavelength', label: '波长', min: 1, max: 20, step: 0.1, unit: ' m' },
  { group: 'wave', key: 'waveSpeed', label: '浪速', min: 0.2, max: 2.5, step: 0.01, unit: '×' },
  { group: 'wave', key: 'choppiness', label: '细碎度', min: 0, max: 1, step: 0.01, unit: '' },
  { group: 'wave', key: 'waveSpread', label: '波向扩散', min: 0, max: 180, step: 1, unit: '°' },
  // 水体
  { group: 'water', key: 'waterLevel', label: '水位', min: -0.6, max: 0.6, step: 0.01, unit: ' m' },
  { group: 'water', key: 'waterOpacity', label: '透明度', min: 0.2, max: 1, step: 0.01, unit: '' },
  { group: 'water', key: 'foamAmount', label: '浪尖白沫', min: 0, max: 1, step: 0.01, unit: '' },
  // 物体
  { group: 'body', key: 'density', label: '密度', min: 0.15, max: 1.6, step: 0.01, unit: '' },
  { group: 'body', key: 'restitution', label: '弹性', min: 0, max: 1, step: 0.01, unit: '' },
  { group: 'body', key: 'waterDrag', label: '水阻力', min: 0, max: 3, step: 0.01, unit: '×' },
  { group: 'body', key: 'objectScale', label: '物体尺寸', min: 0.5, max: 2.5, step: 0.05, unit: ' m' },
];

const LAMP_SLIDERS = [
  { key: 'intensity', label: '亮度', min: 0, max: 400, step: 5, unit: '' },
  { key: 'azimuth', label: '方位', min: 0, max: 360, step: 1, unit: '°' },
  { key: 'radius', label: '距池心', min: 2, max: 18, step: 0.1, unit: ' m' },
  { key: 'height', label: '高度', min: 0.2, max: 10, step: 0.1, unit: ' m' },
];

const SOUND_SLIDERS = [
  { key: 'masterVolume', label: '总音量', min: 0, max: 1, step: 0.01 },
  { key: 'waveVolume', label: '海浪', min: 0, max: 1, step: 0.01 },
  { key: 'windVolume', label: '风声', min: 0, max: 1, step: 0.01 },
  { key: 'impactVolume', label: '碰撞', min: 0, max: 1, step: 0.01 },
];

const QUALITY_NAME = { low: '流畅', mid: '均衡', high: '精细' };

Page({
  data: {
    loading: true,
    panelOpen: true,
    tab: 'wave',
    tabName: '风浪',
    mode: 'drop',
    count: 0,
    qualityName: '均衡',
    tabs: TABS,
    sliders: SLIDERS,
    lampSliders: LAMP_SLIDERS,
    soundSliders: SOUND_SLIDERS,
    waterColors: ['#1d7fd0', '#0e5fa8', '#2fb4c8', '#1a9e8f', '#3a6fd8', '#7a5fc8'],
    lampColors: ['#ffb066', '#5ec8ff', '#ff6ec7', '#a5d6a7', '#ffd966', '#ff8a65'],
    params: {},
  },

  onLoad(query) {
    this.quality = query.quality || 'mid';
    this.setData({ qualityName: QUALITY_NAME[this.quality] || '均衡' });
    wx.setNavigationBarTitle({ title: '水世界 · 泳池' });
  },

  onReady() {
    wx.createSelectorQuery()
      .select('#webgl')
      // size 一起查：小程序的画布不会自己量尺寸，必须把布局宽高告诉渲染器
      .fields({ node: true, size: true })
      .exec((res) => {
        const r = res && res[0];
        const node = r && r.node;
        if (!node) {
          wx.showToast({ title: '无法获取画布', icon: 'none' });
          return;
        }
        let dpr = 2;
        try { dpr = wx.getSystemInfoSync().pixelRatio || 2; } catch (e) { /* 取不到就用 2 */ }
        try {
          this.scene = new WaterScene({
            canvas: node,
            width: r.width,
            height: r.height,
            dpr,
            quality: this.quality,
            onEvent: () => this.setData({ count: this.scene.count }),
          });
          // 初始丢几个物体，一进来就能看到互撞
          for (let i = 0; i < 5; i++) this.scene.spawn('random');
          this.setData({ loading: false, params: this.scene.params, count: this.scene.count });
          this.scene.start();
        } catch (e) {
          console.error('[water] 初始化失败', e);
          this.setData({ loading: false });
          wx.showModal({
            title: '场景初始化失败',
            content: String((e && e.message) || e).slice(0, 120),
            showCancel: false,
          });
        }
      });
  },

  onUnload() {
    if (this.scene) { this.scene.dispose(); this.scene = null; }
  },

  onHide() { if (this.scene) this.scene.stop(); },
  onShow() { if (this.scene) { this.scene.start(); this._syncSize(); } },

  /* ---------------------- 触摸 ---------------------- */

  onTouchStart(e) { this.scene && this.scene.handleTouch('touchstart', e); },
  onTouchMove(e) { this.scene && this.scene.handleTouch('touchmove', e); },
  onTouchEnd(e) { this.scene && this.scene.handleTouch('touchend', e); },
  onTap(e) { this.scene && this.scene.handleTouch('tap', e); },

  /* ---------------------- 面板 ---------------------- */

  onTogglePanel() {
    this.setData({ panelOpen: !this.data.panelOpen }, () => {
      // 面板展开/收起会改变画布高度，等布局稳定后再同步尺寸，否则画面被拉伸变形
      setTimeout(() => this._syncSize(), 80);
    });
  },

  _syncSize() {
    if (!this.scene) return;
    wx.createSelectorQuery()
      .select('#webgl')
      .fields({ size: true })
      .exec((res) => {
        const r = res && res[0];
        if (r && r.width && r.height && this.scene) this.scene.resize(r.width, r.height);
      });
  },

  onTab(e) {
    const t = e.currentTarget.dataset.t;
    const found = TABS.find((x) => x.id === t);
    this.setData({ tab: t, tabName: found ? found.name : '' });
  },

  onMode(e) {
    const m = e.currentTarget.dataset.m;
    if (!this.scene) return;
    this.scene.setMode(m);
    this.setData({ mode: m });
    wx.showToast({
      title: m === 'view' ? '视角模式：拖动旋转，双指缩放' : '投放模式：点水面丢物体，按住可拖动',
      icon: 'none',
      duration: 1800,
    });
  },

  /* ---------------------- 滑块 ---------------------- */

  onSlider(e) {
    if (!this.scene) return;
    const key = e.currentTarget.dataset.key;
    const v = Number(e.detail.value);
    this.scene.params[key] = v;
    this.setData({ [`params.${key}`]: v });

    if (key === 'waterLevel' || key === 'waterOpacity' || key === 'foamAmount') {
      this.scene.refreshWater();
    } else if (key === 'density') {
      this.scene.applyDensity(v);
    } else if (key === 'restitution' || key === 'waterDrag' || key === 'objectScale') {
      this.scene.refreshPhysics();
    } else {
      this.scene.refreshWave();
    }
  },

  onLampSlider(e) {
    if (!this.scene) return;
    const i = Number(e.currentTarget.dataset.i);
    const key = e.currentTarget.dataset.key;
    const v = Number(e.detail.value);
    this.scene.params.lights[i][key] = v;
    this.setData({ [`params.lights[${i}].${key}`]: v });
    this.scene.updateLights();
  },

  onLampToggle(e) {
    if (!this.scene) return;
    const i = Number(e.currentTarget.dataset.i);
    const on = !!e.detail.value;
    this.scene.params.lights[i].on = on;
    this.setData({ [`params.lights[${i}].on`]: on });
    this.scene.updateLights();
  },

  onLampColor(e) {
    if (!this.scene) return;
    const i = Number(e.currentTarget.dataset.i);
    const c = e.currentTarget.dataset.c;
    this.scene.params.lights[i].color = c;
    this.setData({ [`params.lights[${i}].color`]: c });
    this.scene.updateLights();
  },

  onWaterColor(e) {
    if (!this.scene) return;
    const c = e.currentTarget.dataset.c;
    this.scene.params.waterColor = c;
    this.setData({ 'params.waterColor': c });
    this.scene.refreshWater();
  },

  onSoundToggle(e) {
    if (!this.scene) return;
    const on = !!e.detail.value;
    this.scene.params.soundOn = on;
    this.setData({ 'params.soundOn': on });
    if (on) {
      const ok = this.scene.audio.init();
      if (!ok) wx.showToast({ title: '当前微信版本不支持音效', icon: 'none' });
    }
    this.scene.audio.applyVolumes();
  },

  onSoundSlider(e) {
    if (!this.scene) return;
    const key = e.currentTarget.dataset.key;
    const v = Number(e.detail.value);
    this.scene.params[key] = v;
    this.setData({ [`params.${key}`]: v });
    this.scene.audio.applyVolumes();
  },

  /* ---------------------- 操作 ---------------------- */

  onAdd() {
    if (!this.scene) return;
    this.scene.spawn('random');
    this.setData({ count: this.scene.count });
  },

  onClear() {
    if (!this.scene) return;
    this.scene.clearObjects();
    this.setData({ count: 0 });
  },

  onResetView() {
    if (!this.scene) return;
    this.scene.camera.position.set(17, 11, 20);
    this.scene.controls.target.set(0, 0, 0);
    this.scene.controls.update();
  },

  onImport() {
    if (!this.scene) return;
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['glb', 'gltf', 'obj', 'stl'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0];
        if (!f) return;
        wx.showLoading({ title: '解析中…' });
        this.scene.importModel(f.path, f.name)
          .then(() => {
            wx.hideLoading();
            this.setData({ count: this.scene.count });
            wx.showToast({ title: '导入成功', icon: 'success' });
          })
          .catch((err) => {
            wx.hideLoading();
            wx.showModal({
              title: '导入失败',
              content: String((err && err.message) || err).slice(0, 140),
              showCancel: false,
            });
          });
      },
      fail: () => {},
    });
  },

  onShareAppMessage() {
    return { title: '水世界 · 3D 水中碰撞模拟器', path: '/pages/index/index' };
  },
});
