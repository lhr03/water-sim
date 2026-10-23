// 全局可调参数（所有滑块都绑定到这个对象上）
export const params = {
  // ---- 风 ----
  windDirection: 40,      // 风向（度）
  windStrength: 3.0,      // 风力 0-12
  windGust: 0.45,         // 阵风扰动 0-1

  // ---- 浪 ----
  waveHeight: 0.28,       // 浪高（米）
  wavelength: 7.0,        // 主波长（米）
  waveSpeed: 1.0,         // 浪速倍率
  choppiness: 0.5,        // 细碎程度
  waveSpread: 45,         // 波向扇形扩散（度）

  // ---- 水体 ----
  waterLevel: 0.0,        // 水位（米）
  waterColor: '#1d7fd0',  // 水体颜色
  waterOpacity: 0.80,
  waterRoughness: 0.07,
  foamAmount: 0.55,       // 浪尖白沫
  fresnelOn: true,        // 菲涅尔反射开关
  fresnelStrength: 1.0,   // 反射强度 0-1

  // ---- 物体 ----
  density: 0.45,          // 物体密度（相对水，1.0 = 与水同重）
  restitution: 0.28,      // 弹性
  friction: 0.35,         // 摩擦
  waterDrag: 1.0,         // 水阻力倍率
  linearDamping: 0.08,
  angularDamping: 0.22,
  objectScale: 1.20,      // 导入模型归一化尺寸（米）

  // ---- 光影 ----
  // timeOfDay 是「时刻」（0~24 小时），太阳高度与方位都由它推出来：
  // 6 点日出、12 点最高、18 点日落。sunElevation / sunAzimuth 是派生值，
  // 不要手改——改了就变成两个真相源，滑到某个时刻画面却不变。
  timeOfDay: 8.3,
  sunAzimuth: 135,
  sunElevation: 38,
  sunStrength: 1.0,       // 阳光强度倍率，阴天感就往下拉

  exposure: 1.05,
  shadows: true,
  bloom: true,
  bloomStrength: 0.22,

  // ---- 3 盏可控制的日式石灯笼 ----
  // outset = 从池边往外挪多远（平台宽 4 米，所以上限 2.4）
  lights: [
    { on: true, color: '#ffb066', intensity: 90, azimuth: 45, outset: 0.9, height: 2.8, shadows: false },
    { on: true, color: '#5ec8ff', intensity: 90, azimuth: 165, outset: 0.6, height: 2.8, shadows: false },
    { on: true, color: '#ff6ec7', intensity: 80, azimuth: 290, outset: 1.2, height: 3.4, shadows: false },
  ],

  // ---- 声音 ----
  soundOn: false,
  masterVolume: 0.8,
  waveVolume: 0.65,
  windVolume: 0.35,
  impactVolume: 0.8,
  quackVolume: 0.9,       // 小黄鸭叫

  // ---- 运行 ----
  paused: false,
  waterDensity: 100,      // 物理用“水密度”（缩放过的工程单位）
};

export const POOL = {
  innerX: 22,   // 池内长（x）
  innerZ: 14,   // 池内宽（z）
  depth: 3.2,   // 池深（水面 0 → 池底 -depth）
  wallThickness: 0.45,
  wallHeight: 0.85, // 池壁高出水面的部分
};
