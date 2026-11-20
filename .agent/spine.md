# Ani（spine）皮肤兼容

游戏另有一类动态皮肤（ani 类）不是 Cubism 而是 spine 骨架动画。本文件覆盖其资源形态、解析语法、烘焙产物与浏览器挂载链。L2D 管线约定见 extract.md，目录判据见 extract.md 皮肤目录节。

## 资源对与判据

- 设备侧类别目录 `files/AssetBundles/spinepainting/`：主 bundle `spinepainting/<painting>` 只含 SkeletonGraphic UI 预制体（几 KB 壳），骨架/图集/贴图在伴生 `<painting>_res` bundle（SkeletonDataAsset / SpineAtlasAsset / .skel / .atlas / Texture2D）。
- 判据：主 bundle 的 MonoScript 表含 `SkeletonGraphic` 即 spine 皮肤（spineBake.js `isSpineBundle()`）。
- 拉取：pull_bundles.js `readSpineIndex()` 解析 hashes.csv（全类别总索引）的 spinepainting/ 条目，按名拉取连带 `_res`；`syncIndex()` 已前移到拉取之前，首个 ani 皮肤拉取前需先跑过一次 `--index`。

## .skel 二进制语法（spineSkel.js `parseSkel()`）

- spine 3.8 系二进制，语法权威是游戏 HybridCLR 程序集 spine-unity.dll 的 SkeletonBinary.ReadSkeletonData。
- 与官方 3.8 语法的最大分歧：nonessential 标志为真时头尾各多读一个调试占位 int（游戏读取路径 Debug.Log 消费的字段）。
- strings 表：槽位/皮肤/事件/附件名 1 基引用、0=null，骨骼名内联；结构依次为 bones/slots/ik/transform/path 约束 → skins（default skin 特殊编码：count==0 即无 default）→ events → animations。
- 读取器带 guard 包装，抛错带偏移 + 十六进制上下文。

## 转换方言（spineSkel.js `toSpine38Json()`）

- 落笔方言是 pixi-spine 3.8 读取器，非官方 spine JSON：skins 数组形态 `[{name, attachments:{槽:{附件}}}]`；events/ik/transform/path 时间轴按名键控映射；曲线是 curve/c2/c3/c4 四独立键；clipping 的 `end` 键取槽名非序号；加权顶点 `weightedFlat()` 平铺成 `[count, boneIdx, x, y, weight, ...]` 单数组（运行时靠 vertices.length≠uvs.length 判加权，不读独立 bones 字段）。
- 附件类型 0..6 全覆盖（region/boundingbox/mesh/linkedmesh/path/point/clipping）。
- 旧名修补 `repairName()`：美术迭代改附件名后，槽位 setup 名与动画 attachment/deform 时间轴引用的旧名解析落空，按同槽位附件名集合做最长公共前缀修补（单候选直接采用，多候选须有公共前缀）；修补后仍落空的 deform 条目丢弃——游戏读取器静默跳过，pixi-spine 3.8 JSON 读取器严格解析会整体抛错。

## 烘焙（spineBake.js `bakeSpine()`）

- 变体表 = res 内全部 SkeletonDataAsset。预制体两种路由：分层 `resolveComposition()`（根 GameObject 的 RectTransform 子层级按序挂多个 SkeletonGraphic，共享坐标系，返回有序分区表）与单骨架 `resolveDefaultVariant()`（prefabItem[0] → SkeletonGraphic → skeletonDataAsset）。
- 产物（models/<角色>/<皮肤>/，与 L2D 皮肤同目录约定）：
  - `<皮肤>.spine.json` 元数据：`{type:"spine", painting, name, default, variants:[{variant, skeleton, atlas, raw, canvas, startingAnimation, startingLoop, initialSkin, default}], parts?}`（分层预制体才有 parts 有序分区名数组）；
  - 每变体：`<变体>.json`（spine 3.8 JSON）+ `<变体>.skel`（原始字节归档）+ `.atlas` + 贴图 PNG（按 atlas 页原始名落盘）。
