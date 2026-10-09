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

交互由 Unity **AnimatorController** 驱动（序列化在 bundle 内，UnityPy 可完整
解析 `m_Controller` blob），逻辑分散在三类载体中：

- **控制器路由**（bundle 内，可提取）：C# 层不直接播动画，而是
  `SetInteger(动作编号)` + `SetTrigger`，经 AnyState 转移进入对应状态（转移
  与状态 1:1，条件 `m_ConditionMode` 6=Equals 整数、1=If 触发器）。主 int
  即**动作编号 ActionId**，取值域：
  - 1–19 系统动作：idle=1、main_1/2/3=2/3/4、complete=5、login=6、home=7、
    mail=8、mission=9、mission_complete=10、wedding=11、touch_head=12、
    touch_body=13、touch_special=14、金币/油/钻石=15/16/17、main_4/5=18/19
  - 101–110 = touch_drag0–9；201–221 = touch_idle0–20

  次 int 是 idle 变体号（ActionId=1 时选 `idle_list.idle<N>`）。每个状态对应
  一支动作或为**空跳板**（该皮肤未带这支动作，收到编号后无画面变化，实际
  效果由 C# 直接改参数实现）。状态→动作对应与编号只存在这份序列化数据里，
  由 `extract.py` 提取进 interaction.json 的 `animator` 节

- **AnimationEvent 钩子**：每支动作内嵌事件——`OnAnimEvent(0)` 在动作开头触发
  （语音/配音钩子）；`OnFinishAnim(N)` 在动作结尾 `SetInteger(ActionId, N)`：
  系统动作 N=自身编号（自循环），触摸反应 N=0（无状态匹配，回落默认 idle）
  ——即"播完进入等待输入"语义
- **跨动作参数状态**：游戏不在动作间复位参数，图层/道具开关型参数（取值贴
  0/±1，如菜单开合、菜单可点区）的值跨动作持续。"菜单摊开"就是 touch_idle
  系列动作播完后开关值残留在运行时里
- **点击门控 = 起播边界一致性**：每支动作的开关型参数起播值即其可达前置状态。
  同一分区的多支分支动作以不同起播值区分（如"菜单摊开时才可触发"的分支以
  开关=1 起播，"菜单收起时才可触发"的分支以开关=0 起播）。当前参数状态与
  某动作的起播边界不符时，该动作不可被点击触发

参数默认值不在 bundle 内（在 moc3 二进制中），运行时以"非默认即状态残留"判断
当前状态。

点击分区（`TouchDragN` 等分区 GameObject）到 ActionId/图层参数的映射在游戏
Lua 配置 `pg.ship_l2d` 里（键 = 皮肤id\*100 + 序号），bundle 提取不到——
如 TouchDrag1（高跟鞋区）拖拽切换图层，而 touch_drag 组多数状态是空跳板，
实际路由到别的 ActionId 分支或 C# 直接改图层参数。这份数据由社区解密仓库
提供（来历见下），`scripts/parse_ship_l2d.py <skin_id>` 可解析，
`scripts/bake_l2d.py <painting名>` 可把整皮肤配置烘焙进模型目录
（`<id>.l2d.json`，运行时消费方式见 README"查看器实现"）：
fulici_2（皮肤 407041）实测 16 区，含拖拽参数机（range/smooth/revert/吸附
档位 `parts_data`）、触发条件（`action_trigger` 的 type/circle/target）与
idle 变体切换（`action_trigger_active.idle`：touch_idle1/2/4/6/8 →
idle 1/2/4/5/6，touch_idle3/5/7/9 → idle 0 回基础待机）。

**控制层语义**（通读 `view/ship/live2d.lua` / `live2ddrag.lua` /
`live2dextend.lua` 得出，Web 移植见 `src/utils/dragmachine.js`）：

