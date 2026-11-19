# 架构与任务→文件映射

碧蓝航线 Live2D 皮肤查看器：从游戏客户端提取资源，重组为标准 Cubism 模型（moc3 v4/v5），在浏览器中还原动画与交互。技术栈 Vue 3 + Vite + PixiJS 6 + pixi-live2d-display，工具链纯 Node（见 extract.md）。

锚点格式为「文件 + 函数符号」，grep 函数名即达实现；改代码时同步更新本文锚点。

## 查看器运行时（src/l2d/）

| 逻辑 | 位置 |
|---|---|
| 挂载总入口、复位缓动登记、Breath 移除、trackMotionStart 补账 | mount.js `mountModel()` / `mountModelInner()` |
| 动作播放、动作变体切换、就地复位 | actions.js `createActions()` → `playMotion()` / `resetInteraction()` / `handleHitAreas()` |
| 拖拽视线跟随与手势分发 | gestures.js `createGestures()` → `followGaze()` / `resetGaze()` / `machineZonesAt()` |
| 相机取景与锚点 | camera.js `createCamera()` → `fitModel()` / `measureScene()` / `pickAnchorX()` |
| 誓约戒指（Paramring 逐帧写） | ring.js `RING_PARAM` / `createOathRing()` |
| 调色板 keyform 颜色动画 | palette.js `installPalette()`；渲染补丁 colorPatches.js `installColorPatch()` |
| effect 组常驻氛围层（贝塞尔曲线采样叠加） | src/utils/ambient.js `loadAmbient()` / `sampleCurve()` |
| 触点涟漪（游戏 ui/clickeffect 同构） | clickEffect.js `createClickEffect()` → `spawn()` / `updateParticle()` |
| 曲线目标序归一化（混排修复的运行时侧） | motionPatches.js `normalizeCurveTargetOrder()` / `installMotionPatches()` |
| 参数覆写层 | paramOverride.js `createParamOverride()` |
| HUD 数据侧 | hud.js `createTickerCallback()` → `motionDiffReadout()` / `overrideReadout()` / `paramListReadout()`；差分采样 motionDiff.js `diffMotion()` |

## 交互层（src/utils/）

| 逻辑 | 位置 |
|---|---|
| 拖拽参数机状态机（步进、死区吸附、平滑趋近） | dragmachine/machine.js `setParameterValue()` / `smoothDamp()` / `fixRange()` |
| 配置加载与机器参数图层（Override/Additive/Multiply） | dragmachine/orchestrator.js `loadL2dConfig()`、机器图层段（约 377 行起） |
| 触发处理器分发 | dragmachine/triggers.js `TRIGGER_HANDLERS` |
| 交互运行时（挂起动作结算、表外补账、平滑复位） | interaction/runtime.js `loadInteraction()` → `trackMotionStart()` / `applyEnd()` / `beginSmoothReset()` |
| 分区命中（网格三角形逐点判定、边界环提取） | interaction/hitTest.js `meshHitTest()` / `boundaryEdges()` / `boundaryLoops()` |
| 触点提示与判定引导环 | interaction/hints.js `createInteractionHints()` → `routeWinner()` / `resolveRoute()` / `drawJudgeRings()` |
| 模型枚举、皮肤目录、阵营/触发标签 | src/utils/models.js `MODELS` / `CATALOG` / `loadCatalog()` / `CAMP_LABELS` / `TRIGGER_LABELS` |

## 前端界面

- App.vue 总入口；components/L2dStage.vue 舞台；components/tabs/（SkinTab.vue 皮肤页、StateTab.vue 状态页）；components/debug/HudPanel.vue 调试面板。

## 提取与工具链（scripts/）

| 逻辑 | 位置 |
|---|---|
| 提取/烘焙主脚本 | extract.js（用法见 docs/unpack.md） |
| bundle 解包、哈希死绑定、层级构建 | scripts/extract/bundle.js `loadBundle()` / `resolveHashBindings()` / `buildHierarchy()` |
| lua 模板解析与烘焙 | scripts/extract/lua.js `bakeL2d()` / `readAllSkinTemplates()` / `parseShipL2d()` / `idleIndex()` |
| moc3 参数节表 | scripts/extract/moc3.js `moc3ParamTables()` |
| 动作转换（流式帧、常量段、边界状态、分组） | scripts/extract/motion.js `convertClip()` / `constantKeys()` / `denseKeys()` / `clipBoundaryState()` / `clipGroup()` |
| physics Normalization 注入 | scripts/extract/physics.js `injectPhysicsNormalization()` |
| ASTC 直解与 PNG 编码 | scripts/extract/texture.js `decodeAstcTexture()` / `encodePng()` |
| animator 路由与 fades 表 | scripts/extract/animator.js `animatorRouting()` / `animatorFades()` |
| 客户端拉取 | pull_bundles.js / pull_cs.js / pull_lua.js（原理见 docs/azurlane.md） |
| dev server 白名单与单任务槽 | scripts/dev/api.js、scripts/dev/models.js |

## 测试

- `npm test` → scripts/tests/run_all.mjs；unit/ 单测、probe/ 真引擎探针、helpers/ 公共件、asset/ 测试资产。编写要求见 testing.md。

## 资产边界

- 仓库零游戏资产：模型在根目录 models/（dev 中间件伺服，不在 public/）；public/ 下自绘资源（如 effects/click/click.png）属查看器自有资产；版权条款见 README。
- tools/ 内为随仓库分发的第三方工具（adb、Il2CppDumper），非本项目代码。
