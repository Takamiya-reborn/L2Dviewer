<div align="center">

# L2Dviewer

<img src="public/icon.png" width="96" height="96" alt="L2Dviewer" />&nbsp;<img src="public/divider.svg" width="4" height="96" alt="" />&nbsp;<img src="public/vue.svg" width="96" height="96" alt="Vue 3" />

![Vue 3](https://img.shields.io/badge/Vue_3-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white)
![PixiJS](https://img.shields.io/badge/PixiJS-E72264?style=flat-square)
![Python](https://img.shields.io/badge/Python-3776AB?style=flat-square&logo=python&logoColor=white)
![uv](https://img.shields.io/badge/uv-DE5FE9?style=flat-square&logo=uv&logoColor=white)
![adb](https://img.shields.io/badge/adb-3DDC84?style=flat-square&logo=android&logoColor=white)

</div>

碧蓝航线 Live2D 皮肤查看器。从游戏客户端提取 Live2D 资源，重组为标准 Cubism 4 模型，
在浏览器中原画质还原角色的动画与交互（待机、点击反应、拖拽视线跟随等），并提供
按角色/皮肤分类的图鉴浏览。

- [azurlane.md](docs/azurlane.md) — 游戏资源格式与交互状态机原理
- [unpack.md](docs/unpack.md) — 提取脚本 `extract.py` 的用法、产物与转换细节
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

- 本项目为非官方的粉丝工具，与《碧蓝航线》的开发商及发行方（蛮啾网络、勇仕网络、
  Yostar 等）无任何关联，未获得其授权或背书。
- 本仓库仅包含代码与文档，**不包含任何游戏资源**。相关资源需使用者自行从本人
  合法获取的游戏客户端中提取，提取产物仅供本地学习交流，**不得再分发**。
- 自游戏客户端提取的资源归原权利方所有，不受本仓库 MIT 许可证约束；
  MIT 仅覆盖本项目自身的代码与文档。
- `tools/` 内的第三方工具随仓库分发：`tools/adb/` 来自 Android platform-tools
  （Apache 2.0，`NOTICE.txt` 随目录保留）；`tools/Il2CppDumper/` 来自
  [Perfare/Il2CppDumper](https://github.com/Perfare/Il2CppDumper)（MIT），
  各自归其原作者所有，遵循其自身许可证。
- README 头部图标（`public/icon.png`）为《碧蓝航线》官方应用图标，版权归
  蛮啾网络、勇仕网络等原权利方所有，非本项目所有；此处仅作标识用途，
  不代表获得官方授权或背书，不受本仓库 MIT 许可证约束。
- 提取游戏资源可能违反游戏用户协议，由此产生的风险由使用者自行承担。
- 如权利方认为本项目侵犯其合法权益，请通过 Issue 联系，核实后会及时移除相关内容。

## 技术栈

| 层         | 技术                               | 用途                                                  |
| ---------- | ---------------------------------- | ----------------------------------------------------- |
| 前端框架   | Vue 3 + Vite                       | 图鉴页面与皮肤清单                                    |
| 渲染       | PixiJS + pixi-live2d-display       | L2D 舞台渲染（Cubism 4）                              |
| 提取工具链 | Python + UnityPy                   | 解包 UnityFS、读 moc3/贴图/动画曲线                   |
| 动画转换   | Unity AnimationClip → motion3.json | 关键帧曲线换算 Cubism 贝塞尔段                        |
| 逆向参考   | Il2CppDumper                       | dump 游戏 C# 程序集（逆向期语义参考，使用流程不需要） |
| 资源采集   | adb                                | 从模拟器/设备拉取游戏资源                             |

## 查看器实现

游戏资源的目录、文件职责与开发技术见 [azurlane.md](docs/azurlane.md)；
提取、解析以及如何将结果还原为可运行模型见 [unpack.md](docs/unpack.md)。
查看器本身只保留以下几条实现纲领：

- 前端使用 Vue 3 + Vite，PixiJS 与 Cubism 4 运行时负责模型加载和渲染。
- dev server 实时扫描 `models/<角色>/<皮肤id>/`，前端按模型入口加载皮肤，
  无需手工登记。
- 标准 Cubism 资源负责渲染，`char.json`、`interaction.json` 和 `l2d.json`
  作为本项目扩展数据，分别承载基础交互参数、动作状态信息和参数机配置。
- `src/l2d/` 负责舞台、镜头、动作与手势装配，`src/utils/` 负责交互状态机、
  拖拽参数机和氛围动画；详细还原规则以 [unpack.md](docs/unpack.md) 为准。
- 未烘焙 `l2d.json` 的皮肤仍可加载，但会跳过参数机层，退回基础交互路径。

## 项目结构

```
scripts/              # 提取脚本：pull_bundles.py（资源拉取）、pull_lua.py（Lua 快照拉取）、extract.py（解包重组并烘焙交互配置）；pull_cs.py / disasm.py 为逆向期 C# 语义核对（使用流程不需要）
tools/adb/            # Android 平台工具（Apache 2.0，NOTICE 随目录分发）
tools/Il2CppDumper/   # 游戏 C# 程序集 dump 工具（MIT，逆向期参考，仅保留 x64 主程序与 config.json）
models/               # 导出的标准 Cubism 4 模型，按 <角色>/<皮肤id> 两级目录组织（不入库）
src/                  # Vue 前端（图鉴 + L2D 舞台 + 交互层）
├── components/       # UI：L2dStage（瘦壳）+ tabs/ 侧栏 + debug/HudPanel（HUD 面板）
├── l2d/              # 舞台核心（普通模块 + ctx 对象，不依赖 vue）：motionPatches（动作库补丁）、camera（取景与拖拽标定）、mount（模型挂载装配）、actions（播放 API）、gestures（指针手势）、hud（每帧读数）
└── utils/            # 交互实现：interaction/（状态机运行时、网格命中、提示层）、dragmachine/（拖拽参数机 machine/orchestrator/triggers）、ambient（effect 氛围层）、models（皮肤清单）
```

`.tmp/` 为管线工作目录（gitignore），由脚本按需自动创建：`pull_bundles.py`
建 `.tmp/bundles/`，游戏 Lua 参考快照由 `pull_lua.py` 拉到 `.tmp/lua/`（见下）。

## 使用

想使用查看器，把下面几个脚本按顺序跑一遍即可，文件处理全程自动，无需手工
登记。`scripts/` 下的脚本可以使用 uv、venv/virtualenv 或全局 Python。先任选一种方式
安装依赖，并使用同一个 Python 环境执行脚本：

```bash
# uv
uv venv
uv pip install -r requirements.txt
uv run scripts/<脚本>.py …

# venv / virtualenv
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe scripts/<脚本>.py …

# 全局 Python（不创建虚拟环境）
python -m pip install -r requirements.txt
python scripts/<脚本>.py …
```

Windows 下也可以把 `python` 换成 `py -3` 或目标 Python 的完整路径；关键是安装
依赖和执行脚本使用同一个解释器。下方示例沿用全局 `python` 写法，使用其他环境
时将其替换为对应命令即可。

```bash
# 1. 安装 Node 和 Python 依赖
npm install
python -m pip install -r requirements.txt # 也可按上方说明使用 uv 或 .venv

# 2. 从设备拉取皮肤 bundle（模拟器 adb 地址按需调整）
uv run scripts/pull_bundles.py <skin_id> --host [host:port]

# 3. 拉取游戏 Lua 快照（路径固定 .tmp/lua/<服务器>/，extract.py 自动读取；
#    默认 CN，--server JP 拉日本服；
#    文件清单与目录结构见 docs/azurlane.md 第 1 节；来源 AzurLaneLuaScripts，
#    需要代理时用 --proxy 或 HTTPS_PROXY 环境变量）
#    仅基础交互（点击门控、拖拽视线）不需要它
python scripts/pull_lua.py

# 4. 解包重组为标准 Cubism 4 模型，并自动烘焙 ship_l2d 交互配置
uv run scripts/extract.py <skin_id>

# 5. 启动查看
npm run dev       # dev server 实时扫描 models/ 生成皮肤清单，新增皮肤刷新页面即生效
```

以上流程不涉及 `tools/Il2CppDumper/`：它是逆向期理解游戏 C# 语义的参考工具
（见 [azurlane.md](docs/azurlane.md)“逆向参考文件”），跑通查看器用不到，`tools/adb/`
则由第 2 步的 `pull_bundles.py` 调用。

## 测试

测试位于 `scripts/tests/`，覆盖模型扫描、交互状态机、拖拽参数机和氛围层等逻辑。
在仓库根目录执行：

```bash
# 运行全部测试
npm test

# 或直接调用测试入口
node scripts/tests/run_all.mjs

# 只运行文件名包含指定字符串的测试，例如交互相关测试
node scripts/tests/run_all.mjs interaction
```

测试入口会自动发现并串行运行全部 `test_*.mjs` 文件，最后按退出码汇总结果。

`scripts/tests/probe/` 另有不进测试入口的诊断 CLI——交互管线场景重放
（simulate.mjs）、参数姿态几何对比（pose_diff.mjs）、moc3 参数表/命中区
核对等，排查"点击不触发/播错动作/扭曲错位"类运行时问题时手动跑，
用法见 [docs/test.md](docs/test.md)。

## 致谢

- [Perfare/Il2CppDumper](https://github.com/Perfare/Il2CppDumper)（MIT）—
  dump 游戏 Il2Cpp 程序集，交互逻辑还原（`Live2dChar` 等 C# 侧语义）由此入手
- [AzurLaneTools/AzurLaneLuaScripts](https://github.com/AzurLaneTools/AzurLaneLuaScripts) —
  社区自动解密发布的游戏明文 Lua 脚本，交互配置（`ship_l2d`）与控制层
  （`live2d`/`live2ddrag`）语义的权威参照
