# 已知根因对照（现象 → 机制）

## 提取 / 解析类

- bundle 解析出 undefined → 小文件走 8KB Buffer 池，Buffer 的 `.buffer` 带池内偏移；loadBundle() 已包 Uint8Array 拷出精确 ArrayBuffer（scripts/extract/bundle.js `loadBundle()`）。
- .skel/.atlas 解析出坏二进制 → TextAsset 走了 typetree m_Script（UTF-8 解码毁二进制段），必须经 `info.object.data` 取原始字节（spineBake.js）。

## 输出「趴平」/ 全 0 类

- 物理输出全趴 → physics3.json 缺 Normalization：烘焙注入在 scripts/extract/physics.js `injectPhysicsNormalization()`。注意区分：合法 0 = 输入被 key 成 0，不是 bug。
- 动作「不全」、引导环不亮 → 曲线目标混排（内核求值遇类型切换即停），extract 双层修复：scripts/extract/motion.js `convertClip()` + 运行时侧 src/l2d/motionPatches.js `normalizeCurveTargetOrder()`；同类现象先排除混排。

## 姿态类

- 双小臂等夸张变形 → 越界曲线值是合法姿态，框架 setParameterValue* 钳位曾把它压回去（去钳位补丁见 runtime.md）。
- 张臂姿态滞留不回正 → 视线松手回正的游戏语义（gestures.js `resetGaze()`），非 bug。
- 开关分支吸附 → Core 开关参数一次写入永久切换关键形态分支，复位不解吸；排查此类先重建基线。

## 取景类

- 皮肤加载偏小/裁切/位置错（老皮肤尤甚）→ 两条已知根因：l2d.json 缺失连带 live2d_offset 丢失，取景退回 ROI 拟合（烘焙解耦见 extract.md）；或主页容器位移层缺失（mellow 主题二级位移，见 runtime.md 取景链）。窗口露出画布矩形边界 → 全局 fill 缩放（游戏语义 fill=1）或按高适配宽窗口越出画布；按宽适配 + fill=1 下任意宽高比不露边。
- 半身像老皮肤（mingshi 等）站位异常 → 容器 y 走半身公式且随视口宽高比变，不是常量位移（runtime.md 取景链）。

## 交互 / 触点类

- 触点全灭 → 两条已知根因：canPlay 前置是 moc 默认不可满足的姿态顺带值；或节点因 motionStart 竞态滞留默认值（补账点 mount.js `mountModelInner()` 末尾）。
- 「框无点」→ 分区路由缓存键须含姿态维度（interaction/hints.js `resolveRoute()`）。
- 巨大判定框（数千像素）→ 背景板网格分区本体，非 bug（interaction/hitTest.js `meshHitTest()` 对整块网格照常命中，如 wuzang_3 touch_drag4）。
- 交互配置条目序号与分区名错位 → 条目号 ≠ 分区命名号，逐条核对（配置源 scripts/extract/lua.js `parseShipL2d()`）。
- 摆位机同支动作重播被引擎拒绝 → 次序须先切变体后播（actions.js `playMotion()`）。
- 摸头/摸身起播回不到正面 → 表外补账只跳过 applyEnd 真正落账的表项，carryPids 类参数须照写不照表（interaction/runtime.js `applyEnd()` 内 seq 守卫段）。

## Ani / spine 类

- 同名 atlas 二次 add 抛 "already exists" → pixi-spine ESM import 已自动注册 Loader 插件，手动再挂即重复（spineMount.js `mountSpineModel()`）。
- spine 皮肤取景错位/翻转 → spine.json 画布头是导出估算值，与真实网格存在 Y 镜像/偏移，不可作取景依据；须走 fitSpine() 渲染包围盒（src/l2d/spineMount.js）。
- spine 皮肤身体不可见 → 骨架多套皮肤且 initialSkin 为空，人物部件普遍不在 default 皮肤，挂载层须回落 skins[1]（spineMount.js `applySkin()`）。
- 3.8 JSON 读取器整体抛错而游戏正常 → 美术迭代旧附件名悬挂引用：setup 名与动画引用经同槽位最长公共前缀修补、仍落空的 deform 条目丢弃（spineSkel.js `repairName()`；游戏读取器静默跳过，pixi-spine 严格解析不跳）。
- 会话中途页面报 deps 文件不存在 → @pixi-spine/all-3.8 是 CJS 且 import 有模块级副作用，冷发现式预构建中途重跑使旧 ？v= 哈希失效；optimizeDeps.include 随启动预构建规避（vite.config.js）。
