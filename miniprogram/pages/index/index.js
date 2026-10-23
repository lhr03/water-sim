const app = getApp();

Page({
  data: {
    quality: 'mid',
  },

  onLoad() {
    // 按设备性能给一个默认画质：安卓有 benchmarkLevel，iOS 只能按机型猜
    const lv = (app.globalData && app.globalData.benchmarkLevel) || -1;
    let q = 'mid';
    if (lv > 0 && lv < 15) q = 'low';
    else if (lv >= 25) q = 'high';
    this.setData({ quality: q });
  },

  onQuality(e) {
    this.setData({ quality: e.currentTarget.dataset.q });
  },

  onEnter() {
    wx.navigateTo({
      url: `/pkg-water/pages/water/index?quality=${this.data.quality}`,
    });
  },

  onShareAppMessage() {
    return { title: '浮力演示台 · 3D 水中碰撞模拟器', path: '/pages/index/index' };
  },
});
