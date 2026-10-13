# 测试脚本说明

node 直跑的冒烟/体检测试，无测试框架依赖。入口 `npm test`（等价 `node scripts/tests/run_all.mjs`），**在仓库根目录跑**（测试按相对路径读 `models/`、`public/libs/`）。退出码 0 = 全过 / 1 = 有失败。

```
node scripts/tests/run_all.mjs [名字子串...] [--fail-fast|-f]
```

- 子串过滤：对 unit/、asset/ 下的相对路径匹配，`npm test -- dragmachine` 只跑路径含 `dragmachine` 的。
- `--fail-fast`：首个失败文件后停止，剩余不跑。
- 汇总带每文件通过/失败计数（解析各测试末尾的 `SUMMARY pass=N fail=M` 行）与耗时；断言失败行同行带实际值/期望值（`eq`/`near` 自动带上），汇总里还有失败项名单，不用往上翻。

```
scripts/tests/
├── run_all.mjs                # 入口：串行跑 unit/ 与 asset/ 下全部 test_*.mjs（unit 先跑），子串过滤 + --fail-fast
├── unit/                      # 合成配置驱动的纯逻辑测试（不依赖 models/）
│   ├── test_dragmachine.mjs   # 拖拽参数机控制层：状态机 + 联动层 listener_data + 触发类型 1/5/10/11/12
│   ├── test_interaction.mjs   # 交互有向图状态机（需 public/libs 的 Cubism Core，仅 import）
│   └── test_render.mjs        # 渲染参数层三件：palette 落笔豁免 / ambient effect 曲线采样 / 曲线目标序归一
├── asset/                     # 依赖真实模型资产的回归测试（缺资产整支跳过而非失败）
│   ├── test_ladder_loop.mjs   # shengluyisi_5 梯子两圈链路回归（真实 l2d.json + 真机器）
│   ├── test_models.mjs        # models/ 全皮肤 moc3 资产体检
│   └── test_trace.mjs         # 逐帧 trace 确定性回归（真实资产）
├── probe/                     # 诊断 CLI（不进 run_all，见下文）
└── helpers/
    ├── suite.mjs              # check/eq/near/section 断言套件（ok/FAIL 行 + 失败诊断 + 退出码）
    ├── machines.mjs           # machineById/machinesById：按条目 id 取机器（禁用位置解构）
    ├── fakes.mjs              # 假 coreModel / 假 pixi 模型工厂 / stubLocalStorage
    ├── cubism.mjs             # node 下加载 Cubism Core + moc3 模型
    ├── model_files.mjs        # 皮肤目录解析 / JSON 读取 / 分区名归一化
    ├── motion3.mjs            # motion3 曲线采样 + interaction clip 取值
    ├── sim.mjs                # 全管线仿真 harness（真实 runtime/orchestrator/actions）
    ├── clock.mjs              # 可控单调时钟（场景/点击窗/采样共用同一时间轴）
    ├── trace.mjs              # 逐帧 trace 记录与差异定位
    └── geometry.mjs           # drawable 包围盒 / 顶点快照 / 位移排名
```

单独跑某一支：`node scripts/tests/unit/test_dragmachine.mjs`。

**脚本层设计边界**（定案）：前端交互与注入 = JS 脚本（src/ + scripts/tests/\*.mjs），本地文件操作与处理 = py 脚本（extract.py / extract.py）。例外：probe/ 直读 moc3 的脚本必须是 JS——moc3 解析依赖 Cubism Core 的 wasm，Python 无等价能力；边界划在格式解析器归属上（moc3 是前端资产格式，不是普通本地文件）。

## 各脚本的使用场景

### unit/test_dragmachine.mjs — 拖拽参数机控制层

**场景**：改 [src/utils/dragmachine/](../src/utils/dragmachine/)（machine.js / orchestrator.js / triggers.js）后回归。合成 ship_l2d 条目分三段覆盖：

