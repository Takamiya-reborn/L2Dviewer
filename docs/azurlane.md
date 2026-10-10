# 碧蓝航线 Live2D 资源与客户端结构

本文只说明游戏客户端中的资源组织、厂商使用的运行时技术和各类文件的职责。
具体如何提取、解析并重组为查看器可用模型，见 [unpack.md](unpack.md)。提取产物
仅限本地学习交流，不得再分发；版权与免责见 [README](../README.md) 的“版权说明”。

## 1. 手机端目录

游戏安装后，资源位于应用数据目录的 `files/` 下。不同客户端版本和服务器可能
略有差异，但 Live2D 相关资源通常按以下方式组织：

```text
files/
├── AssetBundles/live2d/       # 每套皮肤一个 UnityFS bundle，通常以皮肤 id 命名
├── hashes-live2d.csv          # Live2D bundle 的索引与哈希
├── version-live2d.txt         # Live2D 资源版本信息
└── ...                         # 语音、立绘等其他资源类别的同构目录
```

皮肤 id 通常是 `<舰娘拼音>_<皮肤序号>`，改造或婚纱变体可能带 `_hx` 后缀。
bundle 的索引文件只负责定位和校验资源，模型本体位于
`AssetBundles/live2d/`。

## 2. 厂商的开发技术

### 2.1 Unity 与 Cubism

游戏使用 Unity，Live2D 模型使用 Cubism SDK for Unity。客户端没有直接存放
标准 Web 端的 `.model3.json`，而是把 Cubism 运行时对象序列化在 Unity prefab
和 UnityFS bundle 中：

- `CubismMoc` 保存 moc3 二进制；
- `CubismParameter`、`CubismPart`、`CubismDrawable` 保存参数、部件和网格；
- `CubismPhysicsController` 与 `physics3` 文本资源保存物理；
- `CubismRaycastable` 标记可点击或可拖拽的命中区域；
- Texture2D 通常使用 ASTC 压缩；
- 动画使用 Unity `AnimationClip`，而不是 motion3 文件。

`Live2dChar` 是游戏自己的 MonoBehaviour，保存拖拽视线速率、阻尼时间和点击
反应开关等模型级配置。参数组件本身通常没有独立 id，GameObject 名称承担参数
标识作用，例如 `ParamAngleX`。

### 2.2 动画与模型文件

AnimationClip 使用 Unity 的 muscle-clip 数据，曲线可能存放在 streamed、dense
或 constant 段中。动作覆盖待机、登录、主界面、触摸、拖拽、任务和氛围效果等
组；`effect` 通常是叠加在其他动作之上的常驻循环效果。

模型的动作并非只由文件名决定。AnimatorController 通过整数参数、触发器和
AnyState 转移选择动作状态，idle 还拥有独立的变体编号。动画事件负责动作开头
和结束时的通知，控制层据此切换动作或回到待机。

### 2.3 交互配置与控制层

皮肤 bundle 只包含模型和 Animator 数据，分区到动作、拖拽参数机和 idle 变体的
配置还在游戏 Lua 中。主要来源包括：

| 文件或目录                            | 职责                                     |
| ------------------------------------- | ---------------------------------------- |
| `sharecfg/ship_l2d.lua`               | 皮肤的命中分区、参数机、触发器和联动配置 |
| `sharecfgdata/ship_skin_template.lua` | painting 名与数字皮肤 id 的映射          |
| `view/ship/live2d.lua`                | 动作播放、待机切换和点击控制             |
| `view/ship/live2ddrag.lua`            | 拖拽参数机、触发器和机器间联动           |
| `view/ship/live2dextend.lua`          | 参数叠加、平滑和扩展规则                 |
| `mgr/live2dmgr.lua`                   | Live2D 控制层的管理与装配                |

运行时会把 `TouchHead`、`TouchBody`、`TouchIdleN`、`TouchDragN` 等 GameObject
名称作为交互分区。重叠分区由游戏的命中路由决定，分区配置再决定实际由哪台
参数机响应；同一分区可以挂多台机器并协同工作。

## 3. 逆向参考文件

Lua 文件来自社区维护的
[AzurLaneLuaScripts](https://github.com/AzurLaneTools/AzurLaneLuaScripts)，
不是游戏 bundle 的一部分。C# 侧的控制器语义可由 APK 中的
`libil2cpp.so`、`global-metadata.dat` 和 Il2CppDumper 输出辅助确认；这些文件
用于理解运行时，不是模型成品的一部分。

本项目通过 `scripts/pull_lua.py` 将 Lua 快照放入 `.tmp/lua/<服务器>/`，通过
`scripts/pull_cs.py` 与 `scripts/disasm.py` 获取和核对 C# 语义。上述工具只用于
研究和验证，查看器的实际转换流程见 [unpack.md](unpack.md)。
