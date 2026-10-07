# 碧蓝航线 Live2D 资源采集与加工流程

> 目标：从碧蓝航线客户端中提取 Live2D 皮肤资源，重组为标准 Cubism 4 模型，
> 在 Web 端还原原版交互与动画，质量无损。设备地址、游戏包名等环境信息以实际为准。
> 各脚本的命令行用法见脚本头部说明；`extract.py` 的产物与转换细节见
> [unpack.md](unpack.md)。提取产物仅限本地学习交流，不得再分发，
> 版权与免责见 [README](README.md) 的"版权说明"。

## 1. 资源采集

1. 用 `tools/adb.exe connect <模拟器地址>` 连接设备，通过 `pm list packages`
   确定游戏包名。
2. 资源位于游戏数据目录 `files/` 下：
   - `AssetBundles/live2d/` — **L2D 皮肤本体**，每套皮肤一个 UnityFS bundle
     （以皮肤 id 命名）
   - `hashes-live2d.csv` / `version-live2d.txt` — L2D 资源索引与版本清单；
     语音、立绘等其他资源类别有同构清单
   - 皮肤 id 规则：`<舰娘拼音>_<皮肤序号>`，`_hx` 后缀为改造/婚皮肤变体
3. 拉取 bundle 用 `scripts/pull_bundles.py`（落到 `.tmp/bundles/`，索引缓存落
   `.tmp/`，已 gitignore）。手动 `adb pull` 时注意：Git Bash 下远端路径开头用
   `//` 防止路径转换。

## 2. bundle 内部结构

游戏未内嵌标准 `.model3.json`/`.moc3`，而是把 **Cubism 4（Cubism SDK for Unity）
运行时组件序列化进 prefab**（UnityFS bundle，LZ4HC 压缩）：

- `CubismMoc`：`_bytes` 字段即完整 moc3 二进制（魔数 `MOC3`）
- `CubismParameter` / `CubismPart` / `CubismDrawable`：模型参数、部件、网格；
  参数组件无 id 字段，所在 GameObject 名即参数 id（`ParamAngleX` 等）
- `CubismPhysicsController` + TextAsset `*.physics3`：物理，JSON 原文可直接使用
- `Live2dChar` MonoBehaviour：游戏自定义交互参数——`DragRateX/Y`（拖拽视线速率）、
  `DampingTime`（阻尼）、`ResponseClick`（点击反应开关）
- `CubismRaycastable` 所在 GameObject 名即点击分区语义（`TouchHead`/`TouchBody`/
  `TouchSpecial`/`TouchIdle1-9`/`TouchDrag1-7`）
- 贴图：**ASTC** 格式 Texture2D，需转码为 PNG
- 动画：**Unity AnimationClip**（muscle-clip），覆盖原版全部动作组：
  `idle` `login` `main_*` `touch_head` `touch_body` `touch_special`
  `touch_idle*` `touch_drag*` `mail` `mission` `mission_complete` `complete`
  `wedding` `effect` 等。其中 `effect` 是常驻循环的氛围摆动（布料、发丝等），
  叠加在所有动作之上，不是鉴赏界面里的触发项
- 口型：`CubismCriSrcMouthInput`（CRI 音频驱动 CV 语音），不在提取范围内

## 3. 交互状态机

游戏没有显式的状态机数据结构，交互逻辑分散在三类载体中：

- **AnimationEvent 钩子**：每支动作内嵌事件——`OnAnimEvent(0)` 在动作开头触发
  （语音/配音钩子）；`OnFinishAnim(N)` 在动作结尾上报动作状态编号，N 与动作
  一一对应，是游戏内状态机的状态标识
- **跨动作参数状态**：游戏不在动作间复位参数，图层/道具开关型参数（取值贴
  0/±1，如菜单开合、菜单可点区）的值跨动作持续。"菜单摊开"就是 touch_idle
  系列动作播完后开关值残留在运行时里
- **点击门控 = 起播边界一致性**：每支动作的开关型参数起播值即其可达前置状态。
  同一分区的多支分支动作以不同起播值区分（如"菜单摊开时才可触发"的分支以
  开关=1 起播，"菜单收起时才可触发"的分支以开关=0 起播）。当前参数状态与
  某动作的起播边界不符时，该动作不可被点击触发

参数默认值不在 bundle 内（在 moc3 二进制中），运行时以"非默认即状态残留"判断
当前状态。

以上数据由 `extract.py` 提取为 `<id>.interaction.json`，字段语义见
[unpack.md](unpack.md)。

## 4. 提取管线

`scripts/extract.py` 读入单个皮肤 bundle，一次完成五步：解包（UnityPy 提取
moc3/贴图/物理/动画与上述组件数据）→ ASTC 贴图转码 PNG → AnimationClip 曲线
换算 motion3.json → 重组标准 `model3.json` 并按 `public/models/<角色>/<皮肤id>/`
落盘 → 同时输出 inventory/defaults 等全量参考数据。产物清单见
[unpack.md](unpack.md)。

## 5. Web 端还原

- **皮肤清单**：`vite.config.js` 的 modelsManifest 插件启动/构建时扫描
  `public/models/<角色>/<皮肤id>/<皮肤id>.model3.json` 自动生成（虚拟模块
  `virtual:models`），新增皮肤重启 dev 即生效，无需手工登记
- **加载**：pixi-live2d-display（PixiJS 插件，Cubism 4）加载 model3.json
  （idle 组命名注意项见 [unpack.md](unpack.md) 已知限制）
- **点击**：tap 命中 HitArea → 经交互运行时（`src/utils/interaction.js`）
  按 interaction.json 做状态门控后播放对应动作组
- **拖拽**：指针拖拽按 `Live2dChar` 的 DragRateX/Y 与 DampingTime 做阻尼视线跟随
- **待机**：`idle` 组随机循环
- **氛围层**：`effect` 组作为常驻层，按 motion3.json 曲线逐帧采样后直写参数，
  叠加在任意动作之上（`src/utils/ambient.js`）

## 6. 环境与工具约定

- Python：依赖见 `requirements.txt`（UnityPy）；提取脚本在 `scripts/`，
  `tools/` 只放 adb 等 OS 工具
- Node：mise 管理（`mise.toml`）
