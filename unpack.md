# 解包脚本使用说明

`extract.py` 把碧蓝航线的单个 Live2D 皮肤 bundle（UnityFS）解包并重组为
**标准 Cubism 4 模型**，可直接被 pixi-live2d-display 等运行时加载。
游戏资源格式与交互状态机原理见 [azurlane.md](azurlane.md)。
提取产物仅限本地学习交流，不得再分发，版权与免责见 [README](README.md) 的"版权说明"。

## 用法

```bash
uv run scripts/extract.py <skin_id>                 # 如 fulici_2（推荐）
python scripts/extract.py <skin_id>                 # 或直接用 Python 启动
uv run scripts/extract.py <bundle_path> <out_dir>   # 兼容：显式指定输入与输出
```

- 依赖见 `requirements.txt`（UnityPy），`uv pip install -r requirements.txt` 或
  pip 安装均可；bundle 的拉取方式见 [azurlane.md](azurlane.md) 第 1 节
  （落到 `.tmp/bundles/`）
- `<skin_id>` 为皮肤 id（`_hx` 后缀为改造/婚变体）。不传输出目录时自动落
  `models/<角色>/<skin_id>/`（角色名 = skin_id 去掉 `_hx`/`_N` 后缀），
  不存在会自动创建；显式传 `<bundle_path> <out_dir>` 时按传入路径落盘
- 产物命名一律取 bundle 文件名（去扩展名）为模型 id，与目录名无关

## 产物

```
<out_dir>/
├── <id>.model3.json      # 模型入口，引用下列全部资源
├── <id>.moc3             # 模型二进制（CubismMoc._bytes，原样取出）
├── <id>.physics3.json    # 物理（TextAsset JSON 原文，无损）
├── <id>.char.json        # Live2dChar 交互参数（本项目扩展，见下）
├── <id>.interaction.json # 交互状态机数据（本项目扩展，见下）
├── <id>.l2d.json         # ship_l2d 交互配置（bake_l2d.py 烘焙，本项目扩展，见下）
├── <id>.defaults.json    # 参数默认值/min/max（解析自 moc3，见下）
├── <id>.inventory.json   # bundle 全量参考：GameObject 表、全部组件 typetree、
│                         #   AnimationClip 事件与绑定；逆向时先 grep 这里
├── textures/texture_XX.png
└── motions/<clip名>.motion3.json
```

一次提取即完整模型资源：成品与参考数据同时落盘，逆向缺数据时不需要回头对
bundle 现写探针。产物全部落在模型目录内，目录间互不引用，新增、删除、分享
都是整目录操作。

`model3.json` 内含：

- **Motions**：按动作组组织（`idle` `login` `touch_idle` `touch_drag` 及其余
  原名组）；`idle` `login` 组标记 `Loop: true`
- **HitAreas**：来自 `CubismRaycastable` 分区（`TouchHead`/`TouchBody`/
  `TouchIdle1-9`/`TouchDrag1-7` 等），与同名动作组对应

## 项目扩展文件

两个扩展文件不属于 Cubism 4 标准产物，标准运行时会忽略，供本查看器的交互
还原使用：

- **`<id>.char.json`**：`Live2dChar` MonoBehaviour 的交互参数（拖拽速率、
  阻尼、点击响应开关），语义与用法见 [azurlane.md](azurlane.md)
- **`<id>.interaction.json`**：游戏交互状态机的数据还原（状态机机制见
  [azurlane.md](azurlane.md) 第 3 节，运行时消费方式见 [README](README.md)
  的"查看器实现"）：
  - `clips` 下每支含数据的动作记录：
    - `events`：`AnimationEvent` 列表（`OnAnimEvent` 语音钩子、
      `OnFinishAnim(N)` 结束状态编号）
    - `state`：开关型参数（取值贴着 0/1/-1 的图层/道具开关）的
      `[起播值, 结束值]`。开关型判定有两条：全部采样值贴 0/±1（严格），或
      首末值贴 0/±1 且全程不越出 moc 量程、量程宽度 ≤1.25（带弹性过冲的
      开关，如 uicaidan 量程 [0,1.1]——这类曲线若漏收，运行时复位会把摊开的
      菜单 UI 抹掉）
  - `animator` 节：AnimatorController 路由表，解析 `m_Controller` 序列化
    blob 所得——`paramKinds`：条件参数名哈希 → `"int"` / `"trigger"`（主
    int 即动作编号 ActionId，次 int 为 idle 变体号）；`states`：全部状态按
    ActionId 排序，每项 `{name, actionId, subIndex, clip}`，`clip` 为空的
    状态是空跳板。ActionId 取值域与门控机制见 [azurlane.md](azurlane.md)
