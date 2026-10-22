# 水世界 · 3D 水中碰撞模拟器

浏览器里跑的 3D 水域物理沙盒：一个带边界的蓝色泳池，可调风向风力与波浪，把任意 3D 模型丢进去，它们会**真的浮起来**、随浪起伏、互相碰撞，并伴有实时合成的水声与撞击声。

基于 **three.js + cannon-es**，纯前端，无需后端。也可打包成一个 **8.6 MB 的单文件 exe**，双击即用、零依赖。

---

## 特性

| 需求 | 实现方式 |
| --- | --- |
| 水 + 风 + 浪 | 6 组正弦波（Gerstner 近似）叠加成波浪场，JS 与 GLSL **双份一致实现**——物理算的高度和画面看到的波形严格对齐 |
| 可调滑块 | 风向 / 风力 / 阵风、浪高 / 波长 / 浪速 / 细碎度 / 波向扩散，全部实时生效 |
| 导入常见模型 | `.glb` `.gltf` `.obj` `.fbx` `.stl`，按钮选择或直接拖进窗口；STL 无材质时自动补亮色材质 |
| 有边界的蓝色水体 | 22 × 14 × 3.2 m 泳池，蓝瓷砖池壁池底 + 蓝色半透明水面；四面墙与池底都是刚体，撞得到 |
| 浮在水面互相碰撞 | 每个物体 27 个浮力探针求浸没体积，浮力施加在**浮心**而非质心——所以会自然扶正、随浪倾斜翻滚 |
| 好的光影 | 程序化天空 + PMREM 环境反射 + 定向光软阴影 + ACES 色调映射 + 辉光，池底带动态焦散 |
| 3 盏可控灯 | 每盏独立控制开关 / 亮度 / 颜色 / 方位 / 距池心 / 高度 / 投影，含自发光灯泡与灯杆；另有「黄昏场景」一键预设 |
| 音效 | 全部 WebAudio **实时合成**（无音频文件）：海浪、风声、入水水花、按冲量强度变化的撞击声 |

---

## 快速开始

### 方式 A：直接下载 exe（不需要任何环境）

到 [Releases](../../releases) 下载 `水世界.exe`，双击即可。它自带运行时，不要求本机装 Python / Node。

> 少数杀毒软件会对 PyInstaller 打包的程序误报（因为运行时会自解压到临时目录），放行即可。

### 方式 B：从源码运行

需要 **Node 18+**（仅用于起本地服务器；Python 只在打包 exe 时才需要）。

```bash
git clone https://github.com/lhr03/water-sim.git
cd water-sim
npm install     # 会自动把 three/cannon-es 同步到 vendor/
npm start       # 打开 http://127.0.0.1:8123
```

`npm install` 后的 `postinstall` 会执行 `scripts/sync-vendor.mjs`，把依赖拷进 `vendor/` 供 importmap 引用，所以运行时不需要 webpack / vite 之类的打包工具。

Windows 用户也可以直接双击 `start.bat`（走 `serve.py`，需要 Python 3）。

> 为什么不能直接双击 `index.html`：页面用了 ES Module + importmap，浏览器只在 http(s) 协议下才放行。

---

## 操作

- **投放模式**（默认，左上角按钮可切换）
  - 点击水面 → 在该位置投入一个物体
  - 按住物体拖动 → 拎着它走
- **视角模式**：左键旋转 / 滚轮缩放 / 右键平移
- 右侧面板：参数滑块 + 物体库 + 清空、重置等操作
- 右下角面板：声音开关与音量

想让物体沉下去，把「密度」调到 > 1；调到 < 1 则浮得更高。

---

## 目录结构

```
water-sim/
├── index.html          # 入口（importmap 指向 vendor/）
├── src/
│   ├── main.js         # 场景装配、渲染循环、交互
│   ├── config.js       # 全部可调参数的默认值
│   ├── water.js        # 波浪场（JS 版，供物理用）
│   ├── pool.js         # 泳池几何、瓷砖材质、边界碰撞盒
│   ├── physics.js      # 浮力 / 水阻 / 风力 / 碰撞事件
│   ├── objects.js      # 内置物体库、模型导入、凸包碰撞体
│   ├── audio.js        # WebAudio 程序化音效
│   └── ui.js           # 控制面板（配置驱动生成）
├── scripts/
│   ├── sync-vendor.mjs # node_modules → vendor
│   └── serve.mjs       # 零依赖静态服务器
├── desktop.py          # exe 版入口（内嵌 http 服务 + 拉起浏览器窗口）
├── build_exe.py        # 打包脚本：依赖闭包裁剪 + 生成图标 + PyInstaller
├── serve.py            # Python 版静态服务器（给 start.bat 用）
├── selftest.mjs        # Node 端物理自检
└── start.bat           # Windows 一键启动
```

---

## 浮力是怎么算的

浮力是这个项目最核心的部分，简单说三步：

1. 在物体包围盒内均匀撒 **27 个探针**，每帧用波浪场求出每个探针处的**水面高度**。
2. 探针低于水面的部分累积成**浸没体积**，这些浸没探针的几何中心即**浮心**。
3. 施加 `F = ρ_water · g · V_submerged`，方向向上，**作用点在浮心**。

因为作用点不在质心，物体会受到恢复力矩，于是会自然扶正、随浪翻转——这是让画面"像真的漂着"的关键。此外还有：

- **水阻力**：线性 + 二次阻尼，且只在浸没部分生效
- **风力**：按迎风面积估算，带阵风扰动
- **碰撞**：cannon-es 的凸包碰撞体（点集先粗化再求凸包），撞击冲量会驱动音效强度

---

## 打包成 exe

```bash
pip install pyinstaller
python build_exe.py
```

产物在 `dist/水世界.exe`。脚本做三件事：

1. 从 `index.html` 的 importmap 出发做**静态依赖闭包扫描**，只把真正用到的 addons 拷进 `build/web`（37 个文件 / 3.75 MB，而不是整个 12 MB 的 addons）
2. 纯 Python 手写 ICO 图标（水波纹，BMP/DIB 32bpp）
3. 调 PyInstaller `--onefile --noconsole`

---

## 自检

```bash
npm test
```

`selftest.mjs` 在 Node 里跑通 9 组断言：波浪场数值、内置物体模板、凸包与体积计算、浮力平衡（木箱稳定漂在 y ≈ -0.13）、密度浮沉（0.25 浮 / 1.1 沉底）、池壁边界（60 N 强推 10 秒仍被挡在池内）、风推动、以及用 three 真实 shader 源码验证水面/焦散着色器的注入锚点。

---

## 已知限制

- 波浪是**高度场**近似，不做真实的流体求解，因此没有漩涡、破碎浪和物体间水体耦合
- 浮力用探针离散采样，极端细长的模型会有误差
- 音效是程序化合成的，风格偏"白噪音写实"，不是录音素材
- 只做了单实例保护：重复双击 exe 会复用已开的窗口，不会起第二个

---

## 技术栈

- [three.js](https://github.com/mrdoob/three.js) 0.169 — 渲染、天空、后处理
- [cannon-es](https://github.com/pmndrs/cannon-es) 0.20 — 刚体物理
- WebAudio API — 程序化音效
- PyInstaller — 单文件 exe 打包

---

## 许可证

[MIT](./LICENSE) © 2026 lhr03

依赖的 three.js 与 cannon-es 同样为 MIT，版权归各自作者所有。
