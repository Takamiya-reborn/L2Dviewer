<div align="center">

# L2Dviewer

<img src="src/assets/icon.png" width="96" height="96" alt="L2Dviewer" />&nbsp;<img src="src/assets/divider.svg" width="4" height="96" alt="" />&nbsp;<img src="src/assets/vue.svg" width="96" height="96" alt="Vue 3" />

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
- README 头部图标（`src/assets/icon.png`）为《碧蓝航线》官方应用图标，版权归
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

游戏侧的资源格式与状态机机制见 [azurlane.md](docs/azurlane.md)，本节只写查看器
怎么把提取产物还原成交互：

- **皮肤清单**：dev server 每次请求实时扫描根目录
  `models/<角色>/<皮肤id>/<皮肤id>.model3.json` 生成（`vite.config.js` 的
  serveModels 中间件），前端在 main.js 挂载前 fetch（`src/utils/models.js`）；
  新增皮肤刷新页面即生效，无需手工登记
- **加载**：pixi-live2d-display（PixiJS 插件，Cubism 4）加载 model3.json；
  运行时默认找 `Idle` 组（首字母大写），加载时需传 `idleMotionGroup: 'idle'`
- **点击**：tap 命中 HitArea → 交互运行时（`src/utils/interaction/`）按
  interaction.json 做状态门控后播放对应动作组。门控实现为显式有向图：节点 =
  开关型参数值向量，动作 = 边——前置约束只取起播值=1 且可产出的开关（比对
  跟踪节点而非实时参数，实时值受逐帧曲线与眨眼/呼吸扰动；0/-1 起播是 t0
  硬设，不构成前置），结束值即转移结果，在 `motionFinish`（对应游戏
  OnFinishAnim 的上报时机）落实；idle 变体是循环动作、永不 `motionFinish`，
  其开关状态在起播瞬间即落账（微笑眼等姿态预设从起播起持续整个循环）；
  无开关参数的反应动作仅中性节点（全部状态参数贴 moc 默认）可触发。参数
  默认值不在 bundle 内（在 moc3），运行时按下标经
  `coreModel.getParameterDefaultValue` 取用。关闭 autoInteract 时，命中后
  需手动调用 `model.tap()` 播放对应动作
- **拖拽**：指针拖拽按 char.json（`Live2dChar`）的 DragRateX/Y 与 DampingTime
  做阻尼视线跟随
- **拖拽参数机**：命中 `ship_l2d` 配置的分区（TouchIdle/TouchDrag 系）时，
  交互由 `src/utils/dragmachine/` 的机器接管（配置由 `bake_l2d.py` 烘焙为
  模型目录内的 `<id>.l2d.json`）。按下命中分区时 `startDrag` 广播给该分区的
  **全部**机器（与游戏 onPointDown 一致，同名多机协同，如 wuzang_3 的
  TouchDrag2 挂充能/联动/长按 4 台）。已实现触发类型：2 点击（含
  `circle`+`target` 图层 0↔1 切换、随机数组 action）、6 连点循环（下标推进、
  末位回卷、跨会话持久化）、3 长按顺序播 `action_list`（`last` 松手收尾）、
  4 双轴拖到 `num` 邻域保持 `time` 秒、8 按住充能（`delta` 秒/单位）、9 点击
  时他参贴近 `num` ±0.05；relation 联动参数实现 101/102（跟随拖动量，
  SmoothDamp 平滑）与 103（跟随连点下标）。触发冷却按游戏语义——动作真正
  播出时全部机器冷却塌缩回 `min(limit_time, 0.2)` 秒，足额冷却只对不产出
  播放的触发生效。白名单/黑名单与机器按压锁对组名 `idle` 恒放行（游戏
  checkEnablePlay 同款豁免，反应动作播完的显式待机回落不被拦截）；
  拒播（引擎拒绝/被名单挡下）时 activeData 不入账，变体号/白名单只记到
  真正播出的动作上。拖拽按 `offset_x/y` 换算参数、`range` 钳制、`smooth` 平滑、
  松手按 `parts_data` 档位吸附（type 2/3 限单向档位）、`revert` 控制回弹
  （-1 = 不回弹且持久化，localStorage 模拟游戏 PlayerPrefs）；`revert_idle_index`
  名单内的机器在 idle 变体切换时整体复位。触发后的待机回落按 idle 变体号取
  `idle` 组内对应动作（`idle_index` 映射表）。未烘焙的皮肤整层旁路，交互退回
  上面的近似路径
- **交互点提示**：测试用 HUD，绿 = 可交互、红 = 被挡下、橙 = 游戏配置了
  触发但查看器未实现该类型。颜色按真实路由分家：机器分区按参数机自身的
  可触发条件（`DragMachine.interactable()`；同名多机时任一台可响应即绿），
  无机器的分区才按 interaction.json 的起播门控
- **待机**：`idle` 组循环播放；回落按游戏本体语义分两层——反应动作
  `motionFinish` 后由 orchestrator **显式** force 重播组名 `idle`（对应游戏
  FinishAction 处理器的 changeActionIdle，Unity Animator 由 "idle" 整数原子
  选变体子状态，不存在引擎随机回落），变体号按 `idle_index` 查表解析；
  引擎 `startRandomMotion` 的确定性选支补丁仅作兜底（有参数机时恒取当前
  变体；无参数机取组内与组同名的支，且节点非中性期间不回落）。两层都不
  随机换支，避免与状态机遗留的开关参数（摊开的菜单等）冲突。HUD 动作行
  标注每次 idle 起播的来源：`explicit` = 显式回落、`engine` = 引擎兜底、
  `engine-noorch` = 旧挂载 ctx 泄漏的 bug 信号、`退化` = 文件名未命中
  回退基础 idle
- **氛围层**：`effect` 组作为常驻层，按 motion3.json 曲线逐帧采样后直写参数，
  叠加在任意动作之上（`src/utils/ambient.js`）

## 项目结构

```
scripts/              # 提取脚本：pull_bundles.py（资源拉取）、pull_lua.py（Lua 快照拉取）、extract.py（解包重组）、parse_ship_l2d.py（交互配置解析）、bake_l2d.py（交互配置烘焙）；pull_cs.py / disasm_window.py 为逆向期 C# 语义核对（使用流程不需要）
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

# 3. 拉取游戏 Lua 快照（路径固定 .tmp/lua/<服务器>/，解析端 parse_ship_l2d.py
#    与烘焙端 bake_l2d.py 从同一位置读取；默认 CN，--server JP 拉日本服；
#    文件清单与目录结构见 docs/azurlane.md 第 3 节；来源 AzurLaneLuaScripts，
#    需要代理时用 --proxy 或 HTTPS_PROXY 环境变量）
#    仅基础交互（点击门控、拖拽视线）不需要它
python scripts/pull_lua.py

# 4. 解包重组为标准 Cubism 4 模型
uv run scripts/extract.py <skin_id>

# 5. 烘焙交互配置（ship_l2d → <id>.l2d.json，拖拽参数机的数据源）
#    不跑这步皮肤也能看，但拖拽参数机整层旁路，交互退回基础近似
uv run python -I scripts/bake_l2d.py <skin_id>

# 6. 启动查看
npm run dev       # dev server 实时扫描 models/ 生成皮肤清单，新增皮肤刷新页面即生效
```

以上流程不涉及 `tools/Il2CppDumper/`：它是逆向期理解游戏 C# 语义的参考工具
（见 [azurlane.md](docs/azurlane.md) 第 3 节），跑通查看器用不到，`tools/adb/`
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