- **`<id>.l2d.json`**：游戏 Lua 配置 `pg.ship_l2d` 的交互配置（不是 bundle
  产物，由 `bake_l2d.py` 从 `.tmp/lua/` 快照烘焙进模型目录，来历见
  [azurlane.md](azurlane.md) 第 3 节；`parse_ship_l2d.py` 可人工查验）：
  `skin_id`（数字皮肤 id）、`entries`（该皮肤的 ship_l2d 条目，按游戏注册
  顺序，字段原样保留）、`idle_index`（idle 变体号 → 动作 clip 名映射，取自
  interaction.json 的 `animator.states`）。运行时消费方式见
  `src/utils/dragmachine.js` 头注与 [README](README.md) 的"查看器实现"

## 转换原理

| 资源       | 来源                                  | 处理                                                                                                            |
| ---------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| moc3       | `CubismMoc` MonoBehaviour 的 `_bytes` | 直接是 moc3 二进制，校验 `MOC3` 魔数后原样写出                                                                  |
| 贴图       | ASTC 格式 Texture2D                   | UnityPy `.image` 转码为 PNG                                                                                     |
| 物理       | TextAsset `*.physics3`                | JSON 原文直接落盘                                                                                               |
| 交互参数   | `Live2dChar` MonoBehaviour            | 过滤 `m_` 前缀字段后存 `char.json`                                                                              |
| 动作路由   | `AnimatorController` 序列化 blob      | 解析参数与 AnyState 转移 → `interaction.json` 的 `animator` 节（见上）                                          |
| 动画       | Unity AnimationClip（muscle-clip）    | 曲线解码后转 motion3.json，见下                                                                                 |
| 参数默认值 | moc3 二进制                           | 解析头部节偏移表，见下                                                                                          |
| 全量参考   | bundle 全部对象                       | GameObject 表 + 组件 typetree + clip 事件/绑定 → `inventory.json`（`CubismMoc._bytes` 除外，避免与 .moc3 重复） |

### moc3 参数默认值（defaults.json）

Cubism 4（moc3 版本字节=4）头部 0x40 起是**节偏移表**（递增 u32，直到不再
递增）。其中表[51]=参数 max、表[52]=min、表[53]=defaults，各为 n_f32 数组，
按 `CubismParameter._unmanagedIndex` 对位——**与 moc3 字符串槽区顺序无关**。
校验：min≤default≤max 对全部参数成立，不成立即版本/对位有问题，脚本告警跳过
（该节表布局按 v4 实测得出，其他 moc3 版本未验证）。

参数 id ← `_unmanagedIndex` 映射：`CubismParameter` 组件无 id 字段，其所在
GameObject 名即参数 id（`ParamAngleX` 等），与动画曲线绑定还原用的名字一致。

### AnimationClip → motion3.json

游戏动画是 muscle-clip（无 `m_FloatCurves`），曲线分三种存储，脚本逐条读取：

- **streamed**：逐帧关键帧，`coeff[2]` 为 outSlope、`coeff[3]` 为 value，
  inSlope 由下一关键帧反推（Unity 原生算法）；帧头 `t < -1e30` 是 Unity
  起始标记帧，非真实关键帧，丢弃
- **constant**：常值曲线，经 `m_IndexArray` 映射到 ConstantClip 数据
- **dense**：稠密采样，按 `m_SampleRate` 还原时间轴

关键帧对（value, outSlope, inSlope）换算为 motion3 的贝塞尔段：控制点取
`t ± dt/3`、`v ± slope·dt/3`；inSlope 为无穷大时输出 stepped 段。

### 曲线绑定还原

AnimationClip 中绑定 path/attribute 是 **CRC32 哈希**。脚本枚举 bundle 内
Transform 层级，对每条 GameObject 路径（相对 Animator 根，不含根名；另含全路径
与对象名两种变体）计算 CRC32 建立哈希→名称映射，从而把曲线绑定还原为参数 id
（如 `root/Parameters/ParamAngleX` → `ParamAngleX`）。attribute 同为 CRC32
哈希，实测两种：`Value`（参数曲线，Target `Parameter`）与 `Opacity`（部件
不透明度，Target `PartOpacity`）。
路径哈希未命中或 attribute 未知时跳过该曲线并打印告警，原始绑定始终
保留在 inventory.json。

## 已知限制与注意

- 交互配置（分区→动作/拖拽参数机）不在 bundle 内，来自游戏 Lua 配置快照
  `.tmp/lua/`，解析用 `python -I scripts/parse_ship_l2d.py <皮肤id>`（或
  `uv run python -I …`），烘焙进模型目录用 `python -I scripts/bake_l2d.py
  <painting名>`；来历与文件清单见 [azurlane.md](azurlane.md) 第 3 节
- 解码部分从 UnityPy 1.9.28 的 `AnimationClip.py` 摘取（MIT），其余版本未验证
- 个别曲线的路径哈希在 Transform 层级中找不到对应（bundle 内本就无法解析的
  数据），另有若干无采样数据的空 Opacity 绑定；提取时打印 `[warn]` 并跳过，
  不影响其余曲线
- 口型（CRI 语音驱动）与 CV 音频不在本脚本提取范围内