- **状态机**：type 1（按压邻域累计）/ 2（常规点击，含 down 配置）/ 3（长按播表 + slot11 回绕松开）/ 6（连点列表）/ 8（充能档位）/ 9（点参触发）/ 12（扩展动作规则过滤门；不主动触发，故 interactable 仍为 null）、relation 101（跟随拖动量）/ 103（开关下标对齐）、冷却塌缩（含 idle 起播）、interactable 红绿判定、ableFlag 开窗监听、pressLock 门控矩阵（谁按下上锁/谁不上锁/锁不影响 onMove/幂等 + reason 留痕）、additive 两阶段还原、localStorage 持久化、同值 changeIdleIndex 不复位、`idle` 摆位机的先切变体后播放、被顶掉动作的播放状态清理、resetAll 契约一揽子（平滑状态/下标/冷却/extendActionFlag 跨域残留全归位）。
- **联动层**：kind 1 相对增量 / kind 2 绝对赋值、range 钳制、联动命中复位连点下标、apply 区间换挡 + idle_enable/idle_ignore 按变体取名单、type 3 变体号匹配、同值 changeIdleIndex 也广播（CT:1206-1224）、PLAY 通知经 onActionApply 发射、真实点击链路的 PLAY 发射。DRAG_CLICK(2) 在原文是死路径（EVENT_ACTION_APPLY 成功回调实参恒 nil，CT:269/305），专门断言 notice(2) 不再产生任何副作用。
- **触发类型**：type 1 按压 num 邻域（±|num|·0.25）累计计时、触发后不清零、单 action 触发即松开（slot11）、action_list 连发到回绕、离开邻域不累计、播放中抑制；type 5 idle 常量跟随（const_fit 变体匹配贴 target、无按压要求、播放中不贴）；type 10 动作链（state 名+变体号匹配时归一化播进过 rate 触发，animationPlayApply 单次闩锁）；type 11 点击区间（点击时他参现值落 num 左闭右开区间才触发）；type 12 扩展门（区间左开右闭、ignore 拦截、enable 直通越按压锁、'idle' 恒放行、resetAll 清位）；另直测 readDragParameter 的按名读取/末台胜出/缺省 0。

这些是逆向自游戏 ship_l2d 的控制层语义（见 [azurlane.md](azurlane.md) 第 3 节），改动若让行为偏离游戏实况会在这里红。

### unit/test_interaction.mjs — 交互状态机

**场景**：改 [src/utils/interaction/](../src/utils/interaction/)（runtime.js / hitTest.js / hints.js）后回归。fixture 复刻"touch_idle1 摊开菜单 → touch_idle2 分支（前置 caidan=1）→ touch_idle3 收尾带回 0"这条游戏内实况链路，覆盖：statePids/carryPids/gatedPids 派生、节点跟踪（pending 结算、被顶掉先行结算、idle 起播立即落账）、canPlay 门控（查节点不查实时参数）、firstVisibleHit 手势路由与透明度过滤、resetParameters/resetState、playHitMotion 精确命中与组内选支。需要 Cubism Core 在位（仅 import），缺文件时整支跳过。动作被顶掉、idle 起播立即结算以及参数复位窗口的行为也应与运行时保持一致。

### unit/test_render.mjs — 渲染参数层

**场景**：改 [src/l2d/](../src/l2d/) 渲染参数相关的控制层后回归。三段：

- **palette**（改 src/l2d/palette.js）：调色板落笔豁免——在播动作曲线驱动的色轴不落笔（动作求值逐帧直写该参数，控制层复写会盖掉动作值），未驱动轴照常覆写为选色、无编排器全量落笔、无面板参数的皮肤整层旁路。
- **ambient**（改 src/utils/ambient.js）：effect 组曲线采样，fetch 打桩喂 fixture motion3，覆盖四种段类型（线性/贝塞尔/阶跃/反阶跃）、超程钳制到参数范围（shengluyisi_5 Param90/92 达 14.7 的实况）、时长取模循环、缺失参数跳过绑定。曲线只经 loadAmbient+apply 驱动，不直接测内部函数。
- **曲线目标序归一**（改 src/l2d/motionPatches.js）：内核求值循环按 Model→Parameter→PartOpacity 顺序遍历、遇类型切换即停，混排曲线会让其后同型曲线整体失去求值——归一必须把任何混排修成分组序（含 Meta 镜像同步/已分组原样/缺 Target 兜底/空数据不抛）。需 Cubism Core，缺文件时该段跳过。

### asset/test_ladder_loop.mjs — shengluyisi_5 梯子环回

**场景**：改触发路由（gestures.js 的 machineZonesAt / orchestrator 的 zoneOrder）或 t6 连点推进后回归。用真实 l2d.json + 真机器代码驱动两圈点击链（drag1 → drag3:4 → … → drag13:19 → 环回），断言每击都播出动作、第二圈起点不断链。注意 onUp 的点击确认窗用真实钟，测试里的假钟须与 performance.now 对齐。

