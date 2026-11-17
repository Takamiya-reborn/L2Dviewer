<div align="center">

# L2Dviewer

<img src="public/icon.png" width="96" height="96" alt="L2Dviewer" />&nbsp;<img src="public/divider.svg" width="4" height="96" alt="" />&nbsp;<img src="public/vue.svg" width="96" height="96" alt="Vue 3" />

![Vue 3](https://img.shields.io/badge/Vue_3-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white)
![PixiJS](https://img.shields.io/badge/PixiJS-E72264?style=flat-square)
![Node](https://img.shields.io/badge/Node-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![adb](https://img.shields.io/badge/adb-3DDC84?style=flat-square&logo=android&logoColor=white)

</div>

碧蓝航线 Live2D 皮肤查看器。从游戏客户端提取 Live2D 资源，重组为标准 Cubism 模型（Cubism 4 与 5 两代 moc3），在浏览器中原画质还原角色的动画与交互（待机、点击反应、拖拽视线跟随等），并提供按角色/皮肤分类的图鉴浏览。

- [azurlane.md](docs/azurlane.md) — 游戏资源格式与交互状态机原理
- [unpack.md](docs/unpack.md) — 提取脚本 `extract.js` 的用法、产物与转换细节
- `scripts/` 下各脚本的命令行用法以文件头部说明为准

## 目录

- [版权说明](#版权说明)
- [技术栈](#技术栈)
- [查看器实现](#查看器实现)
- [项目结构](#项目结构)
- [使用](#使用)
- [测试](#测试)
- [致谢](#致谢)

## 版权说明

- 本项目为非官方的粉丝工具，与《碧蓝航线》的开发商及发行方（蛮啾网络、勇仕网络、Yostar 等）无任何关联，未获得其授权或背书。
- 本仓库仅包含代码与文档，**不包含任何游戏资源**。相关资源需使用者自行从本人合法获取的游戏客户端中提取，提取产物仅供本地学习交流，**不得再分发**。
- 自游戏客户端提取的资源归原权利方所有，不受本仓库 MIT 许可证约束；MIT 仅覆盖本项目自身的代码与文档。
- `tools/` 内的第三方工具随仓库分发：`tools/adb/` 来自 Android platform-tools（Apache 2.0，`NOTICE.txt` 随目录保留）；`tools/Il2CppDumper/` 来自 [Perfare/Il2CppDumper](https://github.com/Perfare/Il2CppDumper)（MIT），各自归其原作者所有，遵循其自身许可证。
- README 头部图标（`public/icon.png`）为《碧蓝航线》官方应用图标，版权归蛮啾网络、勇仕网络等原权利方所有，非本项目所有；此处仅作标识用途，不代表获得官方授权或背书，不受本仓库 MIT 许可证约束。
- 提取游戏资源可能违反游戏用户协议，由此产生的风险由使用者自行承担。
- 如权利方认为本项目侵犯其合法权益，请通过 Issue 联系，核实后会及时移除相关内容。

## 技术栈

| 层         | 技术                               | 用途                                                                   |
| ---------- | ---------------------------------- | ---------------------------------------------------------------------- |
| 前端框架   | Vue 3 + Vite                       | 图鉴页面与皮肤清单                                                     |
| 渲染       | PixiJS + pixi-live2d-display       | L2D 舞台渲染（Cubism 4/5 模型）                                        |
| 提取工具链 | Node + unityfs-js                  | 解包 UnityFS、读 moc3/贴图/动画曲线（ASTC 贴图 texture2ddecoder-wasm） |
| 动画转换   | Unity AnimationClip → motion3.json | 关键帧曲线换算 Cubism 贝塞尔段                                         |
| 逆向参考   | Il2CppDumper                       | dump 游戏 C# 程序集（逆向期语义参考，使用流程不需要）                  |
| 资源采集   | adb                                | 从模拟器/设备拉取游戏资源                                              |

## 查看器实现

游戏资源的目录、文件职责与开发技术见 [azurlane.md](docs/azurlane.md)；提取、解析以及如何将结果还原为可运行模型见 [unpack.md](docs/unpack.md)。查看器本身只保留以下几条实现纲领：

- 前端使用 Vue 3 + Vite，PixiJS 与 pixi-live2d-display 负责模型加载和渲染；bundled 的 Cubism Core 为 5.x，向后兼容加载 4/5 两代 moc3。
- dev server 实时扫描 `models/<角色>/<皮肤id>/`，前端按模型入口加载皮肤，无需手工登记。
- 标准 Cubism 资源负责渲染，`char.json`、`interaction.json` 和 `l2d.json` 作为本项目扩展数据，分别承载基础交互参数、动作状态信息和参数机配置。
- `fades.json` 保存 Unity Animator 按动作提取的 AnyState 转场时长；查看器按 clip 应用交叉渐变，并让交互参数复位使用同一时长，缺失时回退到 300ms。
- 动作库补丁对齐游戏本体运行时语义：曲线目标分组序归一、参数落笔去钳位（游戏直写原值，越出 moc3 量程的值是合法姿态）。
- `idle` 动作支持先切换变体再播放，适用于用背景网格切换待机摆位的皮肤；被新动作顶掉的旧反应不会遗留“播放中”状态。
- `src/l2d/` 负责舞台、镜头、动作与手势装配，`src/utils/` 负责交互状态机、拖拽参数机和氛围动画；详细还原规则以 [unpack.md](docs/unpack.md) 为准。
- 未烘焙 `l2d.json` 的皮肤仍可加载，但会跳过参数机层，退回基础交互路径。

## 项目结构

```
scripts/              # 提取脚本：pull_bundles.js（资源拉取）、pull_lua.js（Lua 快照拉取）、extract.js + extract/（解包重组并烘焙交互配置与 fades.json）、gen_catalog.js（皮肤目录生成）；pull_cs.js / disasm.js 为逆向期 C# 语义核对（使用流程不需要）
tools/adb/            # Android 平台工具（Apache 2.0，NOTICE 随目录分发）
tools/Il2CppDumper/   # 游戏 C# 程序集 dump 工具（MIT，逆向期参考，仅保留 x64 主程序与 config.json）
models/               # 导出的标准 Cubism 模型（moc3 v4/v5），按 <角色>/<皮肤id> 两级目录组织（不入库）
src/                  # Vue 前端（图鉴 + L2D 舞台 + 交互层）
├── components/       # UI：L2dStage（瘦壳）+ tabs/ 侧栏 + debug/HudPanel（HUD 面板）
├── l2d/              # 舞台核心（普通模块 + ctx 对象，不依赖 vue）：motionPatches（动作库补丁）、motionDiff（动作曲线差分）、paramOverride（HUD 参数注入）、camera（取景与拖拽标定）、mount（模型挂载装配）、actions（播放 API）、gestures（指针手势）、hud（每帧读数）
└── utils/            # 交互实现：interaction/（状态机运行时、网格命中、提示层）、dragmachine/（拖拽参数机 machine/orchestrator/triggers）、ambient（effect 氛围层）、models（皮肤清单）
```

`.tmp/` 为管线工作目录（gitignore），由脚本按需自动创建：`pull_bundles.js` 建 `.tmp/bundles/`，游戏 Lua 参考快照由 `pull_lua.js` 拉到 `.tmp/lua/`（见下）。

## 使用

### 图形界面（推荐）

```bash
npm install
npm run dev
```

打开页面后左侧皮肤列表展示全部皮肤的显示名（来自仓库内 `public/catalog.json` 目录），可按阵营（白鹰/皇家/重樱等，对齐游戏内筛选）与资源状态（已烘焙/已缓存/未拉取）过滤：资源在盘的条目为绿色，点击直接加载；未拉取条目点击后弹层确认（展示当前 adb 连接的设备），确认后 dev server 自动完成"设备拉取 bundle → 解包烘焙 → 加载"全流程，完成后条目转绿并自动上屏。需要模拟器/手机以 adb 连接。

### 命令行

想用命令行把脚本按顺序跑一遍也可以，文件处理全程自动，无需手工登记：

```bash
# 1. 安装依赖
npm install

# 2. 从设备拉取皮肤 bundle（模拟器 adb 地址按需调整）
#    如果不知道皮肤id是什么就使用 --list <关键词>
#    资源关键词就直接是拼音拼的
#    比如: node scripts/pull_bundles.js --list wuzang
node scripts/pull_bundles.js <skin_id>

# 3. 拉取游戏 Lua 快照（路径固定 .tmp/lua/<服务器>/，extract.js 自动读取；
#    默认 CN，--server JP 拉日本服；
#    文件清单与目录结构见 docs/azurlane.md 第 1 节；来源 AzurLaneLuaScripts，
#    需要代理时用 --proxy 或 HTTPS_PROXY 环境变量）
node scripts/pull_lua.js

# 4. 解包重组为标准 Cubism 模型（v4/v5），并自动烘焙 ship_l2d 交互配置
node scripts/extract.js <skin_id>

# 5. 启动查看
npm run dev       # dev server 实时扫描 models/ 生成皮肤清单，新增皮肤刷新页面即生效
```

以上流程不涉及 `tools/Il2CppDumper/`：它是逆向期理解游戏 C# 语义的参考工具（见 [azurlane.md](docs/azurlane.md)“逆向参考文件”），跑通查看器用不到，`tools/adb/` 则由第 2 步的 `pull_bundles.js` 调用。

### 皮肤目录维护

`public/catalog.json`（显示名 → bundle 名映射，纯名字元数据）由 `scripts/gen_catalog.js` 从游戏 Lua 快照与设备侧 live2d 索引生成。游戏版本更新后重新生成并提交：

```bash
node scripts/pull_bundles.js --index   # 刷新 .tmp/hashes-live2d.csv 等索引
node scripts/pull_lua.js               # 刷新 .tmp/lua/ 快照
node scripts/gen_catalog.js            # 重新生成 public/catalog.json
```

## 测试

测试位于 `scripts/tests/`，覆盖模型扫描、交互状态机、拖拽参数机和氛围层等逻辑。在仓库根目录执行：

```bash
# 运行全部测试
npm test

# 或直接调用测试入口
node scripts/tests/run_all.mjs

# 只运行文件名包含指定字符串的测试，例如交互相关测试
node scripts/tests/run_all.mjs interaction
```

测试入口会自动发现并串行运行全部 `test_*.mjs` 文件，最后按退出码汇总结果。

`scripts/tests/probe/` 另有不进测试入口的诊断 CLI——交互管线场景重放与分区审计（drive.mjs）、复位/姿态差分（diff.mjs）、moc3 资产与配置阅读（moc3.mjs / config.mjs）等，排查“点击不触发/播错动作/扭曲错位”类运行时问题时手动运行，用法见 [docs/test.md](docs/test.md)。

## 致谢

- [Perfare/Il2CppDumper](https://github.com/Perfare/Il2CppDumper)（MIT）—
  dump 游戏 Il2Cpp 程序集，交互逻辑还原（`Live2dChar` 等 C# 侧语义）由此入手
- [AzurLaneTools/AzurLaneLuaScripts](https://github.com/AzurLaneTools/AzurLaneLuaScripts) —
  社区自动解密发布的游戏明文 Lua 脚本，交互配置（`ship_l2d`）与控制层
  （`live2d`/`live2ddrag`）语义的权威参照
