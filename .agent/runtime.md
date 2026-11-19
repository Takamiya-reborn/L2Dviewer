# L2D 运行时语义

数据源依据：游戏 C# dump + live2d.lua 控制层。改运行时行为前先对照这两处，不要凭引擎直觉推断——查看器以游戏本体行为为准。

## 挂载与复位

- 挂载入口是硬切：Unity entry state 无转场时长，首支 idle 以 fadeIn=0 起播，揭幕后恢复表值（mount.js `mountModelInner()`）。
- auto-idle 的 motionStart 早于 runtime 创建会被错过，节点滞留默认值后门控拦死触点——mount.js `mountModelInner()` 末尾向 motionManager.state 补 `trackMotionStart()`（约 121 行）。
- 游戏重置语义 = 就地复位（出屏 0.3s + 动画机 5 倍速、清存档重播 idle，不重建模型）；查看器主路径在 actions.js `resetInteraction()`，不要加 remount 钩子。
- 复位缓动会污染引擎混合基线导致起播闪变；interaction/runtime.js `beginSmoothReset()` 对由新动作驱动的参数做了豁免，改动前先看该处。

## 参数写入

- 框架 setParameterValue* 会钳位到参数量程，游戏是直写原值；越界曲线值是合法姿态（如小臂 55 > 量程 30）。去钳位补丁已落地，探针要复现须直写 coreModel 数组。
- 写参数前先 grep 该参数在 motions 里是否为常量曲线：全动作常量 0 的烘焙副本会让一次性基值写被吃掉，须登记式逐帧覆盖（ring.js `createOathRing()` 的 Paramring 即此写法，挂在 afterMotionUpdate，effect 挂载在后则 effect 赢）。
- Core 5.1 开关参数值变一次即永久切换关键形态分支（如 Param57 小臂分支），复位不解吸；做参数扫描须重建基线 + noop 自查。
- 机器参数图层走 orchestrator.js 机器图层段（约 377 行起）：mode 1=Override 直写、2=Additive 叠加、3=Multiply 相乘，relation 联动参数随后写入。

## 视线与呼吸

- 视线按住才跟随、松手回正：gestures.js `followGaze()` / `resetGaze()`；张臂姿态只在按住拖拽期间成立，不要改回不回零。
- 库默认的 CubismBreath 是引擎私货，游戏 C# 无 Breath 层，mount.js `mountModelInner()` 已整层移除，勿加回。

## 取景（主页 L2D 三层链）

- 游戏取景 = Live2DPainting（live2d_offset[1..3] 位移、[4] 根缩放默认 52）+ 主页容器两级位移 + CanvasScaler 按宽适配；camera.js `fitModel()` 游戏路径实现全链，无 l2d.json 的皮肤退回 ROI 拟合。
- 容器位移（mellow 主题，NewMainScene 默认，mainpaintingview.lua `AdjustPosition` 两级叠加）：painting 根 _tf 按 meshImageShift、l2dContainer 按 l2dShift。三层合计：ship_skin_newmainui_shift 表皮肤 = l2d_shift − (145, 10)；表外 = (0, −10)。l2d_shift[4] 的容器缩放游戏 AdjustPosition 未消费，不实现。
- 半身像名单皮肤（biaoqiang/z23/lafei/lingbo/mingshi/xuefeng，MainPaintingShift.IsLimitYPos）：容器 y 被半身公式覆盖，合计 y = −10 − 屏幕pt高/2 + 325，屏幕pt高 = 1334·视口高/宽（随宽高比变，游戏 AddScreenChangeTimer 轮询重算同语义）。
- 屏幕适配 = CanvasScaler 按宽：可见画布宽恒 1334pt、高随视口宽高比伸缩；16:9 与按高模式重合，故 16:9 下校准过的取景不受影响。证据：半身像皮肤按屏幕尺寸重算 rect.height（按高适配下 rect.height 恒定无需重算）。
- 拖拽标定按宽：dragScale = 1920/(视口宽·fill)（offset_x/y 以游戏屏幕像素计；16:9 下与按高标定同值）。

## 门控与播放

- canPlay 前置条件须 moc 默认值可满足：默认给不出的「起播=1」是姿态顺带值而非门控（ougen_8 基础反应全灭根因）。
- C# 反应路径不收机器分区；touch_special 走 C# 反应路径。
- 触发点选取：GetDragPart 名单序最大者胜，GetTouchPart 最小者胜；联动层 kind1 相对 / kind2 绝对（triggers.js `TRIGGER_HANDLERS`）。
- "idle" 动作名恒放行、无引擎回落（actions.js `idleGroupIndex()`）；游戏无输入推进 idle 变体的机制尚未定位。

## 引擎一致性

真引擎与裸曲线有四处合法分歧：物理输出、结尾淡出、混合期、一帧延迟。自建测试引擎须带 fades 表（fades 表来源 scripts/extract/animator.js `animatorFades()`），否则结论不可信。

- pixi v6 事件管线失效，涉及原生事件的监听均经替代通道实现（gestures.js / clickEffect.js 自持 pointer 监听）。
- HUD 差分面板中，物理输出口与 effect 组的差分行是合法噪声，非缺陷信号（hud.js `motionDiffReadout()`）。