- 贴图行序统一 top-down：ASTC 与 exportFile 两路径翻转口径一致（texture.js `decodeAstcTexture()` flip 默认 true；flip=false 保留 Unity 自底向上原始行序）。pixi-spine 无 spine-unity 的内部 UV 转换，必须给标准 top-down PNG。
- 坑：.skel/.atlas 的 TextAsset 必须经 `info.object.data` 取原始字节；typetree 的 m_Script 经 UTF-8 解码已毁二进制段。
- 入口：extract.js `main()` spine 分支——isSpineBundle 命中则要求 BUNDLE_DIR 下存在 `<modelId>_res`（缺失即报错），显示名经 lua.js `readTemplateByPainting()` 取自 ship_skin_template.lua，`bakeSpine()` 后直接 return，不走 L2D 管线。
- 烘焙进度走 `[progress] <pct> <label>` stdout 协议（dev server 解析成进度条）。

## 挂载（src/l2d/spineMount.js）

- 分流点 mount.js `mountModel()`：url 以 `.spine.json` 结尾即动态 import spineMount 走独立挂载链。
- `mountSpineModel()`：pixi Loader + @pixi-spine/all-3.8 加载变体 JSON；解析 scale 固定 0.01（`SKELETON_SCALE`，游戏 SkeletonDataAsset 语义）。Loader 插件由 ESM import 自动注册，不得手动重复挂（否则同名 atlas 二次 add 抛 "already exists"）。
- 皮肤激活 `applySkin()`：spine-unity initialSkinName 语义；空值且骨架有多套皮肤时回落 skins[1]——人物部件普遍不在 default 皮肤（如 aluomangshi 的 '1' 常规 / '2' 誓约两套着装，不回落则身体不可见），激活后 `setSlotsToSetupPose()`。
- 分层预制体（meta.parts > 1）：按序把全部分区同时挂进一个 Container，各分区 SkeletonGraphic 独立 state、各按自身 startingAnimation 起播；单骨架挂 default/指定变体（`startPart()`，缺省 'normal' 循环，查不到退回首个动画）。
- 取景 `fitSpine()`：按真实渲染包围盒——spine.json 画布头是导出估算值，与真实网格存在 Y 镜像/偏移，不可作取景依据；取景推迟一帧（pixi-spine mesh 顶点缓冲首次 update 前是全零）。
- 交互全旁路：ctx.runtime / ctx.orch / ctx.l2dOffset 保持 null（无交互状态机、无参数机、无取景 offset）；gestures 的 followGaze/resetGaze 走可选链旁路，onPointerUp 命中段对无 internalModel 直接 return；HUD 差分采样仅挂 Live2D internalModel，spine 整段跳过。
- 宿主钩子：`ctx._spineFit`（camera.js `fitModel()` 的 spine 分支转发）与 `ctx._spinePlay`（L2dStage.vue `play(group)` 的 spine 分支，变体切换）。上报触发组：单骨架 = 变体名列表，分层 = 空数组（重挂即复位）。
- 揭幕语义：加载完成即上台（无 L2D 入场硬切）。
- vite.config.js `optimizeDeps.include: ["@pixi-spine/all-3.8"]`：该包 CJS 且 import 有模块级副作用（自动注册 Loader 插件），冷发现式预构建会在会话中途重跑使旧 ？v= 哈希失效。

## 目录与 dev 伺服

- gen_catalog.js `parseSpinePaintings()`：解析 hashes.csv 的 spinepainting/ 行，剔除 `_res`/`_asmr`（依赖与伴生 bundle），_hx 在 buildCatalog 层剔除；`buildCatalog()` 接 spinePaintings 名单——名单内条目落 `ani: true`、仅 spine 存在落 `l2d: false`、两栖皮肤单条目双形态。
- 撞名语义：同 name|ship_group 合并为单条目（动态皮肤在游戏数据里是两条独立模板 + 两个 bundle，如 jianwu_2/3），被并入的 painting 落 `altPaintings` 数组供形态开关；基底取文件序首条（live2d 名单先遍历，有 l2d 形态时基底必为 l2d bundle）。
- dev/models.js `scanModels()` 双形态识别：`<皮肤>.spine.json` 在位即收录（条目 `type: 'spine'`）；dev/api.js `bundleRemoteSize(painting, ani)` 进度盯 hashes.csv 的 `spinepainting/<painting>_res`（主 bundle 只有几 KB），`startJob()` 按 catalog 条目 ani 标记选 bundle 路径。

## 测试

- scripts/tests/unit/test_spine_skel.mjs：三条合成 .skel 字节流逐字段复刻游戏 SkeletonBinary 语法——基本流（strings 表/骨骼/槽位/default skin region/attachment+rotate 时间轴/bezier 曲线）、加权 mesh + clipping 回归（weightedFlat 序号错位曾读越界）、deform 悬挂引用修补/丢弃两分支。