### asset/test_models.mjs — 模型资产体检

**场景**：提取管线产出新的皮肤目录（models/<角色>/<皮肤>/）后验资产完整性。逐套皮肤检查：HitAreas 全部可解析到 drawable、defaults.json 覆盖全部 moc 参数、interaction.json / l2d.json 在位；并打印默认姿态下命中区网格包围盒（isHit 的实际判定范围），供人工对照游戏内触发位置。合并了昔日的 .tmp/probe_deformed / probe_hitmesh 一次性探针。

**模型不入库**：本机 models/ 为空或缺 Cubism Core 时整支自动跳过（exit 0），新克隆的仓库跑 `npm test` 不会被资产依赖卡住。

### asset/test_trace.mjs — 逐帧 trace 确定性

**场景**：改 sim 装配或时钟链路后回归。同一资产、同一场景重复运行必须得到确定性结果（逐帧参数快照零差异）——这是后续接入 Unity 录制数据的基础：先保证 Web 侧自身没有时钟漂移。缺真实资产时整支跳过。

### asset/test_engine_motion.mjs — 真引擎 vs 自写求值器

**场景**：改 motion3 求值器（helpers/motion3.mjs）、动作加载补丁（motionPatches.js）或引擎装配（helpers/engine.mjs）后回归。在 node 里构造真 Cubism4InternalModel（Core wasm + Framework 动作队列 + 渐变混合），按 60fps 虚拟时钟驱动动作，断言引擎逐参数值与自写求值器 sampleMotionAt 一致（容差 0.01）。通用皮肤发现（models/ 下第一套带 idle 组的皮肤），对照 idle 末支变体 + 首个非 idle 组第一支。

对照窗口避开两处引擎合法分歧，断言前消化：物理输出参数（physics3.json 的 Destination.Id）被物理求值在动作之后覆写；fade 混合期 `v = source + (curve-source)*w` 里 w<1 的区段与裸曲线不可比——引擎 fadeOut 按生产语义归零（fades 表出场由下一支 fadeIn 承担），采样点取 fadeIn 数倍后即避开。另有一帧起播延迟（动作入列计时发生在 startMotion 后的首次 update），先在 t0 步进一帧对齐。

## 诊断 CLI（scripts/tests/probe/）

不进 `run_all.mjs` 的诊断工具，`node scripts/tests/probe/<脚本>.mjs <皮肤目录> <子命令> [参数]` 手动跑。（moc3 直读类必须在 JS 侧做——moc3 解析依赖 Cubism Core wasm，见上文设计边界。）

### moc3.mjs — moc3 资产静态阅读

```
node scripts/tests/probe/moc3.mjs <皮肤目录|moc3> params [--param 子串] [--check] [--all]
node scripts/tests/probe/moc3.mjs <皮肤目录> textures | uvs | parts | hitop
node scripts/tests/probe/moc3.mjs <皮肤目录> hits [--at clip@t ...] [--param pid=v ...]
```

- `params`：Cubism Core 直读参数表（min/max/default 不全等的行，`--all` 全打印，`--param` 子串过滤）+ canvasinfo。`--check` 与同目录 l2d.json 逐机器核对三件事：机器参数是否存在于模型（不存在则只记账不写值）、machine.range 是否超出模型参数区间（越界段被 Cubism 钳掉）、type 4 的 action_trigger.num 是否落在 machine.range 的 ±25% 邻域内（不在则该触发恒不可达——wuzang_3 的 TouchDrag11/12 即此类，num [10,20] 对 range [-1,1] 数学上永不成立，游戏端同款公式同款死法）。排查"按档位/按位置的事件不出现"先跑这个：配置侧不可达的，移植端无病可修；可达的再去查运行时。
- `textures`：drawable 的 textureIndex 分布、part/drawable 计数；`uvs`：按 textureIndex 汇总 UV 范围；`parts`：初始 part opacity 分布及由此推算的 drawable 可见性；`hitop`：HitAreas 对应 drawable 的初始透明度与渲染顺序。
- `hits`：还原 pixi-live2d-display 的 HitAreas 解析（Name -> drawable 下标），打印各命中区网格包围盒（画布 px；数值天然巨大是正常的——moc3 画布空间，wuzang_3 画布 8000×8000，背景板级判定区即 4374×4000 量级），并与 l2d.json 的 draw_able_name 按查看器同规则归一化核对，标出"命中分区但机器没接管/机器配了但网格缺失"两侧错位。keyform 开关参数会整体拽动判定面网格，`--at clip@t`（动作曲线@t 姿态）/ `--param pid=v`（覆盖值）可重算判定框位移。屏幕 px / 占视口高比例依赖实时取景，静态探针不可复算，只出画布 px。

