/**
 * 触发类型 -> 处理器映射表（扩展点：往表里加条目即接入新类型）。
 * 处理器签名 (machine, now, dt) -> void，在 step 里每帧调用，自身负责触发
 * 条件判定（冷却由 triggerAble 统一前置过滤）。type 2/6/9（点击/连点/点参）
 * 不在此表：它们的触发由松手判定 + clickTriggerTime 确认窗口驱动（见
 * onUp/applyClickTrigger），与游戏 checkClickAction 对三种类型共用的行为一致。
 * 后续按 live2ddrag.lua 的 updateTrigger 逐型补齐：1 按压计时（按住 num 附近
 * 达 time 秒）、5 idle 常量跟随（const_fit 查表贴值）、10 动作链（isName 检测
 * 当前动画过 trigger_rate）、12 扩展规则（参数在 num 范围内时对 ignore/enable
 * 名单生效，shengluyisi_5 用它屏蔽系统动作）、14 区间上下行触发、15/16 下棋
 * 小游戏（参照 Live2DExtend：九宫格 3×3 连线判定、按 getParameterTarget()
 * ±1 记子）等，等有实际皮肤再实测。
 */
export const TRIGGER_HANDLERS = {
  /** type 3 DRAG_DOWN_ACTION：按住 time 秒（无 time 时取 action_list 当前项的
      time）顺序播 action_list；按住期间逐项推进，松手时若下标已离开 1 且配置
      last，跳到列表末项播收尾动作（apply 内末位回卷）。按压计时用 _downTime，
      每次触发后重置——长按循环播完整个列表 */
  3(m, now) {
    if (m._active) {
      // 游戏按住期间每帧 setAbleWithFlag(true)（updateTrigger 的冷却 gate 与
      // 本处一致：冷却中到不了这里）。ableFlag 屏蔽一切动作播放，但按住触发的
      // 动作要播出，靠触发瞬间临时开窗（见下）
      m.orch.setMachineAble(true)
      if (m.l2dIsPlaying) return
      const list = m.actionTrigger.action_list
      const item = Array.isArray(list)
        ? list[Math.min(Math.max(m.actionListIndex, 1), list.length) - 1]
        : null
      const hold = m.actionTrigger.time ?? item?.time ?? 0
      if (now - m._downTime >= hold) {
        // ableFlag 开窗（游戏 setAbleWithFlag(false) → EVENT_ACTION_APPLY →
        // setAbleWithFlag(true)）：按住屏蔽的是其余一切播放路径，本机自发触发
        // 的动作必须能过 checkEnablePlay——wuzang_3 的充能姿势 touch_drag2
        // 就是在这扇窗里播出的。applyTrigger 同步走 playAction，窗口内完成
        m.orch.setMachineAble(false)
        m.applyTrigger()
        // 游戏触发后即清单触发标记（下标 ≠1 时），让下一项可继续触发
        if (m.actionListIndex !== 1) m.isTriggerAtion = false
        m.orch.setMachineAble(true)
        m._downTime = now
      }
    } else if (m.actionTrigger.last && m.actionListIndex !== 1) {
      // 松手收尾：跳到末项播收尾动作，随后立即清冷却与单触发标记
      // （游戏 checkResetTriggerTime 的 last 分支 + 松手分支）
      m.actionListIndex = m.actionTrigger.action_list.length
      m.applyTrigger()
      m.nextTriggerTime = 0
      m.isTriggerAtion = false
    }
  },
  /** type 4 DRAG_RELATION_XY：按住拖动，双轴都进 num 邻域（容差 |num|·25%）
      持续 time 秒触发。计时器 startDrag 归零、离开邻域不累计（不清零，与
      游戏一致） */
  4(m, now, dt) {
    if (!m._active || m.l2dIsPlaying) return
    const num = m.actionTrigger.num
    if (!Array.isArray(num) || num.length < 2) return
    const nearX =
      Math.abs(m.fixTarget(m.offsetDragX) - num[0]) <= Math.abs(num[0]) * 0.25
    const nearY =
      Math.abs(m.fixTarget(m.offsetDragY) - num[1]) <= Math.abs(num[1]) * 0.25
    if (nearX && nearY) {
      m.triggerActionTime += dt
      if ((m.actionTrigger.time ?? 0) < m.triggerActionTime) m.applyTrigger()
    }
  },
  /** type 8 DRAG_DOWN_TOUCH：按住充能，每帧 target += dt/delta（delta 秒/单位），
      经 fix 钳制；按压期间保持机器可拖标记（游戏 setAbleWithFlag(_active)） */
  8(m, now, dt) {
    m.orch.setMachineAble(m._active)
    if (m._active) {
      m.setTargetValue(m.fixTarget(m.parameterTargetValue + dt / (m.actionTrigger.delta || 1)))
    }
  },
}
