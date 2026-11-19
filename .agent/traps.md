# 已知根因对照（现象 → 机制）

## 输出「趴平」/ 全 0 类

- 物理输出全趴 → physics3.json 缺 Normalization：烘焙注入在 scripts/extract/physics.js `injectPhysicsNormalization()`。注意区分：合法 0 = 输入被 key 成 0，不是 bug。
- 动作「不全」、引导环不亮 → 曲线目标混排（内核求值遇类型切换即停），extract 双层修复：scripts/extract/motion.js `convertClip()` + 运行时侧 src/l2d/motionPatches.js `normalizeCurveTargetOrder()`；同类现象先排除混排。

## 姿态类

- 双小臂等夸张变形 → 越界曲线值是合法姿态，框架 setParameterValue* 钳位曾把它压回去（去钳位补丁见 runtime.md）。
- 张臂姿态滞留不回正 → 视线松手回正的游戏语义（gestures.js `resetGaze()`），非 bug。
- 开关分支吸附 → Core 开关参数一次写入永久切换关键形态分支，复位不解吸；排查此类先重建基线。

## 交互 / 触点类

- 触点全灭 → 两条已知根因：canPlay 前置是 moc 默认不可满足的姿态顺带值；或节点因 motionStart 竞态滞留默认值（补账点 mount.js `mountModelInner()` 末尾）。
- 「框无点」→ 分区路由缓存键须含姿态维度（interaction/hints.js `resolveRoute()`）。
- 巨大判定框（数千像素）→ 背景板网格分区本体，非 bug（interaction/hitTest.js `meshHitTest()` 对整块网格照常命中，如 wuzang_3 touch_drag4）。
- 交互配置条目序号与分区名错位 → 条目号 ≠ 分区命名号，逐条核对（配置源 scripts/extract/lua.js `parseShipL2d()`）。
- 摆位机同支动作重播被引擎拒绝 → 次序须先切变体后播（actions.js `playMotion()`）。
- 摸头/摸身起播回不到正面 → 表外补账只跳过 applyEnd 真正落账的表项，carryPids 类参数须照写不照表（interaction/runtime.js `applyEnd()` 内 seq 守卫段）。
