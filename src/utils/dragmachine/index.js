/**
 * 游戏拖拽参数机（Lua 控制层 Live2dDrag / Live2D）的 Web 还原。
 *
 * 数据源是 extract.py 烘焙的 <id>.l2d.json（pg.ship_l2d 配置 + idle 变体表），
 * 每个条目描述一个可交互分区（draw_able_name，如 TouchIdle1/TouchDrag3）绑定
 * 的参数机：点击/拖拽驱动 parameter，按 range 钳制、smooth 平滑、松手后按
 * revert 回弹（-1 = 不回弹且持久化，游戏存 PlayerPrefs，这里存 localStorage）、
 * parts_data 档位吸附；action_trigger.type 决定触发方式，触发后播放 action
 * （可为随机数组）并应用 action_trigger_active（动作白名单/黑名单 + idle
 * 变体切换）。字段语义与控制层逻辑的对照见 docs/azurlane.md 第 3 节。
 *
 * 与 interaction.js 状态机的关系：这套机器接管"分区 -> 动作"的路由（游戏里
 * 就是 Lua 层在做的事），命中机器分区的手势不再走 playHitMotion 的组名近似
 * 路径；interaction.json 的参数门控继续负责没有机器的分区（摸头/普通触摸等
 * C# 层路径）。白名单/黑名单对一切动作播放生效（游戏 checkEnablePlay 语义）。
 *
 * 触发类型扩展点：TRIGGER_HANDLERS 是 type -> handler 映射表（triggers.js）。
 * 已实现 type 1（按住且参数现值进 num 邻域达 time 秒）、type 2（点击，含
 * circle/target 切换、focus 按下即触发、target_focus 跳变）、type 3（按住
 * time 秒顺序播 action_list，last 松手收尾，按下重置下标；触发瞬间临时关
 * ableFlag——按住屏蔽一切播放，本机自发触发的动作靠这扇窗播出）、type 4
 * （双轴拖到 num 邻域保持 time 秒触发）、type 5（idle 常量跟随，const_fit
 * 查表贴值）、type 6（连点循环 action_list，与 type 2 共用 checkClickAction
 * 点击判定，下标每次触发推进、末位回卷即 slot11 松开、跨会话持久化）、
 * type 8（按住充能，delta 秒/单位）、type 9（点击时他参贴近 num ±0.05 才
 * 触发，参数从模型实时值读）、type 12（扩展动作规则：参数进 num 区间时对
 * ignore/enable 名单生效，裁决挂在 checkEnablePlay 白/黑名单之前，enable
 * 直通越按压锁）；其余类型注册为 unsupported（一次性告警）。
 * relation_parameter 联动参数已实现 101/102（跟随拖动量 offsetDragX/Y，
 * SmoothDamp 平滑）与 103（跟随 action_list 下标查 relation_value）；后续按
 * live2ddrag.lua 的 updateTrigger 逐型补齐即可，下棋小游戏（type 15/16）参照
 * Live2DExtend 的九宫格连线判定，等有实际皮肤再实测实现。未实现但已留好
 * 数据通路：offset_circle 圆盘拖拽、react_pos_x/y 视线联动、relation 104
 * （idle+计时）。listener_data 监听器已实现（PLAY/CHANGE_IDLE 两类真路径；
 * DRAG_CLICK 等四类通知在原文是死路径，见 machine.onListenerEvent）。
 *
 * 文件划分：machine.js 单台参数机（DragMachine）、orchestrator.js 编排器
 * （DragOrchestrator + loadL2dConfig）、triggers.js 触发处理器表。保持零
 * npm 依赖（测试在 Node 下静态 import，见 scripts/tests/test_dragmachine.mjs）。
 */
export { DragMachine } from './machine.js'
export { DragOrchestrator, loadL2dConfig } from './orchestrator.js'