### config.mjs — 配置摘要

```
node scripts/tests/probe/config.mjs <皮肤目录> entries | interaction
```

- `entries`：l2d.json 动作条目摘要（id / 分区 / mode / 参数 / 触发器 / active 变体与名单规模）。
- `interaction`：interaction.json 的 clip 状态与门控参数摘要（state/carry 区间、statePids、gated 可产出参数）。

### drive.mjs — 交互管线驱动

```
node scripts/tests/probe/drive.mjs <皮肤目录> replay \
  --scene "wait:0.5 click:TouchIdle1 wait:4.5 click:TouchIdle4 wait:13" \
  [--tap] [--param Pid,...] [--game "touch_idle4 idle4@0"]
node scripts/tests/probe/drive.mjs <皮肤目录> chain <分区名> [点击前等待秒] [--watch 参数名 ...]
node scripts/tests/probe/drive.mjs <皮肤目录> zones
node scripts/tests/probe/drive.mjs <皮肤目录> minigame <入口分区> <判定分区> [轮数=20] [--seed 1]
```

用真实 InteractionRuntime + DragOrchestrator + createActions 代码 + 真实 moc3/motion3 资产，在 node 里按 60fps 复现 viewer 的帧循环（restoreLayer -> motion 曲线 -> applyLayer），装配顺序与 mount.js 对齐。排查"点了没反应 / 播错动作 / 特殊待机扭曲 / 复位不干净"这类运行时问题先跑 `replay` / `zones`。

- `replay` 的 `--scene` 步骤：`wait:<sec>` 播放、`click:<zone>[:hold]` 点区域（hold 默认 0.15）、`reset` 调 ctx.actions.resetInteraction()。`--tap` 打印 orchestrator 的 [tap] 调试行；`--param` 末尾追加打印参数值。`--game "<clip> <motion>[@<t>]"` 与游戏应然态逐参数对比：应然态 = clip 的 state/carry 节点尾值 + 变体 motion 曲线@t；clip/motion 未覆盖的参数以 moc3 默认值为应然态，机器把开关写偏（如默认 1 被写成 0）也能暴露。
- `chain`：逐次点击指定分区，打印动作日志与 `--watch` 参数的实时值轨迹，定位链系动作的触发/分档行为。
- `zones`：分区交互审计——从干净态逐个命中区实测"点/按/拖是否真的有响应"（判据：动作播出 / 机器参数位移 |Δ|>0.01 / 分区参数被联动层带动，三者皆无 = 死分区），并对照提示层判据（机器 interactable / 无机器 canPlay），输出两侧不一致与死分区清单。每个分区 tap（down 0.15s + up）与 drag（按住 1s 内线性拖 60px + up）两轮，两轮间 resetInteraction 归零。
- `minigame`：模拟"进入→随机时刻点判定分区"的连续会话，统计 good/miss 走向与状态滞留。

场景重放同时生成逐帧 trace（动作边界、状态机、参数快照），可导出供 Unity 对照：

```bash
node scripts/tests/probe/drive.mjs models/fulici/fulici_2 replay \
  --scene "wait:0.5 click:TouchIdle1 wait:2" \
  --trace-out .tmp/fulici-web.trace.json
```

外部样本需使用相同字段格式（`version`、`frames[].parameters` 等），可直接比较第一处分叉：

```bash
node scripts/tests/probe/drive.mjs models/fulici/fulici_2 replay \
  --scene "wait:0.5 click:TouchIdle1 wait:2" \
  --trace-compare .tmp/fulici-unity.trace.json
```

差异报告优先显示帧号和参数名；默认参数误差阈值为 `0.01`。`helpers/clock.mjs` 保证场景时间、点击窗口、动作起播和逐帧采样共用同一虚拟时钟，避免真实 `performance.now()` 造成不可复现结果。

例（fulici_2 复位场景）：`--scene "wait:0.5 click:TouchIdle1 wait:4.5 click:TouchIdle4 wait:11 reset wait:0.5"`——复位全绿的判据是 pending=idle、idleIndex=0、白名单=0、isNeutral=true、节点无残留。

