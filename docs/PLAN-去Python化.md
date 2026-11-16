# 去 Python 化计划（分批执行）

> 目标：`scripts/` 5 个 Python 脚本全部移植 Node，删除 Python 依赖，单工具链。
> 本文件是跨批次进度的跟踪锚点，每批完成即勾选。整体方案经批准（2026-11-17）。

## 新增依赖（前置，共 3 个，待用户点头后 `npm install`）

| 包 | 用途 |
|---|---|
| `unityfs-js@^0.2.9` | bundle 解包、嵌入 typetree、6 强类型类、非 ASTC 纹理解码 |
| `texture2ddecoder-wasm` | ASTC 48-61 解码（unityfs-js 未路由该格式，自补分支） |
| `@alexaltea/capstone-js@^5.0.9` | ARM64 LE 反汇编（disasm.js） |

不引入：yauzl（手写 zip64 读取器）、PNG 编码库（手写 ~50 行）、备用 capstone `@kreijstal/capstone-wasm` 仅当首选不达标时替换。

## 批次划分

### 批次 1：pull_lua.js ✅（2026-11-17）
- [x] `scripts/pull_lua.js`（fetch 直连 + CONNECT 隧道代理兜底，零依赖）
- [x] 回归：8/8 文件与独立 curl 拉取 sha256 全等（现有快照是 10-19 的旧版，4 个大文件差异为上游更新所致，非移植问题；快照已恢复旧版以对齐批次 5 回归输入）

### 批次 2：pull_bundles.js ✅（无设备部分，2026-11-17）
- [x] adb 拉取移植（多设备收敛 / --list / --all / --index / 同尺寸续传 / >100MB readline 确认）
- [x] 无设备回归：无参数报错、未知参数报错、无设备时 adb 错误信息透出，退出码均为 1
- [ ] 遗留手动项：真机 --list / 多设备收敛 / 断点续传

### 批次 3：pull_cs.js ✅（2026-11-17）
- [x] adb pull APK splits → 手写 zip 中央目录读取器（含 zip64、按位读取不整包载入）取 libil2cpp.so + global-metadata.dat
- [x] Il2CppDumper 调用（config.json RequireAnyKey=false 临时改写 + finally 还原，已验证还原）
- [x] 回归：`--extract-only` 现有 base.apk，so/metadata sha256 与原文件全等，dump.cs 44MB 重新生成成功

### 批次 4：disasm.js（脚本已写，回归待装依赖）
- [x] capstone ARM64 窗口反汇编 / script.json 地址查询 / dump.cs live2dchar 方法表
- [ ] 回归：固定窗口 + addr + live2dchar 对比 disasm.py 输出
  - diff 政策：`(地址, mnemonic, 规整化 op_str)` 三元组全等（剥空白/前缀归一）；语义差异零容忍，措辞差异容忍

### 批次 5：extract.js（最大件）
- [ ] `scripts/extract/` 模块：bundle.js（unityfs-js 适配层）/ motion.js / animator.js / moc3.js / physics.js / lua.js / texture.js
- [ ] `scripts/extract.js` CLI 入口（落盘顺序保持：moc3 → defaults → textures/TextAsset → char → motions → model3 → interaction → fades → inventory → l2d）
- [ ] ASTC 分支：texture2ddecoder-wasm 解 48-61 格式，BGRA→RGBA + 垂直翻转 + 手写 PNG 编码
- [ ] 冒烟：env.objects 按类型计数 == 真值 inventory.json objects 表
- [ ] 新增 `scripts/tests/asset/test_extract_port.mjs`（缺 bundle 时 skip，SUMMARY 约定进 run_all）
- [ ] 回归：fulici_2 + zhenzhuhao_2 双 bundle 全量产物 diff（moc3 字节全等 / JSON 深比对浮点容差 1e-9 / PNG 像素级 / 零 warn）

### 批次 6：删除与文档清理
- [ ] 删 5 个 py + `scripts/__pycache__/` + requirements.txt
- [ ] README.md（徽章/技术栈表/环境节/使用流程）
- [ ] docs/unpack.md、docs/azurlane.md、docs/test.md（脚本层边界改写为 JS）
- [ ] vite.config.js + src 6 文件注释中 extract.py → extract.js
- [ ] 更新记忆：脚本层边界 py → JS

## 关键风险（各批次共通）

1. **常量曲线隐式对位**（m_IndexArray 恒 -1，按绑定序对位）：battle-tested，1:1 照搬不重构，零-warn 断言验证
2. **TextAsset 字节语义**：严格 UTF-8 失败落 .bin、成功落 .json
3. **bundle 内 resS 贴图**：冒烟非空后像素比对；unityfs-js 支持不全则在 texture.js 自拼 streamed-data
4. **capstone 保真**：不达标换 @kreijstal/capstone-wasm（封装单文件，替换成本低）

## 回归真值（本地已有）

- `.tmp/bundles/`：fulici_2（17.4MB）+ zhenzhuhao_2（18.9MB）
- `models/`：Python 版两套完整产出（fulici_2、zhenzhuhao_2）
- `.tmp/cs/`：apk 1.7GB、libil2cpp.so 115MB、dump.cs 42MB、script.json
- `.tmp/lua/CN/`：8 文件齐