- 每条 ship_l2d 条目 = 一台 Live2dDrag 参数机：分区（`draw_able_name`）绑定
  参数（`parameter`），按下命中分区即激活（`startDrag`），拖动时
  `offset = target + (指针-按下点)/offset_x|y`（offset = 拖动 1 单位参数的
  像素数），目标值经 `drag_direct`（1=负向钳 0 / 2=正向钳 0）、`range_abs`
  （取绝对值）、`range`（钳制）修正，`smooth`/1000 秒平滑趋近（差 <0.05 贴合；
  `live2dextend.lua` 的 `CustomSmoothValue` 即线性插值 `from + (to-from)·p/d`，
  非缓动/阻尼，p 每帧累加 dt 直至 d）；
  松手时 `parts_data.parts` 吸附最近档位，`revert`/1000 秒后回 `start_value`
  （-1 = 不回弹且持久化，`save_parameter=-1` 除外），`revert_smooth` 是回弹时长
- 触发 `action_trigger.type`：1=按住 num 附近达 time 秒、2=点击（|dx|<30px
  且 <0.5s，松手后 0.1s 确认；`action` 可为随机数组）、3=按住 time 秒
  （action_list 顺序播，`last` 松手收尾）、4=xy 双参联动、5=idle 常量跟随、
  6=连点循环 action_list（与 2 共用点击判定，见下）、7=监听外部事件、
  8=按住充能（delta 秒/单位）、9=点击时他参贴近 num、10=当前动画过
  trigger_rate 时链触发、11=点击时本参在 range 内、12=扩展规则、13=跟随
  他参变动、14=区间上下行触发、15/16=下棋小游戏。`circle`+`target`：触发把
  参数设到 target，已在 target 则回 start_value（图层 0↔1 切换）；
  `focus=1` 按下即触发；`target_focus=1` 参数跳变；`limit_time`（默认 4s）
  是触发冷却
- **点击触发的 apply 分支顺序**（`onEventCallback(EVENT_ACTION_APPLY)` 的
  机器侧构造块，type 2/6 共用）：按 `action` / `action_list` / 两者皆无
  三分支取本次 action 与 activeData——`action_list` 分支取
  `action_list[actionListIndex]`（连点下标，1 起），**取完即推进、末位回卷
  到 1**（推进发生在重复 idle 豁免之前，被豁免跳过的触发同样消耗一次下标）；
  `action_list` 有值时仅 action 非空才 `triggerAction()`，两者皆无（纯
  circle/target 开关机）则 `triggerAction()` 后立即清单触发标记。之后才是
  重复 idle 豁免 → circle/target 落账 → focus 清标记 → 发事件播放
- **触发冷却的塌缩**：`onListenerTrigger` 收到 `ON_ACTION_PLAY`（Lua 层动作
  真正播出，仅 apply 处理器发，idle 循环重启不算）时对**全部机器**无条件
  覆写 `nextTriggerTime = min(limitTime, 0.2)`——即 `limit_time` 的足额冷却
  只在不产出动作播放的场合生效（重复 idle 豁免、播放失败、纯开关机）；
  只要触发出了动作，冷却当场塌缩回 0.2s
- **连点下标持久化**：type 6 在 `saveData`（每次 `stopDrag`）写
  `SetDragActionIndex`，`loadData` 恢复。落盘时机在松手、下标推进在松手后
  0.1s 的确认触发里——存档恒滞后一轮，读档重进会重播"上次点的那下"而非
  接着推进，是游戏原行为
- 触发成功后应用 `action_trigger_active`：`enable`/`ignore` 是之后的动作
  白名单/黑名单（**对一切动作播放生效**，含系统面板触发；空数组 = 清空），
  `idle`（数字或数组）切换待机变体——即 Animator SetInteger("idle")，
  触发即设、播完落 idle 态时生效；重复 idle 且未开 `repeat_flag` 时整个
  触发跳过。机器按下期间（`EVENT_ACTION_ABLE`，ableFlag=true 时把播放白名单
  换成 `{"none action apply"}`）一切动作播放被临时屏蔽——例外是 type 3 长按
  触发瞬间先 `setAbleWithFlag(false)` 再 apply 再置回：按住期间自发触发的动作
  要过 checkEnablePlay，靠这扇临时窗播出（wuzang_3 的充能姿势 touch_drag2
  即此路径，移植漏掉它则充能动画永远不播）
