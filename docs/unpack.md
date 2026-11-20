# Live2D 提取、解析与还原

本文说明资源从手机端进入本项目后，如何被提取、解析、转换，并最终还原为浏览器可加载的 Cubism 模型和交互。游戏皮肤存在 Cubism 4 与 Cubism 5 两代 SDK，moc3 版本字节分别为 4 和 5，提取流程对两者通用。游戏端目录、厂商技术与文件职责见 [azurlane.md](azurlane.md)。

## 1. 获取输入文件

### 1.1 拉取 bundle

使用 adb 连接模拟器或设备并拉取指定皮肤：

```bash
node scripts/pull_bundles.js <skin_id> --host [host:port]
```

脚本从设备的 `files/AssetBundles/live2d/` 获取 bundle，索引和临时文件放在 `.tmp/`，bundle 默认落在 `.tmp/bundles/`。也可以手动提供 bundle 路径给提取脚本。ani 动态皮肤在 `files/AssetBundles/spinepainting/` 类别下，按名拉取会连带 `<painting>_res` 骨架资源对（解析 spine 目录与远端大小依赖全类别总索引 `hashes.csv`，同步索引在拉取之前执行；首次拉 ani 皮肤前需先跑过一次 `--index`）。

### 1.2 获取 Lua 配置

需要还原拖拽参数机和游戏交互配置时，拉取 Lua 快照：

```bash
node scripts/pull_lua.js                   # 默认 CN
node scripts/pull_lua.js --server JP
```

快照固定放在 `.tmp/lua/<服务器>/`。没有 Lua 快照时仍能提取模型和基础点击/视线拖拽，但不会生成完整的 `l2d.json`，查看器会旁路参数机层。

### 1.3 可选的 C# 语义参考

需要核对命中路由或控制层语义时，使用 `pull_cs.js` 拉 APK 并用 Il2CppDumper 生成 dump，再用 `disasm.js` 对指定方法做定点反汇编。它们用于解释行为，不参与标准模型文件的生成。

### 1.4 皮肤目录一键更新

游戏版本更新后的日常维护只需一条命令：

```bash
npm run update
```

它依次执行 `pull_lua.js --force`（重拉 Lua 快照）、`pull_bundles.js --index`（从设备刷新 live2d 索引）、`gen_catalog.js`（重排 `public/catalog.json`），任一步失败即中止，最后对比新旧目录打印版本号变化与新增/移除的皮肤。目录同时是查看器目录页的拉取白名单，新皮肤只有进了目录才能在页面上点击拉取。

注意：

- 索引反映的是设备 `files/AssetBundles/live2d/` 的实际内容：游戏内未触发下载的皮肤不会出现在索引里，属正常，不是脚本漏了。ani 动态皮肤不在 live2d 索引内，走 `spinepainting/` 类别经 `hashes.csv` 索引拉取与提取（见 3.4 节），目录中落 `ani` 形态标记；
- GitHub 直连不通时用 `npm run update -- --proxy http://127.0.0.1:端口` 或设置 `HTTPS_PROXY` 环境变量；缺省时会自动探测本机常见代理端口（7890/7892/7897）。

## 2. 解包 bundle

```bash
node scripts/extract.js <skin_id>
node scripts/extract.js <bundle_path> <out_dir>
```

第一种形式从 `.tmp/bundles/` 查找 bundle，并将结果写入 `models/<角色>/<skin_id>/`；第二种形式显式指定输入和输出目录。`extract.js` 使用 unityfs-js 读取 UnityFS 和 prefab 的 typetree，按对象类型收集 Cubism 模型、物理、贴图、Animator、AnimationClip 与游戏自定义组件。主 bundle 的 MonoScript 表含 `SkeletonGraphic` 时判定为 ani（spine）皮肤，走独立的解析与烘焙分支（3.4 节），不进入 Cubism 管线。

## 3. 解析与转换

### 3.1 模型和物理

