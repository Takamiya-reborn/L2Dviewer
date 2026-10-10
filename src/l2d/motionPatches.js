/**
 * pixi-live2d-display 动作库补丁（安装一次，幂等）：渐变归零、尊重 Meta.Loop、
 * idle 确定性选支。补丁运行时读 activeCtx.orch / activeCtx.runtime——每次
 * 舞台挂载调用 installMotionPatches(ctx) 更新 activeCtx（L2dStage 被 App.vue
 * 按 :key 逐皮肤整体重挂，补丁单例必须跟随当前活动舞台，见 activeCtx 注释）。
 */
import { Ticker } from 'pixi.js'
import { Cubism4MotionManager, Live2DModel, config } from 'pixi-live2d-display/cubism4'

let installed = false
// 当前活动舞台上下文：App.vue 对 L2dStage 用 :key 逐皮肤整体重挂（每次切
// 皮肤都是全新挂载，用户要求的无状态独立），每次重挂都是**新 ctx**——而本
// 模块的补丁是原型级单例（installed 幂等，只装一次），闭包里不能捕获首个
// ctx，必须经 activeCtx 跟随当前活动舞台。否则皮肤切换后回落读的是死挂载
// 的 ctx.orch（idleIndex 停在旧会话）——实测即"切皮肤回来特殊待机退化成
// 基础 idle"（机器行 idle=4，实际播的是组内下标 4 的 idle.motion3.json）
let activeCtx = null

/**
 * @param ctx 舞台上下文（见 L2dStage.vue）：orch/runtime 在模型挂载时回填。
 *            每次舞台挂载调用一次：首次安装补丁，其后仅更新 activeCtx
 */
export function installMotionPatches(ctx) {
  activeCtx = ctx
  if (installed) return
  installed = true

  Live2DModel.registerTicker(Ticker)

  /**
   * 动作硬切：碧蓝航线的 motion3.json 全部没有声明 FadeInTime/FadeOutTime，
   * 游戏内也是硬切。而 pixi-live2d-display 会对缺省值回退到
   * config.motionFadingDuration=500ms / idleMotionFadingDuration=2000ms 的渐变，
   * 渐变期间两套动作对图层开关参数（heiping、dianjikyc、Limit_box、All_Size 等）
   * 各自按权重输出，产生半透明道具、错位缩放等穿模/残影，故归零改为硬切。
   */
  config.motionFadingDuration = 0
  config.idleMotionFadingDuration = 0

  /**
   * 尊重 motion3.json 的 Meta.Loop：本库 CubismMotion.parse 不读取该字段
   * （只暴露 setLoop setter），导致 idle/login 播完一遍后随机重启另一支 idle，
   * 且重启瞬间两套姿态混合。改为循环后同支 idle 无缝衔接，行为与游戏内一致。
   */
  const createMotion = Cubism4MotionManager.prototype.createMotion
  Cubism4MotionManager.prototype.createMotion = function (data, group, definition) {
    const motion = createMotion.call(this, data, group, definition)
    if (data?.Meta?.Loop) motion.setIsLoop(true)
    return motion
  }

  /**
   * idle 确定性选支：库内的空闲回退走 startRandomMotion，用 Math.random 从组里
   * 随机挑一支。idle 循环播放（见 createMotion 补丁）后，随机只发生在回落瞬间
   * ——触发动作播完后随机换一支 idle 变体，其姿态假定与状态机遗留的开关参数
   * （摊开的菜单、手持道具等）冲突，模型会跳进一个与当前状态不符的动作。
   * 游戏内触发反应结束后回到基础待机，状态参数靠跨动作保留维持（菜单保持
   * 摊开直到收尾分支），这里同样确定性回落：idle 组恒取"文件名与组同名"的
   * 那支（idle.motion3.json，无则第 0 支）；其余组（触发面板的随机播放）
   * 仍走库内随机。
   *
   * 分支挂起（节点非中性）期间不回落 idle：游戏在 OnFinishAnim(0) 进入等待
   * 输入后保持最后一帧姿态，摊开的菜单等维持原状，直到分支由后续手势收尾；
   * 若照库内默认立刻重启 idle，motionStart 的 resetParameters 会把非状态参数
   * 清回默认，姿态当场回正、摊开的菜单消失（实测即"背景立刻回正"）。节点
   * 回到中性（收尾分支播完）后这里重新放行 idle。
   */
  const startRandomMotion = Cubism4MotionManager.prototype.startRandomMotion
  Cubism4MotionManager.prototype.startRandomMotion = function (group, priority) {
    if (group === this.groups.idle) {
      // 有拖拽参数机时，idle 变体号由机器触发链维护（游戏 changeIdleIndex：
      // Animator SetInteger("idle")），回落恒取当前变体；节点非中性（菜单摊开
      // 等状态残留）正是变体姿态的前提，不再拦截
      if (activeCtx.orch) {
        const defs = this.definitions[group] ?? []
        const clip = activeCtx.orch.idleClipFor(activeCtx.orch.idleIndex)
        const base = defs.findIndex(
          (d) => (d.File ?? '').split('/').pop() === `${clip}.motion3.json`,
        )
        // 回落选支读数：变体号/解析出的 clip/组内下标，负数（文件名没对上）
        // 会 Math.max 退化到下标 0（基础 idle）——正是"变体姿态错乱"的直接信号
        const index = Math.max(base, 0)
        // 读数进 HUD（ctx.idleFallback，hud.js 汇编）：路径上的机器排查不依赖 console
        activeCtx.idleFallback = {
          source: 'engine',
          clip,
          index,
          variant: activeCtx.orch.idleIndex,
          degraded: base < 0,
          at: Date.now(),
        }
        console.log(
          `[l2d:idle] 回落→${clip} 下标${index}${base < 0 ? '（文件名未命中,退化基础idle）' : ''}`,
        )
        const playing = this.startMotion(group, index, priority)
        Promise.resolve(playing).then((ok) => {
          if (!ok) console.warn('[l2d:idle] 回落被引擎拒绝:', clip, '下标', index)
        })
        return playing
      }
      if (activeCtx.runtime && !activeCtx.runtime.isNeutral()) return Promise.resolve(false)
      const defs = this.definitions[group] ?? []
      const base = defs.findIndex(
        (d) => (d.File ?? '').split('/').pop() === `${group}.motion3.json`,
      )
      // ctx.orch 缺失分支的读数：按组名文件反查（idle.motion3.json 在
      // fulici_2 组内下标 4）——实机上"机器行 idle=4 却播基础 idle"时
      // 动作行显示的正是这一支，若无此读数会误判成变体解析失败
      activeCtx.idleFallback = {
        source: 'engine-noorch',
        clip: group,
        index: Math.max(base, 0),
        variant: null,
        degraded: base < 0,
        at: Date.now(),
      }
      return this.startMotion(group, Math.max(base, 0), priority)
    }
    return startRandomMotion.call(this, group, priority)
  }
}
