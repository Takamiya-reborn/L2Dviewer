/**
 * 触发类型 -> 处理器映射表（扩展点：往表里加条目即接入新类型）。
 * 处理器签名 (machine, now, dt) -> void，在 step 里每帧调用，自身负责触发
 * 条件判定（冷却由 triggerAble 统一前置过滤）。type 2/6/9（点击/连点/点参）
 * 不在此表：它们的触发由松手判定 + clickTriggerTime 确认窗口驱动（见
 * onUp/applyClickTrigger），与游戏 checkClickAction 对三种类型共用的行为一致。
 * 后续按 live2ddrag.lua 的 updateTrigger 逐型补齐：10 动作链（isName 检测
 * 当前动画过 trigger_rate）、14 区间上下行触发、15/16 下棋小游戏（参照
 * Live2DExtend：九宫格 3×3 连线判定、按 getParameterTarget() ±1 记子）等，
 * 等有实际皮肤再实测。
 */
export const TRIGGER_HANDLERS = {
  /** type 1 DRAG_TIME_ACTION（DD:1006-1021）：按住且参数现值进 num 邻域
      （|parameterValue-num| < |num|*0.25，用当前值、不做 fix）持续 time 秒
      触发。time/num 缺省回落 action_list 当前项（DD:992-1004，Lua 1-based
      取 -1）。triggerActionTime 触发后不清零（全库仅 startDrag 归零，
      DD:246），防重发靠冷却+单触发双闸，按住不松会按 limitTime 节奏重复
      触发；离开邻域不累计也不清零。回调实参恒 nil（CT:269/305），
      ON_ACTION_DRAG_TRIGGER 死路径不移植 */
  1(m, now, dt) {
    if (!m._active) return
    const at = m.actionTrigger
    const item = Array.isArray(at.action_list)
      ? at.action_list[Math.min(Math.max(m.actionListIndex, 1), at.action_list.length) - 1]
      : null
    const time = at.time ?? item?.time ?? 0
    const num = at.num ?? item?.num
    if (num == null) return // 原文只 print("缺少参数 num")，无副作用
    if (Math.abs(m.parameterValue - num) < Math.abs(num) * 0.25) {
      m.triggerActionTime += dt
      if (time < m.triggerActionTime && !m.l2dIsPlaying) m.applyTrigger()
    }
  },
  /** type 5 DRAG_RELATION_IDLE（DD:1097-1104）：每帧（受冷却闸、无按压要求）
      const_fit 逐项——当前变体等于 entry.idle 且未播放 → setTargetValue
      （原文不做 fix），多项命中全执行。每帧重设清平滑进度（游戏 setTargetValue
      同款），实际两帧内贴住目标。本型从不调 triggerAction，冷却只来自 PLAY 塌缩 */
  5(m) {
    const fit = m.actionTrigger.const_fit
    if (!Array.isArray(fit) || m.l2dIsPlaying) return
    for (const e of fit) {
      if (m.orch.idleIndex === e.idle) m.setTargetValue(e.target)
    }
  },
  /** type 3 DRAG_DOWN_ACTION：按住 time 秒（无 time 时取 action_list 当前项的
      time）顺序播 action_list；按住期间逐项推进，松手时若下标已离开 1 且配置
      last，跳到列表末项播收尾动作（apply 内末位回卷）。按压计时用 _downTime，
      每次触发后重置——长按循环播完整个列表 */
  3(m, now) {
    if (m._active) {
      // 游戏按住期间每帧 setAbleWithFlag(true)（updateTrigger 的冷却 gate 与
      // 本处一致：冷却中到不了这里）。ableFlag 屏蔽一切动作播放，但按住触发的
      // 动作要播出，靠触发瞬间临时开窗（见下）
      m.orch.pressLock(`type3 按住 ${m.drawAbleName}`, true)
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
        m.orch.pressLock('type3 开窗', false)
        m.applyTrigger()
        // 游戏触发后即清单触发标记（下标 ≠1 时），让下一项可继续触发
        if (m.actionListIndex !== 1) m.isTriggerAtion = false
        m.orch.pressLock('type3 开窗毕', true)
        m._downTime = now
      }
    } else if (m.actionTrigger.last && m.actionListIndex !== 1) {
      // 松手收尾：跳到末项播收尾动作，随后立即清冷却与单触发标记
      // （游戏 checkResetTriggerTime 的 last 分支 + 松手分支，DD:1067-1073）
      m.orch.pressLock('type3 收尾', false)
      m.actionListIndex = m.actionTrigger.action_list.length
      m.applyTrigger()
      m.nextTriggerTime = 0
      m.isTriggerAtion = false
    } else {
      // 松手后的常规解锁（DD:1074-1076 else 分支）——移植版此前缺失，
      // 按住触发改锁后松手锁会滞留
      m.orch.pressLock(`type3 松手后 ${m.drawAbleName}`, false)
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
  /** type 12 DRAG_EXTEND_ACTION_RULE（DD:1175-1178）：一次性置 extendActionFlag
      （原文永不清理，移植在 reset 清）。本机不是触发器而是动作过滤门：裁决在
      控制层 checkEnablePlay（CT:176-188）里先于白/黑名单查询
      checkActionInExtend——shengluyisi_5 用它屏蔽系统动作 */
  12(m) {
    m.extendActionFlag = true
  },
  /** type 8 DRAG_DOWN_TOUCH：按住充能，每帧 target += dt/delta（delta 秒/单位），
      经 fix 钳制；按压期间保持机器可拖标记（游戏 setAbleWithFlag(_active)，
      DD:1114 同样每帧覆写、同样被冷却闸压制——多机共享锁的覆写冲突是原文
      结构性形态，非移植缺陷） */
  8(m, now, dt) {
    m.orch.pressLock(`type8 ${m.drawAbleName}${m._active ? ' 按住' : ' 松开'}`, m._active)
    if (m._active) {
      m.setTargetValue(m.fixTarget(m.parameterTargetValue + dt / (m.actionTrigger.delta || 1)))
    }
  },
}
