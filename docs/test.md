# 测试脚本说明

node 直跑的冒烟/体检测试，无测试框架依赖。入口 `npm test`（等价
`node scripts/tests/run_all.mjs`），**在仓库根目录跑**（测试按相对路径读
`models/`、`public/libs/`）。退出码 0 = 全过 / 1 = 有失败。

```
node scripts/tests/run_all.mjs [名字子串...] [--fail-fast|-f]
```

- 子串过滤：`npm test -- dragmachine` 只跑文件名含 `dragmachine` 的。
- `--fail-fast`：首个失败文件后停止，剩余不跑。
- 汇总带每文件通过/失败计数（解析各测试末尾的 `SUMMARY pass=N fail=M`
  行）与耗时；断言失败行同行带实际值/期望值（`eq`/`near` 自动带上），
  汇总里还有失败项名单，不用往上翻。

```
scripts/tests/
├── run_all.mjs           # 入口：串行跑全部 test_*.mjs，子串过滤 + --fail-fast
├── test_dragmachine.mjs  # 拖拽参数机状态机（纯逻辑，无资产依赖）
├── test_trigger_types.mjs# 触发类型 1/5/12（纯逻辑，合成条目）
├── test_interaction.mjs  # 交互有向图状态机（需 public/libs 的 Cubism Core）
├── test_ladder_loop.mjs  # shengluyisi_5 梯子两圈链路回归（真实 l2d.json + 真机器）
├── test_listener.mjs     # 联动层 listener_data（纯逻辑，合成条目）
├── test_ambient.mjs      # effect 组曲线采样（纯逻辑，fetch 打桩）
├── probe/                # 一次性探针 CLI（不进 run_all，见下文）
└── helpers/
    ├── suite.mjs         # check/eq/near/section 断言套件（ok/FAIL 行 + 失败诊断 + 退出码）
    ├── machines.mjs      # machineById/machinesById：按条目 id 取机器（禁用位置解构）
    ├── fakes.mjs         # 假 coreModel / 假 pixi 模型工厂 / stubLocalStorage
    ├── cubism.mjs        # node 下加载 Cubism Core + moc3 模型
    ├── model_files.mjs   # 皮肤目录解析 / JSON 读取（model_probe.mjs 转出口）
    ├── motion3.mjs       # motion3 曲线采样 + interaction clip 取值
    ├── sim.mjs           # 全管线仿真 harness（真实 runtime/orchestrator/actions）
    └── geometry.mjs      # drawable 顶点快照 / 包围盒 / 位移排名
```

单独跑某一支：`node scripts/tests/test_dragmachine.mjs`。

**脚本层设计边界**（定案）：前端交互与注入 = JS 脚本（src/ +
scripts/tests/\*.mjs），本地文件操作与处理 = py 脚本（extract.py /
extract.py）。例外：probe/ 直读 moc3 的脚本必须是
JS——moc3 解析依赖 Cubism Core 的 wasm，Python 无等价能力；边界划在
格式解析器归属上（moc3 是前端资产格式，不是普通本地文件）。

## 各脚本的使用场景

### test_dragmachine.mjs — 拖拽参数机

**场景**：改 [src/utils/dragmachine/](../src/utils/dragmachine/)（machine.js
/ orchestrator.js / triggers.js）后回归。
覆盖 type 1（按压邻域累计）/ 2（常规点击，含 down 配置）/ 3（长按播表 +
slot11 回绕松开）/ 6（连点列表）/ 8（充能档位）/ 9（点参触发）/
12（扩展动作规则过滤门；不主动触发，故 interactable 仍为 null）、relation 101（跟随拖动量）/
103（开关下标对齐）、冷却塌缩（含 idle 起播）、interactable 红绿判定、
ableFlag 开窗监听、pressLock 门控矩阵（谁按下上锁/谁不上锁/锁不影响
onMove/幂等 + reason 留痕）、additive 两阶段还原、localStorage 持久化、
同值 changeIdleIndex 不复位、resetAll 契约一揽子（平滑状态/下标/冷却/
extendActionFlag 跨域残留全归位）。这些是逆向自游戏 ship_l2d 的控制层
语义（见 [azurlane.md](azurlane.md)），改动若让行为偏离游戏实况会在这里红。