- 从 `CubismMoc._bytes` 取出 moc3，校验 `MOC3` 魔数后原样写出，两代版本（v4/v5）不做转换；
- 读取 Cubism 参数、部件、drawable、纹理和命中区域，建立 model3 的参数和 HitAreas 引用；
- 将 ASTC Texture2D 解码为 PNG；
- 将 physics3 TextAsset 的 JSON 原文写出；
- 从 `Live2dChar` 过滤游戏内部字段，生成查看器使用的 `char.json`；
- 从 moc3 的参数表读取 min、max、default，生成 `defaults.json`。

### 3.2 动画曲线

Unity AnimationClip 的绑定使用 CRC32 哈希，脚本会枚举 Transform 路径，建立哈希到参数或部件名称的映射。曲线按存储类型解析：

- streamed：读取关键帧、值和斜率；
- dense：按采样率还原时间轴；
- constant：按本游戏 Unity 序列化的绑定顺序与 constant 数据对位。

解析后的曲线转换为 motion3 的贝塞尔或阶跃段；参数曲线写入 `Target=Parameter`，部件不透明度曲线写入 `Target=PartOpacity`。无法解析的原始绑定仍保存在 `inventory.json`，便于后续核对。

### 3.3 Animator 与交互数据

脚本解析 AnimatorController 的参数、AnyState 转移、状态和 AnimationEvent，形成 `interaction.json`：

- `events` 保存动作开始/结束事件；
- `state` 保存开关型参数的起播值和结束值，用于还原动作之间的状态延续；
- `animator` 保存 ActionId、idle 变体和状态到 clip 的路由。

随后脚本读取 `.tmp/lua/` 中与皮肤匹配的 `ship_l2d` 条目，将分区、参数、拖拽范围、触发器、联动和 idle 映射原样整理到 `l2d.json`。这样 bundle 内的模型数据与 bundle 外的游戏控制配置就能在同一个模型目录中配套使用。

AnyState 转移自带过渡时长（`m_TransitionDuration`，`m_HasFixedDuration=True` 时为绝对秒），这是游戏内各动作过渡快慢不一的出处。提取脚本按 clip 名把它整理为 `fades.json`（实测分布：系统/触摸老条目 0.5s，新条目与 `_ex` 变体 0.25s，`login`/`home`/`change_in`/`change_out` 0s 硬切），播放端逐动作设置交叉渐变时长。

### 3.4 Ani（spine）皮肤

ani 动态皮肤使用 spine 骨架动画而非 Cubism。资源成对出现：主 bundle `spinepainting/<painting>` 只含 SkeletonGraphic UI 预制体，骨架数据在伴生 `<painting>_res` bundle 中（SkeletonDataAsset、SpineAtlasAsset、.skel 二进制、.atlas 文本与 ASTC 贴图）。

- `.skel` 是 spine 3.8 系二进制，语法以游戏 spine-unity 程序集的 SkeletonBinary.ReadSkeletonData 为准（nonessential 时头尾各多一个调试占位 int，是与官方 3.8 语法的分歧点）；`spineSkel.js` 的 `parseSkel()` 解析、`toSpine38Json()` 转换为 pixi-spine 3.8 读取器方言的 JSON（skins 数组形态、时间轴按名键控、加权顶点平铺单数组等）。美术迭代遗留的旧附件名悬挂引用按同槽位附件名集合做最长公共前缀修补，修补后仍落空的 deform 条目丢弃；
- `spineBake.js` 的 `bakeSpine()` 消费主 bundle 与 `_res` 两个 bundle：变体表取 res 内全部 SkeletonDataAsset；分层预制体（根 GameObject 子层级按序挂多个 SkeletonGraphic，共享坐标系）落 `parts` 有序分区表，单骨架走默认变体；
- 贴图统一翻转口径为标准 top-down PNG（`decodeAstcTexture()` flip 默认 true），pixi-spine 无 spine-unity 的内部 UV 转换；
- .skel/.atlas 的 TextAsset 必须经 `info.object.data` 取原始字节——typetree 的 m_Script 经 UTF-8 解码已毁二进制段。

ani 皮肤产物与 L2D 皮肤同目录约定（见第 4 节）。

