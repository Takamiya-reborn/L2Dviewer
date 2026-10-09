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
└── helpers/
    ├── suite.mjs         # check/finish 断言套件（ok/FAIL 行 + 退出码）
    ├── fakes.mjs         # 假 coreModel / 假 pixi 模型工厂
    └── cubism.mjs        # node 下加载 Cubism Core + moc3 模型
```

单独跑某一支：`node scripts/tests/test_dragmachine.mjs`，或过滤：
`npm test -- dragmachine`。

## 各脚本的使用场景

### test_dragmachine.mjs — 拖拽参数机

**场景**：改 [src/utils/dragmachine.js](src/utils/dragmachine.js) 后回归。
覆盖 type 2（常规点击）/ 3（长按播表）/ 6（连点列表）/ 8（充能档位）/
9（点参触发）/ 12（未实现）、relation 101（跟随拖动量）/ 103（开关下标
对齐）、冷却塌缩、interactable 红绿判定、ableFlag 开窗监听、additive 两阶
段还原、localStorage 持久化。这些是逆向自游戏 ship_l2d 的控制层语义
（见 azurlane.md），改动若让行为偏离游戏实况会在这里红。

### test_interaction.mjs — 交互状态机

**场景**：改 [src/utils/interaction.js](src/utils/interaction.js) 后回归。
fixture 复刻"touch_idle1 摊开菜单 → touch_idle2 分支（前置 caidan=1）→
touch_idle3 收尾带回 0"这条游戏内实况链路，覆盖：statePids/carryPids/
gatedPids 派生、节点跟踪（pending 结算、被顶掉先行结算、idle 起播立即落
账）、canPlay 门控（查节点不查实时参数）、firstVisibleHit 手势路由与透明
度过滤、resetParameters/resetState、playHitMotion 精确命中与组内选支。
需要 Cubism Core 在位（仅 import），缺文件时整支跳过。

### test_ambient.mjs — effect 氛围层曲线采样

**场景**：改 [src/utils/ambient.js](src/utils/ambient.js) 后回归。fetch
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
  interaction.js 的 createInteractionHints），node 只测纯逻辑。
- 依赖真实资产的测试（test_models）必须在缺资产时跳过而不是失败；
  依赖 Cubism Core 全局的（test_interaction）import 前先
  `loadCubismCore()`。
- 机器步进用假时钟（自己累加 `1/60` 逐帧调 `step`），不 sleep 真实时间。