- 机器参数以 `AddParameterValue(parameter, start_value, mode)` 注册为叠加
  来源：mode 1=Override / 2=Additive / 3=Multiply，逐帧覆盖在动作求值结果
  之上（模型里不存在该参数时机器只记账不写值）
- `relation_parameter.list` 联动参数：type 101/102 跟随拖动量、103 跟随
  action_list 下标（查 relation_value 表）、104 按 idle + 计时激活，默认跟随
  机器参数目标值，SmoothDamp 平滑（smooth/1000 秒）
- 待机变体号 → 动作 clip 的对应只在 Animator 路由表里（extract.py 产出的
  interaction.json `animator.states`：actionId=1 的 subIndex 即变体号），
  bake_l2d.py 据此生成 `idle_index` 映射表供运行时查表
- **组名动作 = 子状态路由，非随机**：action/名单里写 `idle` 这类组名时，游戏
  喂给 Animator 的是当前变体所在的子状态（`SetInteger("idle")` 后播当前变体
  clip），不是随机挑一支；其余组名（main_1 等）播同名 clip。bake 产物里
  idle 组成员顺序与变体号无关（如 wuzang_3 组内下标 0 是 idle4），按下标
  随机会错播其他摆位（摆位判定框随之入画，表现为"挂载即巨大判定框"）
- **取景语义**（`view/ship/live2dpainting.lua`）：没有 ROI/内容拟合——模型根
  节点即画布原点（canvasinfo CanvasOrigin），根缩放恒 `live2d_offset[4]` 或
  默认 `Vector3(52,52,52)`（全皮肤一致），`localPosition = live2d_offset`
  （母港 UI 点，y 向上，`sharecfgdata/ship_skin_template.lua` 逐皮肤给出），
  相机固定。等价到查看器（本地 px，y 向下，与 pixi-live2d-display
  getDrawableVertices 的换算同源：`x_local = k·PPU + W/2`、
  `y_local = −k·PPU + H/2`，k 为 core 单位制坐标）：视口中心对应模型点
  k = −offset/52，可见画布高 = 母港设计高 750pt ÷ (52/PPU) ≈ 3037px 恒定。
  `live2d_offset` 由 bake_l2d.py 烘进 l2d.json，L2dStage.fitModel 按此取景，
  无配置时退回旧的 measureScene ROI 拟合

**C# 侧语义**（dump.cs + 定点小窗口反汇编证实，获取途径见第 4 节）：

- **命中检测 `Live2dChar.GetDragPart()`**：`camera.ScreenPointToRay(Input.mousePosition)`
  → `CubismRaycaster.Raycast` 全量命中 → 对每个命中 drawable 名取
  `Array.IndexOf(DragParts, name)`，**最大下标者赢**，返回 下标+1（0 = 无命中）。
  `DragParts` = assistantTouchParts + 各机器分区按 ship_l2d_id 注册顺序追加
  （去重），即**重叠分区里注册越晚的优先**（如 fulici_2 的 TouchIdle7/8/9 注册在
  TouchDrag7 之后，重叠区域按下认 idle 分区）。赢家只是**分区名**：Lua 侧
  `onPointDown`（live2d.lua）遍历全部机器、`drawAbleName` 等于赢家分区的
  **逐台 startDrag**，松手 `stopDrag` 广播给全部机器——多台机器共用同一
  分区是有意设计，按下时协同激活（wuzang_3 的 TouchDrag2 挂充能 + 双
  relation 联动 + type 3 长按共 4 台；shengluyisi_5 的 TouchIdle1 挂 6 台
  收尾机同理）。~~旧记录"只有注册最早那台可经命中到达"系误读，已证伪~~
