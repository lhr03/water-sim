# 水世界 · 微信小程序版

网页版的 3D 水中碰撞模拟器移植到微信小程序。**先做的精简版**：保住核心玩法，砍掉手机上吃不消的特效，跑通之后再逐项加回来。

- 渲染：[three-platformize](https://github.com/deepkolos/three-platformize) 1.133.3（platformized three，微信/淘宝/字节真机均验证过）
- 物理：cannon-es（纯 JS，无需改动）
- 与网页版共用同一套 `core/` 物理与波浪代码

---

## 手机版保留了什么 / 砍了什么

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 泳池边界（四面墙 + 池底刚体碰撞） | ✅ | 含水面之上 4 面隐形挡板，防大浪把物体推出池外 |
| 风 / 浪滑块（风向、风力、阵风、浪高、波长、浪速、细碎度、扩散） | ✅ | 实时生效 |
| 浮力物理（浮心受力、随浪翻滚、互相碰撞） | ✅ | 32 探针浸没体积模型 |
| 模型导入 | ❌ | 小程序沙箱没有 FileReader/URL，GLTFLoader 取贴图必失败，实测绝大多数模型导不进来，已整体移除（顺带省下约 0.3MB 分包体积） |
| 内置物体 | ✅ | 9 种：充气球、小黄鸭、木箱、油桶、浮板、救生圈、多面体、浮木、浮块；可指定「点水面丢什么」 |
| 一键场景预设 | ✅ | 平静 / 微风 / 大浪 / 台风，一键切换整套风浪参数 |
| 推一把 | ✅ | 给所有漂浮物一个按质量缩放的随机冲量，附轻微震动反馈 |
| 环绕模式 | ✅ | 镜头自动转圈，适合摆在桌上或录屏 |
| 同屏上限 | ✅ | 40 个，超出自动捞走最早的（每个物体每帧 32 次水面采样） |
| 3 盏可控石灯笼 | ✅ | 日式石灯籠（基础/竿/中台/火袋/笠/宝珠），开关 / 亮度 / 颜色 / 方位 / 离池边 / 灯芯高度 |
| 水面菲涅尔反射 | ✅ | 掠射角把水面染成天空色 + 太阳碎光；可开关、强度可调 |
| 白沫 | ✅ | 浪尖 + 陡坡 + 舔岸三路合成，再用流动噪声打碎成斑块（不再是整齐的白色横带） |
| 池边石材 | ✅ | 程序化石板纹理 + 池壁压顶石，池口有一圈凸起的石边 |
| 小黄鸭叫声 | ✅ | 实时合成「嘎-啊克」，碰撞 / 入水 / 被拎起来都会叫 |
| 程序化音效（海浪、风、入水、撞击） | ✅ | `wx.createWebAudioContext`，节点逐个容错降级 |
| 内置物体 + 点击投放 + 拖拽 | ✅ | |
| 画质分档（流畅 / 均衡 / 精细） | ✅ | 决定 pixelRatio、阴影、水面网格密度 |
| 帧率不足自动降档 | ✅ | 连续 3 秒低于 24 fps 就退一档：分辨率 → 阴影 → 同屏物体 |
| 程序化天空 + PMREM 环境反射 | ❌ | 手机上开销大，且部分机型生成 envMap 会出错；改用双色天空 + 菲涅尔近似（见上） |
| Bloom 辉光后处理 | ❌ | 帧率代价高 |
| 池底动态焦散 | ❌ | 省一层 shader |
| Draco 压缩的 glTF | ❌ | 已随导入功能一起去掉 |
| FBX 导入 | ❌ | 同上，导入功能已移除 |

水面网格从网页版的 200×200（4 万顶点）降到：流畅 48²、均衡 96²、精细 160²。

---

## 从零到能跑：六步

### 1. 注册小程序账号（免费，个人主体当天可用）

1. 打开 <https://mp.weixin.qq.com> → 右上角「立即注册」→ 选**小程序**
2. 填一个**没注册过微信公众平台的邮箱**，收激活邮件后设置密码
3. 主体类型选 **个人**（免费、无需营业执照；企业主体要 300 元认证）
4. 完成实名（身份证 + 微信扫码验证管理员身份）

### 2. 拿到 AppID

登录 mp 后台 → 左侧「开发」→「开发管理」→「开发设置」→ 复制 **AppID**（形如 `wx` 开头 18 位）。

然后打开本目录下的 `project.config.json`，把 `"appid"` 换成你的 AppID。

### 3. 安装微信开发者工具

<https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html>
下 **Windows 64 位稳定版**，装完用微信扫码登录。

### 4. 导入项目

开发者工具 →「导入项目」：
- 目录：选 **`miniprogram`** 这一层（不是它的上层）
- AppID：填你自己的；想先看效果也可以选「测试号」，但测试号不能上传发布

### 5. 直接点「编译」就行——**不需要构建 npm**

这个项目**刻意不走**微信的「构建 npm」。原因：开发者的「构建 npm」会把整个 npm 包复制进
`miniprogram_npm`，而 `three-platformize` 光 `examples/` 就有 9.5 MB、整包 14 MB，
远超小程序单个分包 2 MB 的上限，一上传就会失败。

所以改用了精确抽取：`scripts/vendor-lib.mjs` 按 import 图只挑真正用到的文件，
拷进 `pkg-water/lib/`，代码里全部用相对路径引用。**库已经抽好并放在仓库里，直接编译即可。**

只有在要升级 three 版本时才需要重新抽取：

```bash
npm install          # 装 three-platformize / cannon-es 到 node_modules（仅抽取时的来源）
npm run vendor       # 按 import 图抽取到 pkg-water/lib/
npm run verify       # 在 Node 里跑一遍模块图与物理，确认没抽漏
```

### 6. 预览与发布

- **模拟器**里点编译即可看到效果（3D 在模拟器上也能跑，但帧率不代表真机）
- **真机**：点「预览」，用手机微信扫码（**必须真机验证**，模拟器性能与真机差异很大）
- **发布**：点「上传」→ 回 mp 后台「版本管理」→ 提交审核 → 审核通过后「发布」

> 个人主体的小程序类目有限制，选「工具 → 效率」或类似即可，不要选需要资质的类目。

---

## 目录结构

```
miniprogram/
├── app.js / app.json / app.wxss      # 主包：只放首页
├── project.config.json               # AppID
├── package.json                      # 仅用于抽取依赖，不在运行时使用
├── scripts/
│   ├── vendor-lib.mjs                # 按 import 图抽取依赖 → pkg-water/lib/
│   └── verify.mjs                    # Node 里跑模块图 + 物理自检
├── pages/index/                      # 首页：画质选择 + 进入
└── pkg-water/                        # 分包（three 在这里，不占主包 2MB 额度）
    ├── pages/water/                  # 3D 页面：canvas + 控制面板
    ├── core/                         # 与网页版同源的物理/波浪逻辑
    │   ├── config.js  water.js  physics.js
    │   └── pool.js    objects.js  scene.js  audio.js
    └── lib/                          # 抽取后的依赖（1.7 MB，已入库）
        ├── build/three.module.js     # three r133 + 平台化补丁
        ├── cannon-es.js
        ├── src/WechatPlatform/       # 微信平台适配层
        └── examples/jsm/             # 只留 GLTF/OBJ/STL loader、ConvexHull、OrbitControls
```

**为什么 three 要放分包**：小程序主包上限 2 MB，单个分包也是 2 MB。
three 加上 loader 超过 1 MB，放主包会直接爆。所以首页留在主包，3D 页面整体挪到 `pkg-water` 分包。
抽取后的 `lib/` 共 1.7 MB，上传时会被压缩，在 2 MB 上限内。

---

## 已踩过的坑（改代码时留意）

1. **微信纹理不能超过 2048**，池壁瓷砖纹理固定 256。
2. **pixelRatio 不要设成 3**，iOS 容易崩；这里按画质档位钳制在 1.0 / 1.5 / 2.0。
3. **three 版本是 0.133 不是 0.169**，API 有差异：
   - `renderer.outputEncoding = THREE.sRGBEncoding`（不是 `outputColorSpace`）
   - 纹理用 `tex.encoding`（不是 `tex.colorSpace`）
   - 灯光是传统单位，所以渲染器设了 `physicallyCorrectLights = true` 来对齐网页版的强度数值
4. **没有 DOM**：瓷砖纹理用 `wx.createOffscreenCanvas`，不能用 `document.createElement('canvas')`（适配层那个 createElementNS 返回的是主画布，拿来画纹理会出事）。
5. **读本地文件**要用 `wx.getFileSystemManager().readFileSync()` 拿 ArrayBuffer 再 `loader.parse()`，没有 FileReader 也没有 URL。
6. **触摸事件**由 `platform.dispatchTouchEvent()` 转成 pointer 事件再派发给 canvas，OrbitControls 才能工作。

---

## 验证情况

物理与波浪逻辑用 three 0.133 在 Node 里跑过：波浪场、浮力平衡、密度浮沉、池壁边界（60 N 强推 10 秒仍被挡在池内）、凸包生成，以及渲染层用到的 30 个 three API 存在性——全部通过。

**没法替你验证的部分**：真机渲染效果、帧率、发热。这部分必须你在手机上扫预览码看。