### test_trigger_types.mjs — 触发类型 1/5/12

**场景**：改 triggers.js 的 TRIGGER_HANDLERS 或 machine.js 的
checkActionInExtend / readDragParameter 后回归。合成 ship_l2d 条目覆盖：
type 1 按压 num 邻域（±|num|·0.25）累计计时、触发后不清零、单 action 触发
即松开（slot11）、action_list 连发到回绕、离开邻域不累计、播放中抑制；
type 5 idle 常量跟随（const_fit 变体匹配贴 target、无按压要求、播放中不
贴）；type 12 扩展门（handler 只置 extendActionFlag、区间左开右闭、ignore
拦截、enable 直通越按压锁、'idle' 恒放行、resetAll 清位）；另直测
readDragParameter 的按名读取/末台胜出/缺省 0。语义依据见
[azurlane.md](azurlane.md) 第 3 节。

### test_ladder_loop.mjs — shengluyisi_5 梯子环回

**场景**：改触发路由（gestures.js 的 machineZonesAt / orchestrator 的
zoneOrder）或 t6 连点推进后回归。用真实 l2d.json + 真机器代码驱动两圈点击
链（drag1 → drag3:4 → … → drag13:19 → 环回），断言每击都播出动作、第二圈
起点不断链。注意 onUp 的点击确认窗用真实钟，测试里的假钟须与
performance.now 对齐。

### test_listener.mjs — 联动层 listener_data

**场景**：改 machine.js 的 onListenerEvent / orchestrator 的 notice 总线与
applyActiveData 后回归。合成 ship_l2d 条目覆盖：kind 1 相对增量 / kind 2
绝对赋值、range 钳制、联动命中复位连点下标、apply 区间换挡 +
idle_enable/idle_ignore 按变体取名单、type 3 变体号匹配、同值
changeIdleIndex 也广播（CT:1206-1224）、PLAY 通知经 onActionApply 发射、
真实点击链路的 PLAY 发射。DRAG_CLICK(2) 在原文是死路径（EVENT_ACTION_APPLY
成功回调实参恒 nil，CT:269/305），专门断言 notice(2) 不再产生任何副作用。
语义依据见 [azurlane.md](azurlane.md) 第 3 节"联动层"。

### test_interaction.mjs — 交互状态机

**场景**：改 [src/utils/interaction/](../src/utils/interaction/)（runtime.js
/ hitTest.js / hints.js）后回归。
fixture 复刻"touch_idle1 摊开菜单 → touch_idle2 分支（前置 caidan=1）→
touch_idle3 收尾带回 0"这条游戏内实况链路，覆盖：statePids/carryPids/
gatedPids 派生、节点跟踪（pending 结算、被顶掉先行结算、idle 起播立即落
账）、canPlay 门控（查节点不查实时参数）、firstVisibleHit 手势路由与透明
度过滤、resetParameters/resetState、playHitMotion 精确命中与组内选支。
需要 Cubism Core 在位（仅 import），缺文件时整支跳过。

### test_ambient.mjs — effect 氛围层曲线采样

**场景**：改 [src/utils/ambient.js](../src/utils/ambient.js) 后回归。fetch
打桩喂 fixture motion3，覆盖四种段类型（线性/贝塞尔/阶跃/反阶跃）、超程
钳制到参数范围（shengluyisi_5 Param90/92 达 14.7 的实况）、时长取模循
环、缺失参数跳过绑定。曲线只经 loadAmbient+apply 驱动，不直接测内部函数。

### test_models.mjs — 模型资产体检

**场景**：提取管线产出新的皮肤目录（models/<角色>/<皮肤>/）后验资产完整
性。逐套皮肤检查：HitAreas 全部可解析到 drawable、defaults.json 覆盖全
部 moc 参数、interaction.json / l2d.json 在位；并打印默认姿态下命中区网
格包围盒（isHit 的实际判定范围），供人工对照游戏内触发位置。合并了昔日
的 .tmp/probe_deformed / probe_hitmesh 一次性探针。