## 4. 产物与用途

```text
<out_dir>/
├── <id>.model3.json       # 浏览器运行时入口
├── <id>.moc3              # Cubism 模型二进制
├── <id>.physics3.json     # 物理配置
├── <id>.char.json         # Live2dChar 基础交互参数
├── <id>.interaction.json  # Animator 路由、事件和参数状态
├── <id>.l2d.json          # ship_l2d 参数机与联动配置
├── <id>.fades.json        # Animator 转场时长表（逐 clip 交叉渐变秒数）
├── <id>.defaults.json     # 参数默认值、最小值和最大值
├── <id>.inventory.json    # bundle 全量解析参考
├── textures/              # PNG 纹理
└── motions/               # motion3 动作曲线
```

ani（spine）皮肤的产物布局：

```text
<out_dir>/
├── <id>.spine.json        # 元数据：painting、名称、默认变体、变体表（骨架/图集/贴图、
│                          #   startingAnimation/startingLoop/initialSkin）、分层预制体 parts
├── <变体>.json            # spine 3.8 JSON（pixi-spine 方言）
├── <变体>.skel            # 原始 .skel 字节归档
├── <变体>.atlas           # 图集描述文本
└── <atlas 页名>.png       # 贴图（top-down 行序）
```

这些文件的关系不是简单的格式转换：

1. `model3.json`、`moc3`、纹理、物理和 `motions/` 组成可渲染的标准 Cubism 模型；
2. `char.json` 提供视线拖拽等基础参数；
3. `interaction.json` 让运行时按 Animator 状态和动作事件处理点击、待机与状态延续；
4. `l2d.json` 让拖拽参数机、触发器、联动和 idle 变体配置在 Web 端可执行；
5. `defaults.json` 用于从 moc 默认值恢复未被状态机覆盖的参数；
6. `inventory.json` 保留无法直接映射到标准 Cubism 文件的原始对象和绑定，作为逆向排查资料。

## 5. 在查看器中的还原

浏览器加载模型目录后，`src/l2d/` 装配舞台、镜头、动作和手势，`src/utils/interaction/` 消费 `interaction.json`，`src/utils/dragmachine/` 消费 `l2d.json`，`src/utils/ambient.js` 叠加 `effect` 氛围曲线。还原过程的核心对应关系如下：

| 游戏数据                       | 查看器还原                               |
| ------------------------------ | ---------------------------------------- |
| Animator 状态和 AnimationEvent | 动作播放、状态门控、结束回落和 idle 变体 |
| AnyState 转场时长              | 逐动作交叉渐变时长（fades.json）         |
| CubismRaycastable / HitArea    | 点击与拖拽命中分区                       |
| Live2dChar                     | 视线跟随和阻尼拖拽                       |
| `ship_l2d` 参数机              | 参数拖拽、档位吸附、回弹和触发器         |
| `listener_data`                | 机器间参数联动与 idle 换挡               |
| `effect` AnimationClip         | 常驻氛围参数叠加                         |
| SkeletonDataAsset / .skel / .atlas | ani 皮肤骨架动画（pixi-spine 3.8 加载；initialSkin 语义回落 skins[1]，变体切换重挂） |

因此，提取脚本的目标不是只生成一套静态模型，而是把渲染资源、动画路由、参数默认值和游戏控制层拆成可检查的文件，再由查看器重新组合成可交互模型。

## 6. 已知限制

- 未取得 Lua 快照时，`l2d.json` 不完整，参数机层会被跳过；
- 个别 CRC32 绑定可能无法映射到 Transform，脚本会告警并保留原始绑定；
- 口型和 CRI 语音驱动不在提取范围内；
- muscle-clip 的解码依据 Unity 序列化规范实现（流式斜率递推与 UnityPy 1.9.28 逐位一致）；
- ani（spine）皮肤暂无交互层（主 bundle 内的命中区未烘焙），查看器中纯观看 + 变体切换；
- 模型目录属于从游戏客户端提取的资源，不应提交或再分发。
