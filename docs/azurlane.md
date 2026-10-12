# 碧蓝航线 Live2D 运行时结构与交互逻辑

本文描述碧蓝航线客户端中 Live2D 皮肤的资源组织、Unity/Cubism 对象、Animator 动作系统、Lua 交互参数机，以及从一次命中到参数更新和动作结束的完整运行链。资源提取和文件重组流程见 [unpack.md](unpack.md)。提取产物仅限本地学习交流，不得再分发；版权与免责见 [README](../README.md) 的“版权说明”。

## 目录

- [1. 资源目录与皮肤标识](#1-资源目录与皮肤标识)
- [2. Unity 与 Cubism 对象](#2-unity-与-cubism-对象)
- [3. 动画资源与 Animator](#3-动画资源与-animator)
- [4. 控制层和配置文件](#4-控制层和配置文件)
- [5. 运行时对象关系](#5-运行时对象关系)
- [6. 从指针命中到动作播放](#6-从指针命中到动作播放)
- [7. DragMachine 参数机](#7-dragmachine-参数机)
- [8. 触发类型](#8-触发类型)
- [9. activeData、idle 变体和动作名单](#9-activedataidle-变体和动作名单)
- [10. listener 联动](#10-listener-联动)
- [11. 动作状态、门控与跨动作保留](#11-动作状态门控与跨动作保留)
- [12. 参数写入、物理和渲染帧](#12-参数写入物理和渲染帧)
- [13. 复位、存档与生命周期](#13-复位存档与生命周期)
- [14. 一个完整的交互实例](#14-一个完整的交互实例)
- [15. 文件和字段对应关系](#15-文件和字段对应关系)
- [16. 逆向资料](#16-逆向资料)

## 1. 资源目录与皮肤标识

游戏安装后，Live2D 资源位于应用数据目录的 `files/` 下：

```text
files/
├── AssetBundles/live2d/       # 每套皮肤一个 UnityFS bundle
├── hashes-live2d.csv          # bundle 索引和哈希
├── version-live2d.txt         # Live2D 资源版本
└── ...
```

皮肤标识通常是 `<舰娘拼音>_<皮肤序号>`，改造或婚纱变体可能带 `_hx` 后缀。`hashes-live2d.csv` 只负责定位和校验，模型、Animator、AnimationClip、纹理和自定义 MonoBehaviour 都位于对应 bundle。

一个皮肤在逻辑上由三组数据组成：

1. bundle 内的 Cubism 模型、贴图、物理、Animator 和动作曲线；
2. `sharecfg/ship_l2d.lua` 中的命中区、参数机和动作联动；
3. `live2d.lua`、`live2ddrag.lua`、`live2dextend.lua` 中的控制器规则。

## 2. Unity 与 Cubism 对象

游戏使用 Unity 和 Cubism SDK for Unity，且两代 SDK 并存：旧皮肤由 Cubism 4 SDK 序列化，新皮肤由 Cubism 5 SDK 序列化。两代的 Unity 对象名和字段完全一致，下表对两者通用；差异在 moc3 二进制的版本字节（4 或 5），提取时原样保留，不做转换。Unity prefab 中没有 Web 端的 `.model3.json`，而是直接序列化 Cubism 运行时对象：

| Unity/Cubism 对象         | 运行时职责                                        |
| ------------------------- | ------------------------------------------------- |
| `CubismMoc`               | 保存 moc3 二进制和参数、部件、drawable 的索引关系 |
| `CubismParameter`         | 参数 id、最小值、最大值、默认值和当前值           |
| `CubismPart`              | 部件及其不透明度、层级关系                        |
| `CubismDrawable`          | 网格、纹理索引、绘制顺序和不透明度                |
| `CubismPhysicsController` | 读取 physics3，按输入参数驱动物理输出             |
| `CubismRaycastable`       | 将 drawable 标记为可命中的交互区域                |
| `Texture2D`               | 通常为 ASTC 压缩纹理                              |
| `Live2dChar`              | 游戏自定义的视线速度、阻尼、点击反应和模型级开关  |

参数组件通常没有单独的业务 id，GameObject 名称就是参数名，例如 `ParamAngleX`、`ParamEyeLOpen`。因此参数曲线、Lua 参数机和点击分区最终都通过这个名称连接。

每个命中区域同时存在两个名字：Unity GameObject 中常见 `TouchHead`、`TouchBody`、`TouchDrag1`，模型导出后的 HitArea 通常为 `touch_head`、`touch_body`、`touch_drag1`。控制器比较名称时忽略大小写和下划线。

## 3. 动画资源与 Animator

### 3.1 AnimationClip

动作使用 Unity `AnimationClip`，不是原生 motion3。曲线绑定到 Transform 路径、参数对象、部件不透明度或 drawable 属性；曲线数据存放在 streamed、dense 或 constant 段中。解析时必须按绑定顺序、采样率和曲线类型还原时间轴。

常见动作组包括：

- `idle`：基础待机及其变体；
- `login`、`home`、`main`：进入页面和主界面动作；
- `touch_idle`、`touch_drag`：点击、长按、拖拽反应；
- `task`、`mission`、`special`：系统或任务动作；
- `effect`：叠加在其他动作上的循环氛围层。

`effect` 不负责取代主动作，而是在每帧对自己的参数曲线求值，与主动作、物理和参数机共同写入模型。

### 3.2 Animator 状态迁移

AnimatorController 通过整数参数、触发器和 AnyState 转移选择子状态。`idle` 是整数参数，0、1、8 等数值对应同一 idle 状态机下的不同子状态。动作名只是控制层的索引；真正决定播放哪条曲线的是 Animator 参数和迁移条件。

每条 AnyState 转移保存独立的 `m_TransitionDuration`。`m_HasFixedDuration=True` 时它是绝对秒数。系统和旧触摸动作通常为 0.5 秒，新动作及 `_ex` 变体通常为 0.25 秒，`login`、`home`、`change_in`、`change_out` 通常为 0 秒硬切。

动画事件在动作开始和结束处通知 Lua 控制层。动作结束时控制层显式把动作切回 `idle`，并用当前整数参数重新选择 idle 子状态；不是随机选择一条待机动画。

### 3.3 idle 的特殊行为

idle 是循环状态，不属于“反应动作播放中”。它没有普通动作结束通知，重复进入 idle 也不会像普通动作那样等待 `motionFinish`。触发 `action = "idle"` 时，`SetAction("idle")` 和 `SetInteger("idle", n)` 在同一帧写入，Animator 在下一帧评估迁移，最终进入 `activeData` 指定的变体子状态。

例如 `wuzang_3` 的 `TouchDrag4` 和 `TouchDrag18` 都可以触发 `idle`。点击背景后，控制层把 idle 变体从 0 切换到 8，两个背景板随对应曲线互换入画。

## 4. 控制层和配置文件

| 文件或目录                            | 运行时职责                                             |
| ------------------------------------- | ------------------------------------------------------ |
| `sharecfg/ship_l2d.lua`               | 每个皮肤的命中分区、参数机、触发器、动作状态和联动数据 |
| `sharecfgdata/ship_skin_template.lua` | painting 名与数字皮肤 id 的映射                        |
| `view/ship/live2d.lua`                | 动作播放、idle 切换、点击、动作结束回落                |
| `view/ship/live2ddrag.lua`            | DragMachine、拖拽、按压、冷却、参数机联动              |
| `view/ship/live2dextend.lua`          | 参数叠加、平滑、扩展动作门和特殊玩法                   |
| `mgr/live2dmgr.lua`                   | Live2D 实例装配、生命周期和控制层管理                  |
| prefab / AnimatorController           | Cubism 对象、Animator 参数、状态和转移                 |
| AnimationClip                         | 参数、部件和 Transform 的时间曲线                      |

`ship_l2d` 中每一项通常对应一台 DragMachine，字段包括 `draw_able_name`、`parameter`、`range`、`start_value`、`offset_x/y`、`smooth`、`revert`、`action_trigger`、`action_trigger_active`、`listener_data` 和 `relation_parameter`。

## 5. 运行时对象关系

运行时控制链可以表示为：

```text
Unity/Cubism 模型
		├── HitArea / Drawable / Parameter
		├── Animator / AnimationClip
		└── Physics
						 │
命中区域 ──> Live2d 控制器
						 ├── DragMachine：单台参数机的数值和触发状态
						 ├── DragOrchestrator：动作名单、idle、listener 广播
						 └── InteractionRuntime：动作状态节点、前置门控、跨动作保留
```

一个命中区可以挂多台参数机。按下时同名分区的全部机器都收到 `onDown`，移动时所有仍处于按压状态的机器都更新，松手时全部机器执行收尾。注册顺序只决定命中区优先级和某些按名称读取参数时的后注册覆盖规则，不会把同区机器合并成一台。

## 6. 从指针命中到动作播放

### 6.1 命中区域选择

一次 raycast 会同时得到头部、身体、idle 和 drag 等区域。控制器先检查 drawable 不透明度，隐藏 drawable 不参与交互，再按手势选择区域：

- 点击选择非 `touch_drag` 区域；
- 拖拽选择 `touch_drag` 区域；
- 同一手势下按绘制顺序取最上层的可见命中区域。

命中到有参数机的区域后，参数机路径优先于普通触摸动作路径。

### 6.2 指针生命周期

`onDown` 保存坐标、时间和起始参数。type 2、6、9 等点击型机器在按下时建立按压锁；type 3、8 等按压型机器在处理器中维护锁。`onMove` 根据 `offset_x/y` 计算目标值，屏幕 y 轴先反向再写入配置中的 y 方向。

松手时，位移的横纵分量都小于 30 像素且按压时间小于 0.5 秒，才被视为点击；点击确认再延迟 0.1 秒进入 `applyClickTrigger`。拖拽型机器则提交拖拽基准、执行档位吸附、启动回弹和保存参数。

### 6.3 触发到播放

参数机每帧先检查冷却 `nextTriggerTime` 和单触发标志 `isTriggerAtion`，再执行具体触发器。触发后先写入动作冷却，默认冷却为 4 秒；动作真正开始时，所有机器的冷却统一压缩为 `min(limit_time, 0.2)`。

动作播放的顺序是：

```text
命中/按压
	-> 触发条件成立
	-> 取得 action 和 activeData
	-> 检查动作名单、按压锁和扩展动作门
	-> action = idle 时先确定 idle 变体
	-> Animator 接受动作
	-> 发送 PLAY listener
	-> 应用 activeData
	-> 动作结束时显式回到当前 idle
```

动作不存在、动作被名单拒绝或播放器拒绝时，普通 `activeData` 不落账。`PLAY` 通知发生在 `applyActiveData` 之前，因此监听器可以在动作成功后修改其他机器的目标值或 idle 分支。

## 7. DragMachine 参数机

### 7.1 参数值和目标值

每台机器维护 `parameterValue`、`parameterTargetValue`、`parameterStartValue` 和 `parameterSmoothTime`。拖拽修改目标值，平滑器再让当前值逼近目标值；目标值经过方向、绝对值和范围修正：

1. `drag_direct = 1` 时禁止负方向；
2. `drag_direct = 2` 时禁止正方向；
3. `range_abs = 1` 时取绝对值；
4. 最后钳制到 `range`。

模型中不存在对应参数时，机器仍然维护内部值和动作状态，但不写 Cubism 参数。

### 7.2 mode 和参数图层

机器写入参数时使用三种模式：

- mode 1：Override，直接取机器值；
- mode 2：Additive，在动作求值结果上加机器值；
- mode 3：Multiply，在动作求值结果上乘机器值。

Additive 和 Multiply 每帧分两个阶段处理：先撤掉上一帧的叠加，恢复动作求值后的底值；再在本帧动作求值结果上重新叠加。这样动作曲线未覆盖的参数不会逐帧累积。

### 7.3 拖拽、回弹和吸附

`offset_x/y` 表示移动多少像素改变一个参数单位。松手后当前拖动值写入 `offsetDragTargetX/Y`，下一次按下从该基准继续累加。`revert` 大于 0 时启动回弹计时，计时结束后目标值回到 `start_value`，回弹速度使用 `revert_smooth`。

`parts_data` 保存离散档位。type 1 选择最近档位，type 2 只选择当前值以下的已达档位，type 3 只选择当前值以上的档位。参数距离目标小于 0.05 时直接贴合。

`relation_parameter` 是机器之间的参数联动：type 101/102 跟随拖动量，type 103 按连点下标查询 `relation_value`，type 104 表示 idle 加计时联动。联动参数也可以使用平滑、范围、方向和 mode。

## 8. 触发类型

| 类型           | 运行逻辑                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------ |
| 1              | 按住且参数值进入 `num` 的 25% 邻域，累计 `time` 后播放动作；离开邻域暂停累计，累计值不清零 |
| 2              | 普通点击，松手通过 30 像素/0.5 秒判定后播放动作                                            |
| 3              | 按住计时，依次播放 `action_list`；`last` 让松手时跳到末项收尾                              |
| 4              | 双轴拖动值同时进入两个 `num` 邻域并持续指定时间后播放                                      |
| 5              | 当前 idle 变体匹配 `const_fit.idle` 时，把参数设为 `const_fit.target`                      |
| 6              | 连点依次取 `action_list`，下标从 1 开始并在末项回到 1                                      |
| 8              | 按住充能，目标值每帧增加 `dt / delta`，松手后可吸附到档位                                  |
| 9              | 点击前读取另一台机器的模型参数，只有参数接近 `num` 才播放                                  |
| 12             | 一次性建立扩展动作门，按另一台机器的 `parameterValue` 区间放行或拦截动作                   |
| 10、14、15、16 | 动作链、上下行和小游戏类规则，分别依赖实际皮肤的扩展配置                                   |

type 1 和 type 4 的邻域计时由按下时清零；进入邻域后累计，离开邻域不清零。type 1 触发后计时也不清零，后续重复触发由冷却和 `isTriggerAtion` 两道门控制。type 5 不主动建立动作冷却，冷却只来自真正播放动作后的统一压缩。

type 12 的区间为左开右闭 `(low, high]`。`ignore` 优先于 `enable`；命中 ignore 直接拦截，命中 enable 直接放行，并越过普通白名单和按压锁。

## 9. activeData、idle 变体和动作名单

`action_trigger_active` 是动作成功后的状态包，常见字段为 `idle`、`enable`、`ignore`、`idle_enable`、`idle_ignore`、`repeat_flag` 和 `active_list`。

### 9.1 idle 变体选择

- `idle` 为数字时直接选择该变体；
- `idle` 为数组且 `repeat_flag` 为真时，从完整数组随机选择；
- `idle` 为数组且没有 `repeat_flag` 时先排除当前变体，再随机选择；
- 目标变体与当前变体相同且没有 `repeat_flag` 时，整个触发被豁免；
- `idle` 变体改变后，所有机器检查自己的 `revert_idle_index`，命中时复位拖拽目标和基准。

### 9.2 动作名单

`enable` 存在时直接成为当前动作白名单，并遮蔽 `idle_enable`；`ignore` 存在时成为黑名单，并遮蔽 `idle_ignore`。Lua 空表也会被写入为空名单，用来清除上一阶段残留的名单。若只把空表当作“没有字段”，触摸链结束后白名单会永久残留，后续动作会全部被拦截。

`idle_enable` 和 `idle_ignore` 按目标 idle 数字匹配。数组形式的 idle 在名单匹配时仍使用原始数组值，不会把随机结果再次替换成数字匹配值。

### 9.3 idle 回落

反应动作结束后，控制层显式播放 `idle`，并使用当前 `idleIndex` 解析对应子状态。idle 不占用 `isPlaying`，否则循环动作会让控制层永久处于“动作播放中”，所有点击都会被拦截。

## 10. listener 联动

动作成功后发送 `PLAY(actionName)`，idle 变体改变时发送 `CHANGE_IDLE(idleIndex)`。每台机器都收到广播，但只有匹配 `listener_data` 的机器消费。

### 10.1 change

`listener_data.type = 1` 匹配 PLAY 动作名，`type = 3` 匹配 idle 数字。每条 change 的 kind 有两种：

- kind 1：`target += value`，用于计数或充能；
- kind 2：`target = value`，用于分区档位、置位和清零。

写入后经过方向、绝对值和 range 钳制；命中后默认把连点下标重置为 1，也可以由第四个字段指定下标。

### 10.2 apply

apply 区间使用左闭右开 `[low, high)`。多个区间同时命中时，后面的区间覆盖前面的结果。命中的 idle 与当前 idle 不同才发送切换事件；切换事件会同时执行该变体对应的 `idle_enable`、`idle_ignore` 和机器复位。

## 11. 动作状态、门控与跨动作保留

动作控制器把交互动作视为有向图：节点是状态参数和连续摆位参数的值向量，动作是从一个节点到另一个节点的边。

### 11.1 state 和 carry

- `state` 保存开关状态，例如菜单、眼睛、道具和图层是否打开；
- `carry` 保存连续摆位，例如菜单打开后场景横向移动量；
- `pending` 保存已经起播但结束值尚未落账的动作。

普通动作起播时，上一条 pending 动作先结算；新动作成为 pending。新动作结束时，将其曲线末值写入节点。新动作会顶掉旧动作时，旧动作不等待不存在的 `motionFinish`，而是在新动作起播时立即结算。

idle 是循环动作，起播时立即把自己的状态和摆位末值落到账面，因为它不会产生普通结束事件。

### 11.2 点击门控

门控读取节点值，而不是直接读取 Cubism 当前参数值。当前参数还会受到眨眼、呼吸、物理和其他动作曲线影响，不能作为交互状态的稳定依据。

一个动作的 `state` 起播值为 1，表示该动作要求对应图层、菜单或道具已经处于打开状态。只有节点中的值也为 1 时动作才放行。反应动作播放期间控制器不接受新的普通触摸；动作结束显式回落 idle 后恢复等待状态。

### 11.3 参数复位

每次新动作起播时，未被状态图管理的参数回到 moc3 默认值；`state` 和 `carry` 参数回到当前节点值。复位与动作渐入使用同一个窗口，采用与 Cubism 渐变相同的 sine 缓动，因此未被新动作曲线覆盖的参数不会遗留上一动作姿态，也不会在交叉渐变开始时跳变。

## 12. 参数写入、物理和渲染帧

一帧中的参数来源按以下顺序叠加：

```text
恢复上一帧的 additive/multiply 底值
	-> 动作曲线和动作渐变
	-> 交互状态复位缓动
	-> DragMachine 参数图层
	-> relation_parameter
	-> Cubism 物理
	-> drawable 不透明度和网格更新
	-> 渲染
```

动作曲线负责直接写参数和部件透明度；`effect` 曲线持续叠加氛围参数；DragMachine 按 mode 写入参数；物理控制器读取输入参数并写入物理输出参数。Cubism 核心随后根据参数重新计算 drawable 顶点、部件透明度和绘制顺序。

## 13. 复位、存档与生命周期

模型创建时，控制层把 idle 变体设为 0，清空动作白名单和黑名单，机器目标值取 `start_value`，再播放基础 idle。刷新或重新进入模型时清理交互状态：

1. 清除 pending 动作和状态节点；
2. 所有状态参数恢复 moc 默认值；
3. 所有机器回到起始值，拖拽偏移和联动速度清零；
4. idle 变体回到 0；
5. 清空动作名单和按压锁；
6. 重新播放基础 idle。

机器的拖拽参数、部分连点下标和 `revert = -1` 机器的数据可以写入本地存档。idle 变体和动作名单必须与交互状态一起恢复，单独恢复 idle 数字会造成菜单状态与 idle 变体不一致，因此控制器在新会话从干净节点开始。

## 14. 一个完整的交互实例

以“点击 `TouchIdle1` 摊开菜单、点击菜单项、点击 `TouchIdle3` 收尾”为例：

1. `touch_idle1` 命中区可见，点击通过 30 像素和 0.5 秒判定；
2. 参数机取得 `touch_idle1` 和对应 `activeData`；
3. 播放成功后发送 PLAY，状态节点记录 `caidan: 0 -> 1`；
4. 曲线把连续摆位 `All_X: 0 -> 2.34`，该值作为 carry 保留；
5. 动作结束后回到 idle，菜单仍保持打开；
6. 菜单项动作以 `caidan = 1` 为起播条件，节点满足门控后放行；
7. 菜单项动作结束后，`touch_idle3` 将 `caidan: 1 -> 0`，同时把 `All_X: 2.34 -> 0`；
8. 节点回到中性状态，控制器重新进入基础 idle 等待输入。

如果在菜单未打开时直接命中菜单项，节点中的 `caidan` 仍为 0，动作不会播放；如果菜单动作播放中再次点击，控制器仍处于非等待态，也不会启动新的普通触摸动作。

## 15. 文件和字段对应关系

提取后的目录结构如下：

```text
<skin>/
├── <id>.model3.json       # Cubism 模型入口、参数、部件、drawable、HitAreas
├── <id>.moc3              # Cubism 模型二进制，v4 或 v5
├── <id>.physics3.json     # 物理输入、输出和重力配置
├── <id>.char.json         # Live2dChar 的视线、阻尼和基础开关
├── <id>.interaction.json  # 动作 state/carry、事件和状态节点数据
├── <id>.l2d.json          # ship_l2d 参数机、触发器、listener 和 idle 表
├── <id>.fades.json        # Animator 每个动作的转场时长
├── <id>.defaults.json     # moc 参数的最小值、最大值和默认值
├── <id>.inventory.json    # Unity 对象、绑定和未映射数据
├── textures/              # 解码后的纹理
└── motions/               # 从 AnimationClip 还原的 motion3 曲线
```

`model3.json`、`moc3`、纹理和 physics3 负责 Cubism 渲染；`interaction.json` 负责动作状态节点和门控；`l2d.json` 负责拖拽参数机；`fades.json` 保存 Animator 转场；`defaults.json` 提供参数复位目标；`inventory.json` 保留 Unity 序列化对象和无法映射的绑定。

## 16. 逆向资料

Lua 文件来自社区维护的 [AzurLaneLuaScripts](https://github.com/AzurLaneTools/AzurLaneLuaScripts)，不是游戏 bundle 的一部分。C# 控制器由 APK 中的 `libil2cpp.so`、`global-metadata.dat` 和 Il2CppDumper 输出辅助确认。项目中的 `scripts/pull_lua.py`、`scripts/pull_cs.py` 和 `scripts/disasm.py` 分别用于获取 Lua 快照、C# dump 和定点反汇编。

本文涉及的运行时装配、动作状态和参数机实现集中在 [src/l2d](../src/l2d/)、[src/utils/dragmachine](../src/utils/dragmachine/) 和 [src/utils/interaction](../src/utils/interaction/)；对应行为由 `scripts/tests/` 下的 dragmachine、interaction、listener、trigger 和模型测试覆盖。