**模型不入库**：本机 models/ 为空或缺 Cubism Core 时整支自动跳过（exit
0），新克隆的仓库跑 `npm test` 不会被资产依赖卡住。

## 一次性探针（scripts/tests/probe/）

不进 `run_all.mjs` 的诊断 CLI，`node scripts/tests/probe/<脚本>.mjs` 手动跑。
（moc3 直读类必须在 JS 侧做——moc3 解析依赖 Cubism Core wasm，见上文设计边界。）

### 配置/资产速查类

- `entries.mjs <皮肤目录>` — 打印 l2d.json 的动作条目摘要。
- `interaction.mjs <皮肤目录>` — 打印 interaction.json 的 clip 状态与门控参数摘要。
- `model_probe.mjs` — 无 CLI，probe 系的公共转出口（helpers/model_files.mjs）。
- `drawable_textures.mjs <皮肤目录>` — 各 drawable 的 textureIndex 分布、
  part/drawable 计数。
- `drawable_uvs.mjs <皮肤目录>` — 按 textureIndex 汇总 drawable 的 UV 范围。
- `part_opacities.mjs <皮肤目录>` — 初始 part opacity 分布及由此推算的
  drawable 可见性。
- `hit_opacity.mjs <皮肤目录>` — HitAreas 对应 drawable 的初始透明度与渲染顺序。

### 排查类

#### moc3_params.mjs — moc3 参数表与 l2d.json 交叉核对

```
node scripts/tests/probe/moc3_params.mjs <皮肤目录|moc3> [--param 子串] [--check] [--all]
```

用 Cubism Core 直读 moc3：默认打印 min/max/default 不全等的参数（`--all`
全打印，`--param` 按子串过滤），并给出 canvasinfo。`--check` 与同目录
l2d.json 逐机器核对三件事：机器参数是否存在于模型（不存在则只记账不写
值）、machine.range 是否超出模型参数区间（越界段被 Cubism 钳掉）、
type 4 的 action_trigger.num 是否落在 machine.range 的 ±25% 邻域内（不
在则该触发恒不可达——wuzang_3 的 TouchDrag11/12 即此类，num [10,20] 对
range [-1,1] 数学上永不成立，游戏端同款公式同款死法）。

排查"按档位/按位置的事件不出现"先跑这个：配置侧不可达的，移植端无病
可修；可达的再去查运行时。

#### hit_areas.mjs — HitAreas 解析与机器分区核对

```
node scripts/tests/probe/hit_areas.mjs <皮肤目录>
```

直读 moc3 + model3.json，还原查看器的 HitAreas 解析（Name -> drawable
下标）：打印各命中区的网格包围盒（画布 px；"画布"为 moc3 画布空间，
wuzang_3 画布 8000×8000，背景板级判定区数值天然巨大），并与 l2d.json 的
draw_able_name 按运行时同规则归一化核对——标出"HitAreas 无同名分区、
机器路由不会命中"与"触摸系分区却无机器接管"两类错位。屏幕 px / 占视口
高比例依赖实时取景，静态探针不可复算，只出画布 px。

#### simulate.mjs — 交互管线场景重放

```
node scripts/tests/probe/simulate.mjs <皮肤目录> \
  --scene "wait:0.5 click:TouchIdle1 wait:4.5 click:TouchIdle4 wait:13" \
  [--tap] [--param Pid,...] [--game "touch_idle4 idle4@0"]
```

用真实 InteractionRuntime + DragOrchestrator + createActions 代码 + 真实
moc3/motion3 资产，在 node 里按 60fps 重放 viewer 的帧循环
（restoreLayer -> motion 曲线 -> applyLayer），装配顺序与 mount.js 对齐。
排查"点了没反应 / 播错动作 / 特殊待机扭曲 / 复位不干净"这类运行时问题
先跑这个。

- `--scene` 步骤：`wait:<sec>` 播放、`click:<zone>[:hold]` 点区域
  （hold 默认 0.15）、`reset` 调 ctx.actions.resetInteraction()。
