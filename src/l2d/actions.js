/** 动作播放 API：状态触发面板入口（playMotion）、拖拽参数机的播放回调（playLuaAction）、命中分区处理（handleHitAreas）与重置入口（resetInteraction）。读取 ctx.model / ctx.orch / ctx.runtime / ctx.lastGesture（gestures.js 写入）。 */
import { MotionPriority } from 'pixi-live2d-display/cubism4'

/**
 * @param ctx 舞台上下文（见 L2dStage.vue）；须先于 mount.js 装配并存入 ctx.actions
 * @returns {{ playMotion, idleGroupIndex, resetInteraction, playLuaAction, handleHitAreas }}
 */
export function createActions(ctx) {
  /** 引擎侧拒绝（MotionState.reserve：同动作已在播/已预留等）只静默回 false，这里补一条告警日志 */
  function watchRejection(promise, label) {
    Promise.resolve(promise).then((ok) => {
      if (!ok) console.warn('[l2d] 动作播放被引擎拒绝:', label)
    })
  }

  /** 供外部（状态触发面板）直接播放指定动作组 */
  function playMotion(group) {
    const model = ctx.model
    const orch = ctx.orch
    if (!model) return
    // 白名单/黑名单对面板触发同样生效（游戏 TriggerAction 也走 checkEnablePlay；名单存 clip 名，面板动作组与 clip 同名）
    if (orch && !orch.checkEnablePlay(group)) return
    ctx.currentMotion.value = group
    // FORCE：点击反应任何时候都可打断当前动作（与游戏内行为一致）
    // 面板是游戏内系统事件（登录/任务/回港…）的复现，属外部触发、不做点击门控（与游戏一致，如 login 的起播边界在干净默认态下也不满足）；状态转移照常入账——interaction.js 在 motionManager 的 motionStart/motionFinish 上统一跟踪所有动作，无论触发来源
    watchRejection(model.motion(group, idleGroupIndex(group), MotionPriority.FORCE), group)
  }

  // 面板触发 idle 组时按当前变体解析（游戏 SetInteger("idle") 播当前变体子状态，不是随机）；返回组内下标，查不到时 undefined 退回随机
  function idleGroupIndex(group) {
    const orch = ctx.orch
    const runtime = ctx.runtime
    if (!orch || group !== runtime?.idleGroup) return undefined
    const defs = ctx.model.internalModel.settings?.motions?.[group] ?? []
    const want = orch.idleClipFor(orch.idleIndex)
    const i = defs.findIndex(
      (d) => (d.File ?? '').split('/').pop()?.replace(/\.motion3\.json$/, '') === want,
    )
    return i >= 0 ? i : undefined
  }

  /** 重置交互状态（游戏 live2d.lua resetL2dData 的就地复位语义，存档清理即 Live2dConst.ClearLive2dSave）：清存档、机器回初始值、idle 归变体 0、白名单清空并重播基础 idle。与游戏的差异：不做屏外出屏窗（游戏出屏窗后有独立场景层兜底；查看器背景板在 moc 内，藏模型=连背景一起黑）——基础参数走 beginSmoothReset 与重播 idle 同窗滑回，全程可见 */
  function resetInteraction() {
    const model = ctx.model
    if (!model) return
    // 挂载进行中再点直接忽略（游戏 LeanTween.isTweening 守卫的等价物）
    if (ctx._mounting) return
    const orch = ctx.orch
    if (!orch && !ctx.runtime) return
    console.log('[l2d] 重置交互 -> 就地复位（游戏 resetL2dData 语义）')
    // 基础 idle 的 clip 与转场时长（无参数机皮肤退回 fades 默认窗）
    const clip = orch ? orch.idleClipFor(0) : null
    const fade = clip
      ? (ctx.fades?.transitions?.[clip] ?? ctx.fades?.default ?? 0.3)
      : (ctx.fades?.default ?? 0.3)
    // 清存档+机器回初始值+白名单清空（ClearLive2dSave + ResetL2dData）；机器加/乘分量同帧归零，被拖拽道具的回位是瞬跳（游戏同样瞬跳，只是藏在出屏窗里）
    orch?.resetAll()
    // 先清图跟踪（pending 归空）：stopAllMotions 引出的 motionFinish 会对空挂起做 applyEnd(null) 幂等空转，不会把旧动作的结束值写回复位后的节点
    ctx.runtime?.resetState()
    // 基础参数缓动滑回默认/节点值，与重播 idle 的渐入同窗；重播的 motionStart 会再开一次同窗复位（from 取当前值，幂等）
    ctx.runtime?.beginSmoothReset(fade, clip)
    // 循环 idle 永不 finish、currentGroup 常驻，重播须先停掉在播动作才能过引擎 MotionState.reserve
    model.internalModel.motionManager.stopAllMotions()
    // changeIdleIndex(0) + 强制重播基础 idle（游戏同款）
    if (orch) playLuaAction(clip)
    else {
      model.internalModel.motionManager.startRandomMotion(
        ctx.runtime.idleGroup,
        MotionPriority.FORCE,
      )
    }
  }

  /**
   * 拖拽参数机的动作播放回调：clip 名 -> 动作组解析后 FORCE 播放；白名单/黑名单在这里前置检查（游戏 checkEnablePlay 对一切播放生效），名单存的是 clip 名（touch_idle1、idle1 等），组名与 clip 名不一致时（touch_idleN 收在 touch_idle 组、idleN 收在 idle 组）按文件名反查组内下标
   * @returns {Promise<boolean>} 是否真的播了（不存在/被白名单拦下/被引擎 MotionState 拒绝——如重播正在循环的同支 idle——都返回 false）
   */
  async function playLuaAction(clipName) {
    const orch = ctx.orch
    if (!orch) return false
    if (!orch.checkEnablePlay(clipName)) {
      orch.debug?.(
        `${clipName} 被${orch.machineAble ? '机器按压(ableFlag)' : '白/黑名单'}拦下` +
        `(白名单${orch.enablePlayActions.length}项)`,
      )
      return false
    }
    const motions = ctx.model?.internalModel.settings?.motions ?? {}
    let group = null
    let index
    if (motions[clipName]) {
      group = clipName
      // 组名动作 = 游戏喂 Animator 的子状态路由，不是随机挑选：idle 组播当前变体所在的子状态（游戏 SetInteger("idle") 后播当前变体 clip），其余组按同名 clip 反查下标（如 main_1 组里的 main_1）；都查不到才退回随机
      const want =
        clipName === ctx.runtime?.idleGroup ? orch.idleClipFor(orch.idleIndex) : clipName
      const defs = motions[group] ?? []
      const i = defs.findIndex(
        (d) => (d.File ?? '').split('/').pop()?.replace(/\.motion3\.json$/, '') === want,
      )
      if (i >= 0) index = i
      // HUD 读数（ctx.idleFallback）：显式路由与引擎回落（motionPatches 写 source: 'engine*'）区分来源，变体选错时动作行旁直接可见路由依据
      if (clipName === ctx.runtime?.idleGroup) {
        ctx.idleFallback = {
          source: 'explicit',
          clip: want,
          index: i,
          variant: orch.idleIndex,
          degraded: i < 0,
          at: Date.now(),
        }
      }
    } else {
      for (const [g, defs] of Object.entries(motions)) {
        const i = (defs ?? []).findIndex(
          (d) => (d.File ?? '').split('/').pop()?.replace(/\.motion3\.json$/, '') === clipName,
        )
        if (i >= 0) {
          group = g
          index = i
          break
        }
      }
    }
    if (!group) {
      console.warn(`[l2d] 动作 ${clipName} 在模型里不存在，跳过播放`)
      ctx.orch?.debug?.(`${clipName} 组解析失败（模型里不存在）`)
      return false
    }
    ctx.currentMotion.value = group
    // 等引擎的真实结果：MotionState.reserve 拒绝（重播在循环的同支 idle、预留被抢等）只静默回 false——调用方（onActionApply）必须拿到 false 才不会把 activeData（idle 变体号/白名单）记到一次没播出去的动作上
    const ok = await ctx.model.motion(group, index, MotionPriority.FORCE)
    if (!ok) {
      console.warn('[l2d] 动作播放被引擎拒绝:', `${group}[${index}]`)
      // 拒绝原因进触发链日志：链式路由中一环播放失败、activeData 不入账时整条链静默断掉，无此日志无法定位断点
      ctx.orch?.debug?.(`${clipName} 引擎拒绝(${group}[${index}],当前=${ctx.orch?.playActionName || 'idle循环'})`)
    }
    return !!ok
  }

  /** 命中分区 -> 播放对应动作（model 'hit' 事件与 onPointerUp 精确路径共用） */
  function handleHitAreas(areas) {
    const runtime = ctx.runtime
    if (!runtime) return
    const name = runtime.firstVisibleHit(areas, ctx.lastGesture)
    const played = name && runtime.playHitMotion(name)
    if (played) ctx.currentMotion.value = played.group
  }

  return { playMotion, idleGroupIndex, resetInteraction, playLuaAction, handleHitAreas }
}
