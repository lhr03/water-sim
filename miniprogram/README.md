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
| 模型导入 | ✅ | glb / gltf / obj / stl，从微信聊天记录选文件 |
| 3 盏可控灯 | ✅ | 开关 / 亮度 / 颜色 / 方位 / 距池心 / 高度 |
| 程序化音效（海浪、风、入水、撞击） | ✅ | `wx.createWebAudioContext`，节点逐个容错降级 |
| 内置物体 + 点击投放 + 拖拽 | ✅ | |
| 画质分档（流畅 / 均衡 / 精细） | ✅ | 决定 pixelRatio、阴影、水面网格密度 |
| 程序化天空 + PMREM 环境反射 | ❌ | 手机上开销大，且部分机型生成 envMap 会出错 |
| Bloom 辉光后处理 | ❌ | 帧率代价高 |
| 池底动态焦散 | ❌ | 省一层 shader |
| Draco 压缩的 glTF | ❌ | 需要包内 wasm，后续可加 |
| FBX 导入 | ❌ | FBXLoader 约 96 KB，精简版先不放 |

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

然后打开本目录下的 `project.config.json`，把 `"appid": "touristappid"` 换成你的 AppID。

### 3. 安装微信开发者工具

<https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html>
下 **Windows 64 位稳定版**，装完用微信扫码登录。

### 4. 导入项目

开发者工具 →「导入项目」：
- 目录：选 **`miniprogram`** 这一层（不是它的上层）
- AppID：填你自己的；想先看效果也可以选「测试号」，但测试号不能上传发布

### 5. 构建 npm（**这步不能漏**）

项目用了 npm 包，微信不会自动打包。在开发者工具里：

> 工具 → 构建 npm

会生成 `pkg-water/miniprogram_npm/`。没做这步会报「module not found」。

如果报找不到依赖，先在本目录执行 `npm install` 再重新构建。

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
├── project.config.json               # AppID、npm 构建配置
├── package.json                      # three-platformize + cannon-es
├── pages/index/                      # 首页：画质选择 + 进入
└── pkg-water/                        # 分包（three 在这里，不占主包 2MB 额度）
    ├── pages/water/                  # 3D 页面：canvas + 控制面板
    └── core/                         # 与网页版同源的物理/波浪逻辑
        ├── config.js  water.js  physics.js
        ├── pool.js    objects.js  scene.js  audio.js
```

**为什么 three 要放分包**：小程序主包上限 2 MB，单个分包也是 2 MB。
three 加上 loader 轻松超过 1 MB，放主包会直接爆。所以首页留在主包，3D 页面整体挪到 `pkg-water` 分包，
`project.config.json` 里把 npm 构建产物也指定到 `./pkg-water/`。

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