- `--tap` 打印 orchestrator 的 [tap] 调试行；`--param` 末尾追加打印参数值。
- `--game "<clip> <motion>[@<t>]"` 与游戏应然态逐参数对比：应然态 =
  clip 的 state/carry 节点尾值 + 变体 motion 曲线@t；clip/motion 未覆盖
  的参数以 moc3 默认值为应然态，机器把开关写偏（如默认 1 被写成 0）也
  能暴露。

例（fulici_2 复位场景）：`--scene "wait:0.5 click:TouchIdle1 wait:4.5
click:TouchIdle4 wait:11 reset wait:0.5"`——复位全绿的判据是 pending=idle、
idleIndex=0、白名单=0、isNeutral=true、节点无残留。

#### pose_diff.mjs — 参数姿态几何对比

```
node scripts/tests/probe/pose_diff.mjs <皮肤目录> \
  --pose "S_GAME: clip=touch_idle4 motion=idle4@0" \
  --pose "H1: clip=touch_idle4 motion=idle@0" \
  --pose "H3: clip=touch_idle4 carry=0 motion=idle4@0" \
  [--diff 1,2]
```

按「节点尾值 + motion 曲线@t + 手工覆盖」构造若干候选参数态，对真实
moc3 逐个 update，打印各姿态的网格包围盒（全部/可见两行），以及各姿态
vs 第一个姿态（基准）的按 drawable 顶点最大位移排名——定位"扭曲/错位"
来自哪个参数态假设。

姿态 spec：`clip=<name>` 节点尾值（state+carry 的 end）；`carry=0` /
`state=0` 掐掉对应来源；`start=<name>` 改用另一 clip 的衔接首值；
`motion=<name>[@<t>]` 叠加曲线采样（t 默认 0，`@end` = 末帧-1/30）；
`set=Pid=v,...` 手工覆盖。`--diff` 指定参与对比的姿态序号（0 起），
默认全部非基准姿态。

#### pixi_events.mjs — pixi 事件管线探针（归档）

```
node scripts/tests/probe/pixi_events.mjs   # 打印浏览器控制台探针代码
```

无副作用，只是把昔日 L2dStage 内的 pixi 事件探针归档：`npm run dev` 后把
打印的代码粘进浏览器控制台执行。历史结论（pixi v6 + pixi-live2d-display
组合）是 pixi 事件管线不触发，指针交互以 canvas 原生 DOM 事件为准（
src/l2d/gestures.js）；升级 pixi 依赖想迁回 pixi 事件时先重跑本探针。

## 加新测试

新建 `scripts/tests/test_<名字>.mjs`，头部注释写清场景，用 helpers 复用：

```js
import { suite } from "./helpers/suite.mjs";
import { machinesById, machineById } from "./helpers/machines.mjs";
import {
  stubLocalStorage,
  makeCoreModel,
  makeModel,
} from "./helpers/fakes.mjs";

stubLocalStorage();
const { check, eq, near, finish } = suite("<名字>");
const { 1: m1, 6: m1L } = machinesById(orch); // 按条目 id 取，禁用位置解构
check("行为断言", 实际 === 期望, "失败时的补充读数");
near("浮点断言", 实际, 期望, 1e-6); // 失败自动带两值
eq("结构断言", 实际数组或对象, 期望); // 深比较，失败自动带实际 vs 期望
finish(); // 打印汇总（含失败名单）与 SUMMARY 行，按失败数设退出码
```

约定：

- 不引入测试框架，不写无头浏览器测试——浏览器侧的诊断走 HUD 读数（见
  src/utils/interaction/hints.js 的 createInteractionHints），node 只测纯逻辑。
- 依赖真实资产的测试（test_models）必须在缺资产时跳过而不是失败；
  依赖 Cubism Core 全局的（test_interaction）import 前先
  `loadCubismCore()`。
- 机器步进用假时钟（自己累加 `1/60` 逐帧调 `step`），不 sleep 真实时间。
- **机器一律按条目 id 取**（machinesById/machineById）：orch.machines 的
  顺序 = entries 数组顺序而非 id 序，entries 中部插条目后位置解构会整体
  错位（test_trigger_types 曾因此 6 项假失败）。
- 文件操作/提取/转换类工具写 Python 进 scripts/，不进本目录（设计边界见上文）。
