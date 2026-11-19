# 提取管线

提取/烘焙链路为纯 Node 工具链：`extract.js` + `scripts/extract/`。用法与产物以 docs/unpack.md 为准，游戏资源格式原理见 docs/azurlane.md。

## 格式要点

- Unity bundle 解包、ASTC 纹理直解、typetree 解析均在 scripts/extract/（bundle.js、texture.js）；typetree 整数字段一律 BigInt（int64），比较时注意类型。
- moc3 v4 与 v5 同构解析；参数节表中节 51/52/53 = max/min/defaults，两代一致（moc3.js `moc3ParamTables()`）。
- bundle 内中文文本是 GBK 编码，读字符串时需转码。

## 烘焙注入与剔除（extract.js 行为约定）

- physics3.json 必须注入 Normalization 段：游戏运行时读 `_rig` 私有格式，缺 Normalization 则物理输出全部趴平（physics.js `injectPhysicsNormalization()`）。
- 根对象 MouthOpening 的曲线是口参数覆写，已迁移到参数组末位，不再作为独立动作曲线导出（motion.js `CRC_MOUTH` 相关分支）。
- 首末值均为 0 的开关曲线会被剔除——节点学不到回零边，因此 runtime 侧 interaction/runtime.js `applyEnd()` 有对应补账；修改剔除逻辑（motion.js `constantKeys()` / `boundarySwitchLike()`）必须与该补账联动。
- 未解析的哈希路径 = 跨版本死绑定，对查看器无影响，可离线撞库定案（bundle.js `resolveHashBindings()`，inventory.json）。

## l2d.json 烘焙（extract/lua.js `bakeL2d()`）

- `live2d_offset` 与机器条目解耦：`ship_l2d_id` 为空的老皮肤照常落 l2d.json（entries 为空数组）——游戏端对无 offset 皮肤按 Live2DPainting 默认语义取景（根缩放 52 + 原点位移），缺 offset 查看器只能退回 ROI 拟合。
- ship_l2d 键 = skinId 直接连缀序号，序号宽度不定（老皮肤 1 位如 4990521、新皮肤 2 位补零如 81801101）——按模板 `ship_l2d_id` 的精确 id 直查，不做宽度启发式（lua.js `parseShipL2d()`）。
- 模板有、快照缺的机器条目：warn 后按已有条目降级烘焙，缺键过滤不落 null 条目。
- `mainui_shift` 烘焙自 sharecfg/ship_skin_newmainui_shift.lua（主页 mellow 主题 per-skin 容器位移表，皮肤未收录落 null）；`painting` 一并烘焙，供取景侧半身像名单匹配（lua.js `readMainuiShift()`）。

## 皮肤目录（gen_catalog.js / update.js）

- 一键更新：`npm run update`（scripts/update.js）串 `pull_lua.js --force` → `pull_bundles.js --index` → `gen_catalog.js`，末尾 diff 报版本变化与新增/移除皮肤；任一步失败即中止。代理取值优先级：`--proxy` 显式值 > `HTTPS_PROXY` 环境 > 本机端口探测（7890/7892/7897）。
- 判据：`painting ∈ hashes`，**大小写不敏感**（模板 painting 可含大写如 Z46_2；lua.js `readTemplateByPainting()`）。
- 阵营取 `ship_group`：扫 statistics 的 nationality 字段；模板 id 尾数不可靠（qiye_9 教训）。值域：1-9 / 11 郁金 / 96 风暴 / 97 META / 其余归其他（models.js `CAMP_LABELS`）。
- `{namecode:N}` 占位由 name_code.lua 代换。
- `_hx` 和谐变体整层剔除，查看器一律非和谐；目录提交时纯名字条目豁免审核。
- 索引/目录错位陷阱：UI 拉取（api.js `/api/extract` → pull_bundles）无条件顺带刷新设备索引但不刷目录——catalog 落后于 .tmp 索引不是 gen_catalog 的 bug，重跑 update.js 平账。目录同时是 UI 执行白名单（api.js `/api/extract` 校验 painting ∈ catalog），新皮肤必须先进目录才可在 UI 拉取。
- 「新增」语义 = 设备侧新出现的 L2D bundle：游戏内未触发下载的皮肤不进目录，属正常；ani 类动态皮肤（非交互）落别的资源类别、不进 live2d 索引，判据天然排除（例：新奥尔良 103122 深夜的亲密触诊）。
- scripts/dev/api.js 有接口白名单与单任务槽约束，新增接口先过白名单。
- Lua 快照（社区明文仓库）是 UTF-8；GBK 约束只适用于 bundle 内文本，搜索模板前先确认编码。

## 硬边界

- 落盘代码与正式文档不出现任何工具溯源话术（如「移植自 / ported from」），只写行为与格式约定本身。
- 探针与临时验证脚本不进仓库：必须以 resolveSkin 参数化、不写死默认皮肤表，验证完成后删除（见 testing.md）。
