# Live2D 提取、解析与还原

本文说明资源从手机端进入本项目后，如何被提取、解析、转换，并最终还原为浏览器
可加载的 Cubism 4 模型和交互。游戏端目录、厂商技术与文件职责见
[azurlane.md](azurlane.md)。

## 1. 获取输入文件

### 1.1 拉取 bundle

使用 adb 连接模拟器或设备并拉取指定皮肤：

```bash
uv run scripts/pull_bundles.py <skin_id> --host [host:port]
```

脚本从设备的 `files/AssetBundles/live2d/` 获取 bundle，索引和临时文件放在
`.tmp/`，bundle 默认落在 `.tmp/bundles/`。也可以手动提供 bundle 路径给提取脚本。

### 1.2 获取 Lua 配置

需要还原拖拽参数机和游戏交互配置时，拉取 Lua 快照：

```bash
python scripts/pull_lua.py                  # 默认 CN
python scripts/pull_lua.py --server JP
```

快照固定放在 `.tmp/lua/<服务器>/`。没有 Lua 快照时仍能提取模型和基础点击/视线
拖拽，但不会生成完整的 `l2d.json`，查看器会旁路参数机层。

### 1.3 可选的 C# 语义参考

需要核对命中路由或控制层语义时，使用 `pull_cs.py` 拉 APK 并用 Il2CppDumper
生成 dump，再用 `disasm.py` 对指定方法做定点反汇编。它们用于解释行为，不参与
标准模型文件的生成。

## 2. 解包 bundle

```bash
uv run scripts/extract.py <skin_id>
python scripts/extract.py <bundle_path> <out_dir>
```

第一种形式从 `.tmp/bundles/` 查找 bundle，并将结果写入
`models/<角色>/<skin_id>/`；第二种形式显式指定输入和输出目录。`extract.py`
使用 UnityPy 读取 UnityFS 和 prefab 的 typetree，按对象类型收集 Cubism 模型、
物理、贴图、Animator、AnimationClip 与游戏自定义组件。

## 3. 解析与转换

### 3.1 模型和物理

- 从 `CubismMoc._bytes` 取出 moc3，校验 `MOC3` 魔数后原样写出；
- 读取 Cubism 参数、部件、drawable、纹理和命中区域，建立 model3 的参数和
  HitAreas 引用；
- 将 ASTC Texture2D 解码为 PNG；
- 将 physics3 TextAsset 的 JSON 原文写出；
- 从 `Live2dChar` 过滤游戏内部字段，生成查看器使用的 `char.json`；
- 从 moc3 的参数表读取 min、max、default，生成 `defaults.json`。

### 3.2 动画曲线

Unity AnimationClip 的绑定使用 CRC32 哈希，脚本会枚举 Transform 路径，建立哈希
到参数或部件名称的映射。曲线按存储类型解析：

- streamed：读取关键帧、值和斜率；
- dense：按采样率还原时间轴；
- constant：按本游戏 Unity 序列化的绑定顺序与 constant 数据对位。

解析后的曲线转换为 motion3 的贝塞尔或阶跃段；参数曲线写入 `Target=Parameter`，
部件不透明度曲线写入 `Target=PartOpacity`。无法解析的原始绑定仍保存在
`inventory.json`，便于后续核对。

### 3.3 Animator 与交互数据

脚本解析 AnimatorController 的参数、AnyState 转移、状态和 AnimationEvent，形成
`interaction.json`：

- `events` 保存动作开始/结束事件；
- `state` 保存开关型参数的起播值和结束值，用于还原动作之间的状态延续；
- `animator` 保存 ActionId、idle 变体和状态到 clip 的路由。

随后脚本读取 `.tmp/lua/` 中与皮肤匹配的 `ship_l2d` 条目，将分区、参数、拖拽
范围、触发器、联动和 idle 映射原样整理到 `l2d.json`。这样 bundle 内的模型数据
与 bundle 外的游戏控制配置就能在同一个模型目录中配套使用。

## 4. 产物与用途

```text
<out_dir>/
├── <id>.model3.json       # 浏览器运行时入口
├── <id>.moc3              # Cubism 模型二进制
├── <id>.physics3.json     # 物理配置
├── <id>.char.json         # Live2dChar 基础交互参数
├── <id>.interaction.json  # Animator 路由、事件和参数状态
├── <id>.l2d.json          # ship_l2d 参数机与联动配置
├── <id>.defaults.json     # 参数默认值、最小值和最大值
├── <id>.inventory.json    # bundle 全量解析参考
├── textures/              # PNG 纹理
└── motions/               # motion3 动作曲线
```

这些文件的关系不是简单的格式转换：

1. `model3.json`、`moc3`、纹理、物理和 `motions/` 组成可渲染的标准 Cubism 模型；
2. `char.json` 提供视线拖拽等基础参数；
3. `interaction.json` 让运行时按 Animator 状态和动作事件处理点击、待机与状态
   延续；
4. `l2d.json` 让拖拽参数机、触发器、联动和 idle 变体配置在 Web 端可执行；
5. `defaults.json` 用于从 moc 默认值恢复未被状态机覆盖的参数；
6. `inventory.json` 保留无法直接映射到标准 Cubism 文件的原始对象和绑定，作为
   逆向排查资料。

## 5. 在查看器中的还原

浏览器加载模型目录后，`src/l2d/` 装配舞台、镜头、动作和手势，
`src/utils/interaction/` 消费 `interaction.json`，`src/utils/dragmachine/`
消费 `l2d.json`，`src/utils/ambient.js` 叠加 `effect` 氛围曲线。还原过程的核心
对应关系如下：

| 游戏数据                       | 查看器还原                               |
| ------------------------------ | ---------------------------------------- |
| Animator 状态和 AnimationEvent | 动作播放、状态门控、结束回落和 idle 变体 |
| CubismRaycastable / HitArea    | 点击与拖拽命中分区                       |
| Live2dChar                     | 视线跟随和阻尼拖拽                       |
| `ship_l2d` 参数机              | 参数拖拽、档位吸附、回弹和触发器         |
| `listener_data`                | 机器间参数联动与 idle 换挡               |
| `effect` AnimationClip         | 常驻氛围参数叠加                         |

因此，提取脚本的目标不是只生成一套静态模型，而是把渲染资源、动画路由、参数
默认值和游戏控制层拆成可检查的文件，再由查看器重新组合成可交互模型。

## 6. 已知限制

- 未取得 Lua 快照时，`l2d.json` 不完整，参数机层会被跳过；
- 个别 CRC32 绑定可能无法映射到 Transform，脚本会告警并保留原始绑定；
- 口型和 CRI 语音驱动不在提取范围内；
- muscle-clip 的解码依据 UnityPy 1.9.28 的实现，其他版本尚未完整验证；
- 模型目录属于从游戏客户端提取的资源，不应提交或再分发。
