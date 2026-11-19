# 贡献指南

感谢关注 L2Dviewer！本项目是碧蓝航线 Live2D 皮肤查看器，一个非官方的粉丝工具。欢迎以 Issue 反馈问题、以 Pull Request 提交代码与文档改进。

开始前请先通读 [README.md](README.md)，尤其是[版权说明](README.md#版权说明)一节——本项目对游戏资源有严格边界，贡献前必须了解。

## 版权红线

以下条款是硬性约束，违反的 PR 将被直接拒绝：

- **禁止提交任何游戏资源及其提取产物**，包括但不限于：bundle、moc3、贴图、动作文件、Lua 快照、C# dump 结果、烘焙出的模型目录（`models/` 整体不入库）。相关资源由使用者自行从本人合法获取的游戏客户端中提取，仅供本地使用，不得再分发。
- 允许提交的资源仅限：项目自绘的贴图（如 `public/effects/`）、代码生成的纯元数据（如 `public/catalog.json` 显示名映射）。
- 不要把 `.tmp/`（管线工作目录）的内容带进仓库，它已被 gitignore。
- 新增第三方依赖或随仓库分发第三方工具前，请先在 Issue 中说明来源与许可证，经讨论后再引入。

## 环境准备

- **Node 24**：仓库根目录的 `mise.toml` 声明了 Node 版本，装好 [mise](https://mise.jdx.dev/) 后进入仓库目录自动切换；也可以自行安装 Node 24。
- `npm install` 安装依赖。
- 想跑通完整的资源管线（拉取 → 烘焙 → 加载）需要一台以 adb 连接的模拟器或手机；只做前端/测试开发则不需要。
- 如需从 GitHub 拉取 Lua 快照等外部资源而直连失败，配置代理（`HTTPS_PROXY` 环境变量或脚本 `--proxy` 参数）。

## 开发流程

1. Fork 或拉取仓库，从 `main` 切出功能分支。
2. 开发运行 `npm run dev`，dev server 实时扫描 `models/<角色>/<皮肤id>/` 生成皮肤清单，新增皮肤刷新页面即生效，无需手工登记。
3. 涉及提取管线时按 [README「命令行」](README.md#命令行)一节的顺序执行脚本；脚本用法见 [docs/unpack.md](docs/unpack.md)，游戏资源格式与交互状态机原理见 [docs/azurlane.md](docs/azurlane.md)。
4. 游戏版本更新后维护 `public/catalog.json` 的流程见 [README「皮肤目录维护」](README.md#皮肤目录维护)。

## 测试

提交前请确保测试通过。测试位于 `scripts/tests/`：

```bash
npm test                                  # 运行全部测试
node scripts/tests/run_all.mjs interaction  # 只运行文件名含指定字符串的测试
```

- 测试入口自动发现并串行运行全部 `test_*.mjs` 文件，按退出码汇总结果。
- `scripts/tests/probe/` 下的诊断 CLI 不进测试入口，用于排查“点击不触发/播错动作/扭曲错位”类运行时问题，用法见 [docs/test.md](docs/test.md)。
- 新增逻辑请配套单测；涉及动作引擎复现的场景须带 fades 表，并覆盖与真引擎的四处合法分歧（物理输出 / 结尾淡出 / 混合期 / 一帧延迟），否则结论与真引擎不一致。

## 提交规范

### 提交信息

采用约定式提交，格式 `type(scope): subject`：

- 常用 type：`feat`（新功能）、`fix`（修复）、`refactor`（重构）、`docs`（文档）、`test`（测试）、`chore`（杂项）。
- scope 可选，填改动所在的模块，如 `feat: add triggle for ring after married` 中的 ring 层语义。
- subject 用一句短句写清改动内容，中英文均可，不句号结尾。

### Pull Request

- PR 描述写清三件事：改了什么、为什么改、怎么验证的（跑了哪些测试 / 实机确认了哪些行为）。
- 不在 PR 中夹带与主题无关的改动；格式化产生的无关 diff 请先还原。
- 改动涉及文档（README / docs/）所述行为时，同一 PR 内同步更新对应文档。

## 反馈与讨论

- **报 Bug**：请附上皮肤 id、复现步骤、期望与实际行为；涉及交互问题时，HUD 面板（debug 面板）的截图或读数能极大加快定位。
- **功能建议**：说明想还原的游戏内行为，最好带上所属角色/皮肤，便于对照游戏本体语义。
- **版权问题**：如权利方认为本项目侵犯其合法权益，请通过 Issue 联系，核实后会及时移除相关内容。