### diff.mjs — 参数态差分

```
node scripts/tests/probe/diff.mjs <皮肤名|目录> reset [--baseline-wait 2 ...]
node scripts/tests/probe/diff.mjs <皮肤目录> pose \
  --pose "S_GAME: clip=touch_idle4 motion=idle4@0" \
  --pose "H1: clip=touch_idle4 motion=idle@0" \
  [--diff 1,2] [--skip-diff]
```

- `reset`：复位流程的参数终态差分 + 残差收敛追踪 + 写入者归属。场景 A 干净挂载 + 播 idle 记稳态基线；场景 B 点触点制造交互残留 → resetInteraction → 推进到回显时刻与基线差分，逐参标注写入者（idle 常量曲线 / 机器 parameterName / relation / 都不是=物理或引擎层）；之后按步长采样差分参数数直到收敛。差分非零即复位后参数未收敛的参数级来源。
- `pose`：按「节点尾值 + motion 曲线@t + 手工覆盖」构造若干候选参数态，对真实 moc3 逐个 update，打印各姿态的网格包围盒（全部/可见两行），以及各姿态 vs 第一个姿态（基准）的按 drawable 顶点最大位移排名——定位"扭曲/错位"来自哪个参数态假设。姿态 spec：`clip=<name>` 节点尾值（state+carry 的 end）；`carry=0` / `state=0` 掐掉对应来源；`start=<name>` 改用另一 clip 的衔接首值；`motion=<name>[@<t>]` 叠加曲线采样（t 默认 0，`@end` = 末帧-1/30）；`set=Pid=v,...` 手工覆盖。

### engine_motion_chain.mjs / pixi_events.mjs（独立保留）

- `engine_motion_chain.mjs`：pixi-live2d-display 真 CubismMotion 引擎链（Framework 侧求值，非 sim 自写求值器），核对"浏览器真引擎路径"与仿真求值器的差异；稳态一致性已钉死为常驻回归 asset/test_engine_motion.mjs。
- `pixi_events.mjs`：pixi 事件管线探针（归档），`npm run dev` 后把打印的代码粘进浏览器控制台执行。历史结论（pixi v6 + pixi-live2d-display 组合）是 pixi 事件管线不触发，指针交互以 canvas 原生 DOM 事件为准（src/l2d/gestures.js）；升级 pixi 依赖想迁回 pixi 事件时先重跑本探针。

## 加新测试

新建 `scripts/tests/unit/test_<名字>.mjs`（合成配置、离线可跑）或 `scripts/tests/asset/test_<名字>.mjs`（依赖真实模型资产，缺资产时跳过而非失败），头部注释写清场景，用 helpers 复用：

```js
import { suite } from "../helpers/suite.mjs";
import { machinesById, machineById } from "../helpers/machines.mjs";
import {
  stubLocalStorage,
  makeCoreModel,
  makeModel,
} from "../helpers/fakes.mjs";

stubLocalStorage();
const { check, eq, near, section, finish } = suite("<名字>");
section("分组标题"); // 可选
const { 1: m1, 6: m1L } = machinesById(orch); // 按条目 id 取，禁用位置解构
check("行为断言", 实际 === 期望, "失败时的补充读数");
near("浮点断言", 实际, 期望, 1e-6); // 失败自动带两值
eq("结构断言", 实际数组或对象, 期望); // 深比较，失败自动带实际 vs 期望
finish(); // 打印汇总（含失败名单）与 SUMMARY 行，按失败数设退出码
```

约定：

- 一支文件只挂一个 `suite()`（finish 会 process.exit），文件内分主题用 `section()`。
- 不引入测试框架，不写无头浏览器测试——浏览器侧的诊断走 HUD 读数（见 src/utils/interaction/hints.js 的 createInteractionHints），node 只测纯逻辑。
- 依赖真实资产的测试放 asset/ 且缺资产时跳过；依赖 Cubism Core 全局的（test_interaction）import 前先 `loadCubismCore()`。
- 机器步进用假时钟（自己累加 `1/60` 逐帧调 `step`），不 sleep 真实时间。
- **机器一律按条目 id 取**（machinesById/machineById）：orch.machines 的顺序 = entries 数组顺序而非 id 序，entries 中部插条目后位置解构会整体错位（trigger_types 段曾因此 6 项假失败）。
- 文件操作/提取/转换类工具写 Python 进 scripts/，不进本目录（设计边界见上文）。