- **参数叠加层**：`AddParameterValue`/`ChangeParameterData` 只维护
  `_CustomParameterDic`（每参数一条 `{value, blendMode}`），`LateUpdate` 每帧
  对每条调 `CubismParameterExtension.SetParameterValue(param, value, weight=1,
blendMode)` 落到模型参数——Override/Additive/Multiply 与 Cubism 枚举语义
  一致；**未注册参数的 `ChangeParameterData` 是静默 no-op**
- **坐标**：游戏用 `Input.mousePosition`（Unity 屏幕坐标，y 向上），Web 移植
  （浏览器 y 向下）时拖拽量的 y 分量须取反，否则 `offset_y` 型机器方向颠倒

**游戏 Lua 的来历**：github.com/AzurLaneTools/AzurLaneLuaScripts（社区自动
解密发布的明文游戏脚本）。用到的文件由 `scripts/pull_lua.py`
（uv / 裸 python 均可）拉取到 `.tmp/lua/<服务器>/`——落点硬编码固定，
无路径参数（CN/EN/JP/KR/TW，
`--server` 可多选；
gitignore，不入库）：`sharecfg/ship_l2d.lua`（交互配置）、
`sharecfgdata/ship_skin_template.lua`（painting 名 → 皮肤 id 映射）、
`view/ship/live2d*.lua` 与 `mgr/live2dmgr.lua`（控制层，字段语义的参照，
本节"控制层语义"即通读这批文件得出；必需文件默认拉取，控制层用 `--all`）。
上游仓库停更不影响已有快照。
**C# 侧语义**由 `scripts/pull_cs.py` 提供：adb 拉游戏 APK（`pm path` 找包）→
解 zip 取 `libil2cpp.so`（arm64 优先）+ `global-metadata.dat` → 调
Il2CppDumper 出 dump.cs（落 `.tmp/cs/dump/`）；方法体的语义核对用
`scripts/disasm_window.py` 对指定 Offset 做**定点小窗口**反汇编（ARM64），
勿全量扫描

以上数据由 `extract.py` 提取为 `<id>.interaction.json`，字段语义见
[unpack.md](unpack.md)。

## 4. 环境与工具约定

- Python：依赖见 `requirements.txt`（UnityPy、Capstone）；可使用 uv、
  venv/virtualenv 或全局 Python，反汇编命令见上文；提取脚本在 `scripts/`，
  `tools/` 放随仓库分发的第三方工具
- Node：mise 管理（`mise.toml`）
- `tools/`（入库，许可证见 README 版权说明）：
  - `tools/adb/` — Android platform-tools，`pull_bundles.py` 拉资源用
  - `tools/Il2CppDumper/` — [Perfare/Il2CppDumper](https://github.com/Perfare/Il2CppDumper)
    （MIT），dump 游戏 Il2Cpp 程序集用；只保留 x64 主程序与 config.json
- `.tmp/`（gitignore，管线工作目录，按需自建）：
  - `.tmp/bundles/` — `pull_bundles.py` 拉取的皮肤 bundle
  - `.tmp/lua/` — [AzurLaneTools/AzurLaneLuaScripts](https://github.com/AzurLaneTools/AzurLaneLuaScripts)
    的明文游戏 Lua 子集（按服务器分子目录），由 `pull_lua.py` 拉取（文件清单见
    第 3 节；`extract.py` 本身不依赖它，仅 `parse_ship_l2d.py` 解析交互配置用，
    读取路径同为 `.tmp/lua/<服务器>/`，两端硬编码对齐，勿改其一）
  - `.tmp/cs/` — `pull_cs.py` 的产物：设备拉回的 APK（`apk/`）、
    `libil2cpp.so` + `global-metadata.dat`、Il2CppDumper 输出（`dump/dump.cs`
    等）；语义核对配 `disasm_window.py`（第 3 节"C# 侧语义"）
