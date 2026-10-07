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

- [azurlane.md](azurlane.md) — 游戏资源格式、交互状态机原理与提取管线
- [unpack.md](unpack.md) — 提取脚本 `extract.py` 的用法、产物与转换细节
- `scripts/` 下各脚本的命令行用法以文件头部说明为准

## 版权说明

- 本项目为非官方的粉丝工具，与《碧蓝航线》的开发商及发行方（蛮啾网络、勇仕网络、
  Yostar 等）无任何关联，未获得其授权或背书。
- 本仓库仅包含代码与文档，**不包含任何游戏资源**。模型、贴图、动画等需使用者
  自行从本人合法获取的游戏客户端中提取，提取产物仅供本地学习交流，
  **不得再分发**（`.gitignore` 已排除 `public/models/`，请保持）。
- 自游戏客户端提取的资源归原权利方所有，不受本仓库 MIT 许可证约束；
  MIT 仅覆盖本项目自身的代码与文档。
- README 头部图标（`src/assets/icon.png`）为《碧蓝航线》官方应用图标，版权归
  蛮啾网络、勇仕网络等原权利方所有，非本项目所有；此处仅作标识用途，
  不代表获得官方授权或背书，不受本仓库 MIT 许可证约束。
- **本项目禁止构建与部署**：`npm run build` 已默认阻止（见 `vite.config.js`），
  构建产物会把 `public/models/` 中的游戏资产原样打包进 `dist/`，一旦对外提供
  即构成资源再分发。本仓库仅限本地开发运行。
- 提取游戏资源可能违反游戏用户协议，由此产生的风险由使用者自行承担。
- 如权利方认为本项目侵犯其合法权益，请通过 Issue 联系，核实后会及时移除相关内容。

## 技术栈

| 层         | 技术                               | 用途                                |
| ---------- | ---------------------------------- | ----------------------------------- |
| 前端框架   | Vue 3 + Vite                       | 图鉴页面与皮肤清单                  |
| 渲染       | PixiJS + pixi-live2d-display       | L2D 舞台渲染（Cubism 4）            |
| 提取工具链 | Python + UnityPy                   | 解包 UnityFS、读 moc3/贴图/动画曲线 |
| 动画转换   | Unity AnimationClip → motion3.json | 关键帧曲线换算 Cubism 贝塞尔段      |
| 资源采集   | adb                                | 从模拟器/设备拉取游戏资源           |

## 项目结构

```
scripts/              # 提取脚本：pull_bundles.py（资源拉取）、extract.py（解包重组）
tools/                # adb 等系统工具
public/models/        # 导出的标准 Cubism 4 模型，按 <角色>/<皮肤id> 两级目录组织
src/                  # Vue 前端（图鉴 + L2D 舞台 + 交互层）
```

## 开发

```bash
npm install
npm run dev       # 开发服务器（仅此一步即可本地使用）
# npm run build 已被禁止：会打包 public/models 游戏资产，产物不得分发
```

添加新皮肤：用 `scripts/` 里的脚本拉取并提取（流程见 [azurlane.md](azurlane.md)），
皮肤清单由 vite 插件扫描 `public/models` 自动生成，重启 dev 即生效。
