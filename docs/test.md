# 测试脚本说明

node 直跑的冒烟/体检测试，无测试框架依赖。入口 `npm test`（等价
`node scripts/tests/run_all.mjs`），**在仓库根目录跑**（测试按相对路径读
`models/`、`public/libs/`）。退出码 0 = 全过 / 1 = 有失败，`run_all.mjs`
按退出码汇总。

```
scripts/tests/
├── run_all.mjs           # 入口：串行跑全部 test_*.mjs，可传名字子串过滤
├── test_dragmachine.mjs  # 拖拽参数机状态机（纯逻辑，无资产依赖）
├── test_interaction.mjs  # 交互有向图状态机（需 public/libs 的 Cubism Core）
├── test_ambient.mjs      # effect 组曲线采样（纯逻辑，fetch 打桩）
├── probe/                # 一次性探针 CLI（不进 run_all，见下文）
│   ├── moc3_params.mjs   # moc3 参数表 dump + l2d.json 交叉核对
│   ├── hit_areas.mjs     # HitAreas 解析 + 机器分区归一化核对
│   └── pixi_events.mjs   # pixi 事件管线探针归档（打印浏览器探针代码）
└── helpers/
    ├── suite.mjs         # check/finish 断言套件（ok/FAIL 行 + 退出码）
    ├── fakes.mjs         # 假 coreModel / 假 pixi 模型工厂
    └── cubism.mjs        # node 下加载 Cubism Core + moc3 模型
```

单独跑某一支：`node scripts/tests/test_dragmachine.mjs`，或过滤：
`npm test -- dragmachine`。

## 各脚本的使用场景

### test_dragmachine.mjs — 拖拽参数机

**场景**：改 [src/utils/dragmachine/](../src/utils/dragmachine/)（machine.js
/ orchestrator.js / triggers.js）后回归。
覆盖 type 2（常规点击）/ 3（长按播表）/ 6（连点列表）/ 8（充能档位）/
9（点参触发）/ 12（未实现）、relation 101（跟随拖动量）/ 103（开关下标
对齐）、冷却塌缩、interactable 红绿判定、ableFlag 开窗监听、additive 两阶
段还原、localStorage 持久化。这些是逆向自游戏 ship_l2d 的控制层语义
（见 [azurlane.md](azurlane.md)），改动若让行为偏离游戏实况会在这里红。

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

### moc3_params.mjs — moc3 参数表与 l2d.json 交叉核对

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

### hit_areas.mjs — HitAreas 解析与机器分区核对

```
node scripts/tests/probe/hit_areas.mjs <皮肤目录>
```

直读 moc3 + model3.json，还原查看器的 HitAreas 解析（Name -> drawable
下标）：打印各命中区的网格包围盒（画布 px；"画布"为 moc3 画布空间，
wuzang_3 画布 8000×8000，背景板级判定区数值天然巨大），并与 l2d.json 的
draw_able_name 按运行时同规则归一化核对——标出"HitAreas 无同名分区、
机器路由不会命中"与"触摸系分区却无机器接管"两类错位。屏幕 px / 占视口
高比例依赖实时取景，静态探针不可复算，只出画布 px。

### pixi_events.mjs — pixi 事件管线探针（归档）

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
import { makeCoreModel, makeModel } from "./helpers/fakes.mjs";

const { check, finish } = suite("<名字>");
check("行为断言", 实际 === 期望);
finish(); // 打印汇总并按失败数设退出码
```

约定：

- 不引入测试框架，不写无头浏览器测试——浏览器侧的诊断走 HUD 读数（见
  src/utils/interaction/hints.js 的 createInteractionHints），node 只测纯逻辑。
- 依赖真实资产的测试（test_models）必须在缺资产时跳过而不是失败；
  依赖 Cubism Core 全局的（test_interaction）import 前先
  `loadCubismCore()`。
- 机器步进用假时钟（自己累加 `1/60` 逐帧调 `step`），不 sleep 真实时间。
