/**
 * Unity 端 L2D 交互控制器（Live2dChar + 游戏自定义控制器）的 Web 还原。
 *
 * 数据源是 extract.py 生成的 <id>.interaction.json：每支动作的
 * AnimationEvent（OnAnimEvent=语音钩子、OnFinishAnim(N)=结束状态编号）与
 * 开关型参数（取值贴 0/±1 的图层/道具开关）的 [起播值, 结束值]。字段语义见
 * docs/unpack.md，协议逆向过程见 docs/azurlane.md 的"交互状态机"一节。
 *
 * 游戏不在动作间复位参数，状态机参数的值跨动作持续，"点击摊开菜单 ->
 * 分支 -> 收尾"的状态机就建立在参数连续性上：
 * - 跨动作保留：touch_idle1 播完后 caidan=1（菜单摊开）持续到分支播完；
 *   连续摆位同理（touch_idle1 摊开菜单时 All_X=2.34 场景右移，idle1 变体
 *   不复写该参数，位移持续到收尾分支带回 0）——extract.py 把这类参数落盘
 *   在 clips[*].carry，与开关参数（state）一起进节点、复位时豁免；
 * - 点击门控：起播值=1 的开关是前置状态（动作依赖该图层/道具已摊开，
 *   touch_idle2/4/6/8 以 caidan=1 起播，仅菜单摊开时是合法分支）。
 *
 * 运行时把它实现成显式的有向图：节点 = 状态参数的值向量，动作 = 边
 * （起播值=1 的开关 = 前置约束，结束值 = 转移结果）。节点被显式跟踪——
 * 动作起播先挂起（pending），播完（motionFinish，即游戏 OnFinishAnim 的
 * 上报时机）才落实转移；被新动作顶掉的挂起动作按"已播完"结算（结束值
 * 是绝对值，重复应用幂等）。门控一律查节点而非实时参数：实时值会被
 * 逐帧曲线、眨眼/呼吸等姿态系统扰动（如点击瞬间正逢眨眼，ParamEyeLOpen
 * 离 1 很远，按实时值比对会误拒合法分支），节点只在转移时变化。
 *
 * 文件划分：runtime.js 状态机运行时（loadInteraction + InteractionRuntime）、
 * hitTest.js 网格级命中检测（纯几何，零依赖）、hints.js 交互点可视化提示
 * （pixi 调试覆盖层）。
 */
export { loadInteraction, InteractionRuntime } from './runtime.js'
export { meshHitTest, boundaryLoops } from './hitTest.js'
export { createInteractionHints } from './hints.js'
