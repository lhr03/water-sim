App({
  onLaunch() {
    // 记录设备信息，3D 页面据此做画质分档
    const info = wx.getSystemInfoSync ? wx.getSystemInfoSync() : wx.getDeviceInfo();
    this.globalData = {
      pixelRatio: info.pixelRatio || 2,
      benchmarkLevel: info.benchmarkLevel || -1, // 只有安卓有，iOS 为 -1
      platform: info.platform || 'devtools',
    };
  },
  globalData: {
    pixelRatio: 2,
    benchmarkLevel: -1,
    platform: 'devtools',
  },
});
