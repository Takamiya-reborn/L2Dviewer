/**
 * 游戏拖拽参数机（Lua 控制层 Live2dDrag / Live2D）的 Web 还原。
 *
 * 数据源是 bake_l2d.py 烘焙的 <id>.l2d.json（pg.ship_l2d 配置 + idle 变体表），
 * 每个条目描述一个可交互分区（draw_able_name，如 TouchIdle1/TouchDrag3）绑定
 * 的参数机：点击/拖拽驱动 parameter，按 range 钳制、smooth 平滑、松手后按
 * revert 回弹（-1 = 不回弹且持久化，游戏存 PlayerPrefs，这里存 localStorage）、
 * parts_data 档位吸附；action_trigger.type 决定触发方式，触发后播放 action
 * （可为随机数组）并应用 action_trigger_active（动作白名单/黑名单 + idle
 * 变体切换）。字段语义与控制层逻辑的对照见 azurlane.md 第 3 节。
 *
 * 与 interaction.js 状态机的关系：这套机器接管"分区 -> 动作"的路由（游戏里
 * 就是 Lua 层在做的事），命中机器分区的手势不再走 playHitMotion 的组名近似
 * 路径；interaction.json 的参数门控继续负责没有机器的分区（摸头/普通触摸等
 * C# 层路径）。白名单/黑名单对一切动作播放生效（游戏 checkEnablePlay 语义）。
 *
 * 触发类型扩展点：TRIGGER_HANDLERS 是 type -> handler 映射表。已实现 type 2
 * （点击，含 circle/target 切换、focus 按下即触发、target_focus 跳变）、
 * type 6（连点循环 action_list，与 type 2 共用 checkClickAction 点击判定，
 * 下标每次触发推进、末位回卷、跨会话持久化）、type 3（按住 time 秒顺序播
 * action_list，last 松手收尾，按下重置下标；触发瞬间临时关 ableFlag——按住
 * 屏蔽一切播放，本机自发触发的动作靠这扇窗播出）、type 4（双轴拖到 num 邻域保持
 * time 秒触发）、type 8（按住充能，delta 秒/单位）、type 9（点击时他参贴近
 * num ±0.05 才触发，参数从模型实时值读）；其余类型注册为 unsupported
 * （一次性告警）。relation_parameter 联动参数已实现 101/102（跟随拖动量
 * offsetDragX/Y，SmoothDamp 平滑）与 103（跟随 action_list 下标查
 * relation_value）；后续按 live2ddrag.lua 的 updateTrigger 逐型补齐即可，
 * 下棋小游戏（type 15/16）参照 Live2DExtend 的九宫格连线判定，等有实际皮肤
 * 再实测实现。未实现但已留好数据通路：offset_circle 圆盘拖拽、
 * react_pos_x/y 视线联动、relation 104（idle+计时）、listener_data 监听器。
 */

/** 游戏点击判定阈值（live2ddrag.lua checkClickAction）：位移 <30px 且时长 <0.5s */
const CLICK_RADIUS = 30
const CLICK_TIME = 0.5
/** 点击确认延迟：松手判定成功后 0.1s 才真正触发（游戏 clickTriggerTime） */
const CLICK_CONFIRM = 0.1
/** 数值吸附死区：与目标差 <0.05 直接贴合（游戏 updateParameterValue） */
const VALUE_EPS = 0.05

/**
 * Unity Mathf.SmoothDamp（maxSpeed 无穷）逐帧移植：relation_parameter 的
 * 联动参数用它平滑跟随拖动量，与线性 CustomSmoothValue 的手感不同——
 * 接近目标时先冲过再被阻尼拉回。vel 为速度状态（跨帧保持，存 relation 上）。
 */
function smoothDamp(current, target, vel, smoothTime, dt) {
  smoothTime = Math.max(0.0001, smoothTime)
  const omega = 2 / smoothTime
  const x = omega * dt
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  const origTarget = target
  let change = current - target
  target = current - change
  const temp = (vel + omega * change) * dt
  vel = (vel - omega * temp) * exp
  let output = target + (change + temp) * exp
  if (origTarget - current > 0 === output > origTarget) {
    output = origTarget
    vel = (output - origTarget) / dt
  }
  return [output, vel]
}

/** 目标值修正（游戏 fixParameterTargetValue）：drag_direct 方向闸门 + range_abs
    取绝对值 + range 钳制。机器与 relation 共用，参数各传 */
function fixRange(v, range, rangeAbs, dragDirect) {
  if (v < 0 && dragDirect === 1) v = 0
  else if (v > 0 && dragDirect === 2) v = 0
  if (rangeAbs) v = Math.abs(v)
  if (v < range[0]) v = range[0]
  else if (range[1] < v) v = range[1]
  return v
}

/** 加载与模型同目录的拖拽参数机配置；缺失（未烘焙/非 L2D 皮肤）返回 null */
export async function loadL2dConfig(modelUrl) {
  return fetch(modelUrl.replace(/model3\.json$/, 'l2d.json'))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
}

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
const TRIGGER_HANDLERS = {
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

/** 单台参数机，对应一条 ship_l2d 条目（游戏 Live2dDrag 类） */
export class DragMachine {
  constructor(entry, orch) {
    this.orch = orch
    this.id = entry.id
    this.drawAbleName = entry.draw_able_name || ''
    this.parameterName = entry.parameter
    this.mode = entry.mode && entry.mode !== 0 ? entry.mode : 1
    this.startValue = entry.start_value || 0
    this.range = Array.isArray(entry.range) ? entry.range : [0, 0]
    // offset = 拖动 1 单位参数所需像素数；0 视为无拖拽
    this.offsetX = entry.offset_x || 0
    this.offsetY = entry.offset_y || 0
    // 单位归一：配置值 ÷1000 = 秒
    this.smooth = (entry.smooth || 0) / 1000
    this.smoothRevert = (entry.revert_smooth || 0) / 1000
    this.revert = entry.revert === -1 ? -1 : (entry.revert || 0) / 1000
    this.ignoreReact = entry.ignore_react === 1
    this.ignoreAction = entry.ignore_action === 1
    this.dragDirect = entry.drag_direct || 0
    this.rangeAbs = entry.range_abs === 1
    this.partsData = Array.isArray(entry.parts_data?.parts) ? entry.parts_data.parts : null
    // parts_data.type：吸附方向（1/缺省=最近档位、2=只吸附 ≤ 当前值的档位、
    // 3=只吸附 ≥ 当前值的档位；充能机 type 2 配升序档位，松手落在已达档位）
    this.partsDataType = entry.parts_data?.type ?? null
    // revert_idle_index：idle 变体切到名单内时参数整体复位（true = 任意变体都
    // 复位）。bake 产物里的字符串形态（如 "1"）在游戏里同样不匹配任何分支，
    // 视为未配置
    this.revertIdleIndex = Array.isArray(entry.revert_idle_index)
      ? entry.revert_idle_index
      : entry.revert_idle_index === true
        ? true
        : null
    // relation_parameter 联动参数（游戏 _relationParameterList）：type 101/102
    // 跟随拖动量、103 跟随连点下标查 relation_value、104 idle+计时（未实现），
    // 其余跟随机器参数目标值但 enable=false 恒不写。target 有值时直写不平滑；
    // smooth/range/range_abs/drag_direct/mode 缺省回落机器自身配置
    this.relations = Array.isArray(entry.relation_parameter?.list)
      ? entry.relation_parameter.list.map((r) => ({
          type: r.type,
          name: r.name,
          start: r.start,
          target: r.target,
          smooth: r.smooth != null ? r.smooth / 1000 : null,
          range: Array.isArray(r.range) ? r.range : null,
          rangeAbs: r.range_abs === 1 ? true : null,
          dragDirect: r.drag_direct ?? null,
          mode: r.mode,
          relationValue: Array.isArray(r.relation_value) ? r.relation_value : null,
          // 运行时：平滑输出值 / SmoothDamp 速度 / 本帧是否可写
          value: r.start ?? this.startValue,
          velocity: 0,
          enable: false,
          warned: false,
        }))
      : []
    this.actionTrigger = entry.action_trigger && typeof entry.action_trigger === 'object' ? entry.action_trigger : null
    this.actionTriggerActive = entry.action_trigger_active || null
    this.revertActionIndex = entry.revert_action_index === 1
    // save_parameter=-1 不持久化；revert=-1 的机器松手即存（游戏 saveData）
    this.saveParameterFlag = entry.save_parameter !== -1
    this.limitTime = entry.limit_time > 0 ? entry.limit_time : 4

    // ---- 运行时状态（字段名对齐游戏，便于对照逆向）----
    this.parameterValue = this.startValue
    this.parameterTargetValue = this.startValue
    this.parameterStartValue = this.startValue
    this.parameterSmooth = 0
    this.parameterSmoothTime = this.smooth
    this.parameterToStart = null // 回弹倒计时（秒），null = 未启动
    this._active = false
    this._downPos = { x: 0, y: 0 }
    this._downTime = 0
    this._upPos = { x: 0, y: 0 }
    this.clickTriggerTime = null
    this.nextTriggerTime = 0 // 触发冷却
    this.isTriggerAtion = false // 动作已触发未播完标记（游戏 isTriggerAtion）
    this.offsetDragX = this.startValue
    this.offsetDragY = this.startValue
    this.offsetDragTargetX = this.startValue
    this.offsetDragTargetY = this.startValue
    // 连点循环下标（type 6，1 起；读档在编排器构造处，游戏 loadData 的
    // GetDragActionIndex or 1）
    this.actionListIndex = 1
    // type 3/4 的按压累计计时（游戏 triggerActionTime：startDrag 归零）
    this.triggerActionTime = 0
    this.warned = false
  }

  /** 模型里是否存在本机参数（不存在则只记账不写模型，与游戏 GetCubismParameter 为 nil 一致） */
  hasParam() {
    return this.orch.paramIndex(this.parameterName) >= 0
  }

  /**
   * 本机参数是否写模型（游戏 _parameterUpdateFlag）：类型白名单（2 点击 /
   * 5 idle 跟随 / 7 监听 / 8 充能 / 10 动作链 / 13 参数移动 / 14 上下行 /
   * 15 下棋）恒写；有拖拽量的机器经 updateDrag 置真。type 3/4/6/9/11/12 的
   * 参数只是内部记账（type 9 的点参判定读的就是模型实时值），写模型反而
   * 会把内部值漏到画面上
   */
  writesParam() {
    if (this.offsetX || this.offsetY) return true
    const t = this.actionTrigger?.type
    return t === 2 || t === 5 || t === 7 || t === 8 || t === 10 || t === 13 || t === 14 || t === 15
  }

  /** 触发冷却与单触发互斥（游戏 isActionTriggerAble） */
  triggerAble(dt) {
    if (!this.actionTrigger?.type) return false
    if (this.nextTriggerTime > 0) {
      this.nextTriggerTime = Math.max(0, this.nextTriggerTime - dt)
      return false
    }
    return !this.isTriggerAtion
  }

  /**
   * type 2/6/9 点击触发：checkClickAction 判定成功后由 step 调到（clickTriggerTime
   * 到期窗口内）。播放 action（白名单检查在编排器 playAction 里）并应用
   * activeData；无 action 的机器只做 target 切换。type 9 在触发前先查他参
   * 是否贴近 num（±0.05，游戏 EVENT_GET_PARAMETER 回调），不贴近则白点。
   */
  applyClickTrigger() {
    this.clickTriggerTime = null
    this.orch.setMachineAble(false)
    const at = this.actionTrigger
    if (at?.type === 9) {
      const v = this.orch.readParameter(at.parameter ?? this.parameterName)
      if (v == null || Math.abs((at.num ?? 0) - v) > 0.05) {
        this.orch.debug?.(
          `${this.parameterName} type9 他参 ${at.parameter}=${v?.toFixed?.(2) ?? v} 未贴近 ${at.num}，不触发`,
        )
        return
      }
    }
    this.applyTrigger()
  }

  /** 游戏触发入口（onEventCallback EVENT_ACTION_APPLY 的 action 分支）。
      触发冷却/连点下标的推进都按游戏 apply 块的分支顺序落账：先取本次
      action 与 activeData（type 6 从 action_list 按 actionListIndex 取并推进
      下标），再过重复 idle 豁免，最后才是 circle/target 与播放 */
  applyTrigger() {
    const at = this.actionTrigger
    if (!at) return
    let activeData = this.actionTriggerActive
    let action = null
    if (Array.isArray(at.action_list) && at.action_list.length) {
      // 连点循环（type 6）：本次播 action_list[actionListIndex]，随后下标推进、
      // 末位回卷（回卷即一轮连点完成，游戏在此收尾拖拽）；下标推进发生在
      // 重复 idle 豁免之前——被豁免跳过的触发同样消耗一次下标
      const idx = Math.min(Math.max(this.actionListIndex, 1), at.action_list.length)
      action = this.filterAction(at.action_list[idx - 1]?.action)
      const activeList = activeData?.active_list
      if (Array.isArray(activeList) && idx <= activeList.length) activeData = activeList[idx - 1] ?? null
      this.actionListIndex = idx === at.action_list.length ? 1 : idx + 1
      // revert_action_index：下标一推进，参数立刻回起始值（游戏 updateStateData
      // 的 lastActionIndex != actionListIndex 分支，隔帧生效这里就地生效）
      if (this.revertActionIndex) this.setTargetValue(this.startValue)
      if (action) this.triggerAction()
    } else if (at.action != null) {
      // action 分支（可为随机数组）；空串动作走编排器的"空触发"路径
      action = this.filterAction(at.action)
      this.triggerAction()
    } else {
      // 无 action 无 action_list（circle/target 纯开关机）：游戏同样过一遍
      // triggerAction，但立即清掉单触发标记（isTriggerAtion 不滞留）
      this.triggerAction()
      this.isTriggerAtion = false
    }
    // 重复 idle 豁免：目标 idle 与当前相同且未开 repeat_flag 时整个触发跳过
    // （菜单已摊开时再点摊开区无效，游戏 onEventCallback 的前置检查）
    if (activeData?.idle != null) {
      const idle = activeData.idle
      const same =
        typeof idle === 'number'
          ? idle === this.orch.idleIndex
          : Array.isArray(idle) && idle.length === 1 && idle[0] === this.orch.idleIndex
      if (same && !activeData.repeat_flag) {
        // TODO(临时诊断)
        this.orch.debug?.(
          `${this.parameterName} 重复idle豁免(目标${idle}==当前${this.orch.idleIndex})触发跳过`,
        )
        return
      }
    }
    // circle + target：点击把参数设到 target；已在 target 则回 startValue
    // （0↔1 图层切换的机制）
    let target = at.target ?? null
    if (at.circle != null && target != null && target === this.parameterTargetValue) {
      target = this.startValue
    }
    if (target != null) {
      this.setTargetValue(target)
      if (at.target_focus === 1) this.setParameterValue(target) // 跳变，不过平滑
    }
    if (at.focus === 1) this.isTriggerAtion = false
    // 播放与否决定 activeData 是否应用（游戏 playAction 失败即不应用）
    this.orch.onActionApply(this, action, activeData)
  }

  filterAction(action) {
    return Array.isArray(action) ? action[Math.floor(Math.random() * action.length)] : action
  }

  /** 触发冷却启动（游戏 triggerAction） */
  triggerAction() {
    this.nextTriggerTime = this.limitTime
    this.isTriggerAtion = true
  }

  // ---- 指针事件（游戏 startDrag / onDrag / stopDrag）----

  onDown(pos, playing) {
    if (this.ignoreAction && playing) {
      // TODO(临时诊断)
      this.orch.debug?.(`${this.drawAbleName} 播放中拒按(ignore_action=1)`)
      return
    }
    if (this._active) return
    this._active = true
    this._downPos = pos
    this._downTime = performance.now() / 1000
    this.triggerActionTime = 0
    // 连点下标只在 type 3（DRAG_DOWN_ACTION）按下时重置（游戏 startDrag 的
    // uv0 表只含该类型；type 6 的下标跨按压持续推进）
    if (this.actionTrigger?.type === 3) this.actionListIndex = 1
    this.parameterSmoothTime = this.smooth
    this.orch.setMachineAble(true)
    // down 型触发：按下即排程（游戏 checkClickAction 的 firstActive 分支）
    if (this.actionTrigger?.down && (this.actionTrigger.focus === 1 || !playing)) {
      this.clickTriggerTime = performance.now() / 1000
    }
  }

  onMove(pos) {
    if (!this._active) return
    if (this.offsetX) {
      this.offsetDragX = this.offsetDragTargetX + (pos.x - this._downPos.x) / this.offsetX
      this.setTargetValue(this.fixTarget(this.offsetDragX))
    }
    if (this.offsetY) {
      // 游戏用 Unity 屏幕坐标（y 向上），浏览器 y 向下——y 分量取反，
      // 否则 offset_y 型机器方向镜像（drag_direct 闸门会把"展开方向"的
      // 拖动整个钳死，实测即菜单抽屉拖不动）
      this.offsetDragY = this.offsetDragTargetY + (this._downPos.y - pos.y) / this.offsetY
      this.setTargetValue(this.fixTarget(this.offsetDragY))
    }
  }

  /** 松手收尾的基准落账（游戏 stopDrag）：把本次拖到的值经 fix 后写成
      offsetDragTarget——下次按住拖动从这里继续累加，滚动条手感就靠它 */
  commitDragBase() {
    this.offsetDragTargetX = this.fixTarget(this.offsetDragX)
    this.offsetDragTargetY = this.fixTarget(this.offsetDragY)
  }

  onUp(pos) {
    if (!this._active) return
    this._active = false
    // 回弹：revert>0 启动倒计时，平滑时间换 revert_smooth
    if (this.revert > 0) {
      this.parameterToStart = this.revert
      this.parameterSmoothTime = this.smoothRevert
    }
    const now = performance.now() / 1000
    this._upPos = pos
    const dx = Math.abs(pos.x - this._downPos.x) < CLICK_RADIUS
    const dy = Math.abs(pos.y - this._downPos.y) < CLICK_RADIUS
    const quick = now - this._downTime < CLICK_TIME
    const at = this.actionTrigger
    // 走 checkClickAction 点击判定的类型（2 点击 / 6 连点 / 9 点参）；其余
    // 类型松手只收尾（游戏里它们的 updateTrigger 分支不调 checkClickAction）
    const clickJudged = at?.type === 2 || at?.type === 6 || at?.type === 9
    // 反应动作播放中点击不触发；例外是 focus=1 且播的正是本机动作
    // （游戏 checkClickAction：未播放恒可点，播放中仅上述例外）
    const clickAllowed = this.orch.isPlaying
      ? at?.focus === 1 && this.orch.playActionName === at.action
      : true
    if (at?.down) {
      // down 型在按下时已排程，松手只收尾
    } else if (clickJudged && dx && dy && quick && clickAllowed) {
      // 松手判定成功，0.1s 后触发（游戏 clickTriggerTime）
      this.clickTriggerTime = now + CLICK_CONFIRM
      // TODO(临时诊断)
      this.orch.debug?.(`${this.parameterName} 点击判定成功,0.1s后触发`)
    } else {
      this.orch.setMachineAble(false)
      if (clickJudged) {
        // TODO(临时诊断)
        this.orch.debug?.(
          `${this.parameterName} 非点击松手` +
            (!dx || !dy ? '(位移超30px)' : '') +
            (!quick ? '(按压超0.5s)' : '') +
            (!clickAllowed ? '(反应动作播放中)' : ''),
        )
      }
    }
    // type 3 + last：松手清冷却，让收尾分支（step 的非按住路径）立即可判
    // （游戏 stopDrag -> checkResetTriggerTime 的 last 分支）
    if (at?.type === 3 && at.last) this.nextTriggerTime = 0
    this.commitDragBase()
    this.updatePartsSnap()
    this.saveData()
  }

  /** 松手取消（pointercancel）：不构成点击，直接收尾 */
  onCancel() {
    if (!this._active) return
    this._active = false
    if (this.revert > 0) {
      this.parameterToStart = this.revert
      this.parameterSmoothTime = this.smoothRevert
    }
    this.orch.setMachineAble(false)
    this.commitDragBase()
    this.updatePartsSnap()
    this.saveData()
  }

  /** parts_data 档位吸附：松手时目标值贴到档位（游戏 updatePartsParameter）。
      只对有拖拽量（offset_x/y）或 type 8 充能的机器生效；type 决定候选档位
      方向：1/缺省=最近档位、2=只取 ≤ 当前值（充能落位）、3=只取 ≥ 当前值 */
  updatePartsSnap() {
    if (!this.partsData) return
    if (!(this.offsetX || this.offsetY || this.actionTrigger?.type === 8)) return
    const value = this.parameterTargetValue
    let best = null
    let bestDist = null
    this.partsData.forEach((part, i) => {
      if (this.partsDataType === 2 && part > value) return
      if (this.partsDataType === 3 && part < value) return
      const dist = Math.abs(value - part)
      if (best === null || dist < bestDist) {
        bestDist = dist
        best = i
      }
    })
    if (best === null) return
    const snapped = this.partsData[best]
    this.offsetDragTargetX = snapped
    this.offsetDragTargetY = snapped
    if (snapped !== this.parameterTargetValue) this.setTargetValue(snapped)
  }

  /** 目标值修正：drag_direct 方向闸门 + range_abs 取绝对值 + range 钳制（游戏 fixParameterTargetValue） */
  fixTarget(v) {
    return fixRange(v, this.range, this.rangeAbs, this.dragDirect)
  }

  /** relation 版修正：relation 自带 range/range_abs/drag_direct 优先，缺省回落
      机器配置（游戏 fixRelationParameter） */
  fixRelation(r, v) {
    return fixRange(v, r.range ?? this.range, r.rangeAbs ?? this.rangeAbs, r.dragDirect ?? this.dragDirect)
  }

  setTargetValue(v) {
    this.parameterSmooth = 0
    this.parameterStartValue = this.parameterTargetValue
    this.parameterTargetValue = v
  }

  setParameterValue(v) {
    this.parameterValue = v
  }

  /** 每帧步进（游戏 stepParameter 的 updateParameterValue + checkReset + 触发调度） */
  step(dt, now, playing, playActionName) {
    this.l2dIsPlaying = playing
    this.l2dPlayActionName = playActionName
    if (this.isTriggerAtion && !playing) this.isTriggerAtion = false
    const able = this.triggerAble(dt)
    // 点击确认窗口：到期且不在冷却中才触发，过窗（>0.1s）作废（游戏里
    // checkClickAction 在 updateTrigger 内、受 isActionTriggerAble 前置过滤）
    if (this.clickTriggerTime != null && now >= this.clickTriggerTime) {
      if (able && now - this.clickTriggerTime <= CLICK_CONFIRM) this.applyClickTrigger()
      else {
        this.clickTriggerTime = null
        this.orch.setMachineAble(false)
        // TODO(临时诊断)
        this.orch.debug?.(
          `${this.parameterName} 确认窗口作废(${able ? '过窗' : `冷却中${this.nextTriggerTime.toFixed(2)}s`})`,
        )
      }
    }
    if (able && this.actionTrigger) {
      const handler = TRIGGER_HANDLERS[this.actionTrigger.type]
      if (handler) handler(this, now, dt)
      else if (
        !this.warned &&
        this.actionTrigger.type !== 2 &&
        this.actionTrigger.type !== 6 &&
        this.actionTrigger.type !== 9
      ) {
        this.warned = true
        console.warn(`[l2d] ship_l2d ${this.id}（${this.drawAbleName}）触发类型 ${this.actionTrigger.type} 未实现，已忽略`)
      }
    }
    // 回弹倒计时：归零回 startValue 并复位拖拽基准（游戏 checkReset）
    if (this.parameterToStart != null && !this._active) {
      this.parameterToStart -= dt
      if (this.parameterToStart <= 0) {
        this.parameterToStart = null
        this.setTargetValue(this.startValue)
        this.offsetDragX = this.offsetDragTargetX = this.startValue
        this.offsetDragY = this.offsetDragTargetY = this.startValue
      }
    }
    // 平滑趋近目标（游戏 updateParameterValue + Live2DExtend.CustomSmoothValue）
    if (this.parameterValue !== this.parameterTargetValue) {
      if (Math.abs(this.parameterValue - this.parameterTargetValue) < VALUE_EPS) {
        this.setParameterValue(this.parameterTargetValue)
      } else if (this.parameterSmoothTime > 0) {
        this.parameterSmooth = Math.min(this.parameterSmooth + dt, this.parameterSmoothTime)
        this.setParameterValue(
          this.parameterStartValue +
            (this.parameterTargetValue - this.parameterStartValue) *
              (this.parameterSmooth / this.parameterSmoothTime),
        )
      } else {
        this.setParameterValue(this.parameterTargetValue)
      }
    }
    this.updateRelations(dt)
  }

  /**
   * relation 联动参数逐帧求值（游戏 updateRelationValue）：type 101/102 跟随
   * 拖动量 offsetDragX/Y（按下拖动才有新值，松手后保持最后落点）、103 跟随
   * 连点下标查 relation_value、其余类型跟随机器参数目标值但恒不可写。目标
   * 值经 relation 自带修正项（缺省回落机器）钳制：有 target 直写；贴近
   * （±0.01）直接吸附；否则 SmoothDamp 平滑（smooth 缺省回落机器 smooth）
   */
  updateRelations(dt) {
    for (const r of this.relations) {
      let raw
      let enable
      if (r.type === 101) {
        raw = this.offsetDragX ?? r.start ?? this.startValue
        enable = true
      } else if (r.type === 102) {
        raw = this.offsetDragY ?? r.start ?? this.startValue
        enable = true
      } else if (r.type === 103) {
        // 游戏是 Lua 1-based 表 relation_value[actionListIndex]（live2ddrag.lua
        // updateRelationValue），JS 数组要 -1 对齐，否则初始就取到第二档、
        // 开关整体反相（shengluyisi_5 的 touch_drag20/21 图层开关）
        raw = r.relationValue?.[this.actionListIndex - 1] ?? 0
        enable = true
      } else {
        raw = this.parameterTargetValue
        enable = false
        if (!r.warned) {
          r.warned = true
          console.warn(`[l2d] ship_l2d ${this.id}（${this.drawAbleName}）relation 类型 ${r.type} 未实现，已忽略`)
        }
      }
      r.enable = enable
      if (!enable) continue
      const fixed = this.fixRelation(r, raw)
      if (r.target != null) {
        r.value = r.target
        r.velocity = 0
      } else if (Math.abs(fixed - r.value) <= 0.01) {
        r.value = fixed
        r.velocity = 0
      } else {
        ;[r.value, r.velocity] = smoothDamp(r.value, fixed, r.velocity, r.smooth ?? this.smooth, dt)
      }
    }
  }

  /** idle 变体切换回调（编排器 changeIdleIndex 里广播）：变体切到
      revert_idle_index 名单内时参数与拖拽基准整体复位（游戏 updateStateData
      的 revertIdleIndex 分支） */
  onIdleChanged(n) {
    const r = this.revertIdleIndex
    if (!(r === true || (Array.isArray(r) && r.includes(n)))) return
    this.setTargetValue(this.startValue)
    this.offsetDragX = this.offsetDragTargetX = this.startValue
    this.offsetDragY = this.offsetDragTargetY = this.startValue
  }

  /** 持久化（游戏 saveData：revert=-1 且未禁用时存目标值；type 6 另存连点下标） */
  saveData() {
    if (this.revert === -1 && this.saveParameterFlag) {
      this.orch.saveValue(String(this.id), this.parameterTargetValue)
    }
    if (this.actionTrigger?.type === 6) {
      this.orch.saveValue(`${this.id}__listIndex`, this.actionListIndex)
    }
  }

  /**
   * HUD 读数用：当前状态下命中本分区是否会有响应。纯查询（不推进冷却、
   * 不改状态），供交互点提示按真实路由着色——机器分区不走 interaction.json
   * 的参数门控，红绿必须按机器自己的触发条件判定。返回 true 可交互 /
   * false 被冷却·单触发·播放中·重复 idle 豁免挡下 / null 触发类型未实现。
   */
  interactable() {
    const at = this.actionTrigger
    if (!at?.type) return true // 纯拖拽机：按住即响应
    // 按住型（3 长按播表 / 4 双轴邻域 / 8 充能）：不冷却不单触发滞留即可响应
    if (at.type === 3 || at.type === 4 || at.type === 8) {
      return !(this.nextTriggerTime > 0 || this.isTriggerAtion)
    }
    if (at.type !== 2 && at.type !== 6 && at.type !== 9) return null
    if (this.nextTriggerTime > 0 || this.isTriggerAtion) return false
    // 反应播放中仅 focus=1 且播的正是本机动作时可点（checkClickAction 语义，
    // 数组 action 与游戏一致按不等处理）
    if (this.orch.isPlaying && !(at.focus === 1 && this.orch.playActionName === at.action)) {
      return false
    }
    // 重复 idle 豁免：目标 idle 与当前相同且未开 repeat_flag 时整个触发跳过
    const idle = this.actionTriggerActive?.idle
    if (idle != null) {
      const same =
        typeof idle === 'number'
          ? idle === this.orch.idleIndex
          : Array.isArray(idle) && idle.length === 1 && idle[0] === this.orch.idleIndex
      if (same && !this.actionTriggerActive.repeat_flag) return false
    }
    return true
  }

  /** 读档（游戏 loadData）：revert=-1 的机器恢复持久化值 */
  loadSaved(value) {
    if (this.revert === -1 && this.saveParameterFlag && value != null) {
      this.setParameterValue(value)
      this.setTargetValue(value)
      this.offsetDragX = this.offsetDragTargetX = value
      this.offsetDragY = this.offsetDragTargetY = value
    }
  }

  /** 全量复位（游戏 clearData，对应"重置交互状态"） */
  reset() {
    this.clickTriggerTime = null
    this.parameterToStart = null
    this.isTriggerAtion = false
    this.nextTriggerTime = 0
    this.actionListIndex = 1
    this.triggerActionTime = 0
    for (const r of this.relations) {
      r.value = r.start ?? this.startValue
      r.velocity = 0
      r.enable = false
    }
    this.setParameterValue(this.startValue)
    this.setTargetValue(this.startValue)
    this.offsetDragX = this.offsetDragTargetX = this.startValue
    this.offsetDragY = this.offsetDragTargetY = this.startValue
  }
}

/**
 * 编排器：持有全部机器、idle 变体号与动作白/黑名单（游戏 Live2D 类的路由面）。
 *
 * @param model pixi Live2DModel
 * @param config loadL2dConfig 的结果
 * @param playAction (clipName) => boolean 播放回调，L2dStage 提供：解析
 *                    clip 名 -> 动作组并播放（FORCE），返回是否真的播了
 */
export class DragOrchestrator {
  constructor(model, config, playAction) {
    this.model = model
    this.skinId = config.skin_id
    this.idleIndexMap = config.idle_index ?? {}
    this.playAction = playAction
    this.idleIndex = 0 // 变体号不跨会话恢复，见 machines 读档处的注释
    this.enablePlayActions = []
    this.ignorePlayActions = []
    this.machineAble = false // 有机器按下期间屏蔽动作播放（游戏 EVENT_ACTION_ABLE）
    this.isPlaying = false
    this.playActionName = ''
    this.machines = config.entries.map((e) => new DragMachine(e, this))
    // 读档：只恢复机器拖拽参数值。idle 变体号/白名单不跨会话恢复——存档里
    // 只有变体号、没有交互图状态（菜单摊开与否），刷新后恢复变体号会造出
    // "菜单没开但 touch_idle1 被重复 idle 豁免跳过"的死态（点不开菜单），
    // 游戏里两者是配套恢复的，这里拿不到后者就干脆都从干净态起步
    for (const m of this.machines) {
      m.loadSaved(this.loadValue(String(m.id)))
      // 连点下标跨会话恢复（游戏 loadData 的 GetDragActionIndex or 1）
      const listIndex = this.loadValue(`${m.id}__listIndex`)
      if (listIndex != null) m.actionListIndex = listIndex
    }
  }

  /** 参数下标缓存（机器层写值用；模型里不存在的参数返回 -1，只记账不写） */
  paramIndex(pid) {
    if (!this._idx) this._idx = new Map()
    if (!this._idx.has(pid)) {
      this._idx.set(pid, this.model.internalModel.coreModel.getParameterIndex(pid))
    }
    return this._idx.get(pid)
  }

  /**
   * 机器分区名（大小写不敏感）。两边命名风格不同：ship_l2d 的
   * draw_able_name 是驼峰（TouchDrag1），model3.json HitAreas 的 Name 是
   * 小写下划线形式（touch_drag1），hitTest 返回的是后者——比较前剔除
   * 下划线等分隔符，否则永不匹配、机器路由整体失效。
   */
  machinesForZone(zoneName) {
    if (!zoneName || !this.machines.length) return []
    const key = String(zoneName).toLowerCase().replace(/[^a-z0-9]/g, '')
    return this.machines.filter(
      (m) => m.drawAbleName.toLowerCase().replace(/[^a-z0-9]/g, '') === key,
    )
  }

  /** 同名分区的注册最早一台（兼容旧查询点；指针路由已改用 machinesForZone） */
  machineByZone(zoneName) {
    return this.machinesForZone(zoneName)[0] ?? null
  }

  /**
   * 分区可交互状态（HUD 着色）：同名分区常挂多台机器（wuzang_3 的
   * TouchDrag2 挂充能 + 双联动 + 长按 4 台），任意一台可响应即算可交互；
   * 全部被挡时红、全部类型未实现时橙
   */
  zoneInteractable(zoneName) {
    const ms = this.machinesForZone(zoneName)
    if (!ms.length) return null
    let blocked = false
    for (const m of ms) {
      const s = m.interactable()
      if (s === true) return true
      if (s === false) blocked = true
    }
    return blocked ? false : null
  }

  /** 读模型参数实时值（游戏 EVENT_GET_PARAMETER：GetCubismParameter 缺失回 0）。
      机器参数每帧经 applyLayer 写入模型，读模型即读到机器叠加后的值 */
  readParameter(pid) {
    const idx = this.paramIndex(pid)
    if (idx < 0) return 0
    return this.model.internalModel.coreModel.getParameterValueByIndex(idx)
  }

  // ---- 指针事件分发（L2dStage 调用；返回是否被机器消费）----

  /**
   * 按下命中分区：startDrag 广播给该分区的**全部**机器（游戏 onPointDown 遍历
   * drags 匹配 drawAbleName，非只第一台）——wuzang_3 的 TouchDrag2 上充能、
   * 联动、长按三套机器共享分区，靠同时按压协同；各机器自己的 ignoreAction/
   * 已激活守卫在 machine.onDown 内
   */
  onDown(zoneName, pos) {
    const ms = this.machinesForZone(zoneName)
    if (!ms.length) return false
    for (const m of ms) m.onDown(pos, this.isPlaying)
    return true
  }

  onMove(pos) {
    if (!this.machineAble) return
    for (const m of this.machines) if (m._active) m.onMove(pos)
  }

  /** @returns true 手势被机器消费（不再走 playHitMotion 旧路径） */
  onUp(zoneName, pos) {
    let consumed = false
    for (const m of this.machines) {
      if (m._active) {
        m.onUp(pos)
        consumed = true
      }
    }
    if (!consumed && this.machineByZone(zoneName)) return true
    return consumed
  }

  onCancel() {
    for (const m of this.machines) if (m._active) m.onCancel()
  }

  // ---- 动作播放路由（游戏 checkEnablePlay + playAction + applyActiveData）----

  /** 机器按压期间屏蔽反应动作（游戏 EVENT_ACTION_ABLE：按下置真，收尾/取消置假） */
  setMachineAble(able) {
    this.machineAble = able
  }

  /** 白名单/黑名单检查，对一切动作播放生效（游戏 checkEnablePlay） */
  checkEnablePlay(actionName) {
    if (this.machineAble) return false
    if (this.enablePlayActions.length && !this.enablePlayActions.includes(actionName)) return false
    if (this.ignorePlayActions.includes(actionName)) return false
    return true
  }

  /** 诊断钩子（TODO 临时诊断）：L2dStage 注入 debugHook 后，触发链关键步
      写入 tap 日志（拒按/点击判定/豁免/播放结果/名单写入） */
  debug(line) {
    this.debugHook?.(line)
  }

  /**
   * 机器触发 -> 播放动作。action 非空且真的播出去（存在 + 白名单放行）才应用
   * activeData；action 为空则直接应用（游戏"空触发"分支）。
   */
  onActionApply(machine, action, activeData) {
    if (action) {
      const played = this.playAction(action)
      // TODO(临时诊断)
      this.debug?.(
        `${machine.parameterName} 触发 ${action}` +
          ` 播放${played ? '成功' : '失败'}` +
          (Array.isArray(activeData?.enable)
            ? `,名单→${activeData.enable.length}项`
            : ',名单不变'),
      )
      if (played) this.applyActiveData(machine.id, activeData, true)
    } else {
      this.applyActiveData(machine.id, activeData, true)
    }
  }

  /** 应用 activeData：白/黑名单 + idle 变体切换（游戏 applyActiveData） */
  applyActiveData(machineId, activeData, save) {
    if (!activeData) return
    // Lua 空表经 bake 序列化成 {} 而非 []：enable/ignore 是序列名单，空表 =
    // 清空白/黑名单，游戏 setEnableActions({}) 照常落账——只认 isArray 会把
    // 收尾变体（touch_idle3/5/7/9 的 enable={}）的清空动作整个吞掉，白名单
    // 永久滞留在 touch_idle 链的 48 项上（实测即"走完状态机 touch_body 仍被拦"）
    const asList = (v) =>
      Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : null
    const enable = asList(activeData.enable)
    if (enable) this.enablePlayActions = enable
    const ignore = asList(activeData.ignore)
    if (ignore) this.ignorePlayActions = ignore
    let idle = activeData.idle ?? null
    if (Array.isArray(idle) && idle.length) {
      // 数组 idle：随机挑一个；不开 repeat_flag 时剔除当前值（游戏 applyActiveData）
      const pool = activeData.repeat_flag ? idle : idle.filter((n) => n !== this.idleIndex)
      idle = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null
    }
    if (idle != null && typeof idle === 'number' && idle !== this.idleIndex) {
      this.changeIdleIndex(idle, save)
      if (save) this.saveValue('__action', machineId)
    }
  }

  changeIdleIndex(n, save = true) {
    if (this.idleIndex === n) return
    this.idleIndex = n
    // 变体切换广播给机器：revert_idle_index 名单内的机器整体复位（游戏
    // updateStateData 的 revertIdleIndex 分支）
    for (const m of this.machines) m.onIdleChanged(n)
    if (save) {
      this.saveValue('__idle', n)
      if (n === 0) this.saveValue('__action', 0)
    }
  }

  /** idle 变体号 -> 组内 clip 名（bake 产物 idle_index 表；未收录按基础 idle） */
  idleClipFor(index) {
    return this.idleIndexMap[index] ?? this.idleIndexMap[0] ?? 'idle'
  }

  // ---- 播放状态回报（L2dStage 挂到 motionManager 事件上）----

  /**
   * @param clipName 起播的 clip 名
   * @param idle 是否 idle 组（idle 是循环氛围动作，库内循环动作永不
   *             isFinished、不产生 motionFinish，不能占用"反应动作播放中"
   *             状态——否则 isPlaying 永久滞留 true，点击触发恒被拦）
   */
  noteMotionStart(clipName, idle = false) {
    if (!idle) {
      this.isPlaying = true
      this.playActionName = clipName
    }
    // 动作起播后机器进短冷却（游戏 onListenerTrigger ON_ACTION_PLAY）：游戏
    // 是无条件覆写 nextTriggerTime = min(limitTime, 0.2)——触发时先设的
    // limitTime（默认 4s）冷却会被真正播出的动作塌缩回 0.2s，只在"触发被
    // 重复 idle 豁免/播放失败"等不产出 ON_ACTION_PLAY 的场合才足额生效。
    // 若只抬高不清零，触发过的分区会死满 4s（实测即"绿色却点不动"）。
    // 游戏只在 Lua 层动作播出（apply 处理器）时通知，idle 循环重启不算
    if (!idle) {
      for (const m of this.machines) {
        m.nextTriggerTime = Math.min(m.limitTime, 0.2)
      }
    }
  }

  noteMotionFinish() {
    this.isPlaying = false
    this.playActionName = ''
  }

  // ---- 每帧驱动与参数图层 ----

  step(dt) {
    for (const m of this.machines) m.step(dt, performance.now() / 1000, this.isPlaying, this.playActionName)
  }

  /**
   * 机器参数图层（游戏 AddParameterValue/ChangeParameterData 的叠加源）：
   * mode 1=Override 直接写机器值、2=Additive 叠加、3=Multiply 相乘。
   * relation 联动参数随后写入（游戏对 enable 的 relation 逐帧
   * ChangeParameterData，mode 缺省回落机器 mode）。
   *
   * 引擎的 save/loadParameters 会把本层写入滞留到下一帧（见
   * Cubism4InternalModel.update：save 在 afterMotionUpdate 之后、load 在帧尾），
   * 动作曲线没覆盖的 additive/multiply 参数会逐帧累积——游戏端是"每帧先还原
   * 参数再叠加"，这里对齐成两阶段：beforeMotionUpdate 先撤掉上帧叠加还原底值，
   * afterMotionUpdate 取（动作求值后的）干净底重新叠加。model3 里没有的参数
   * 不入层（游戏 GetCubismParameter nil 时同样不落）。
   */
  layerEntries() {
    if (!this._layer) {
      this._layer = []
      for (const m of this.machines) {
        if (m.hasParam() && m.writesParam()) {
          this._layer.push({ idx: this.paramIndex(m.parameterName), m, r: null, base: 0, additive: m.mode !== 1, inited: false })
        }
        for (const r of m.relations) {
          const idx = this.paramIndex(r.name)
          if (idx >= 0) {
            const mode = r.mode ?? m.mode
            this._layer.push({ idx, m, r, base: 0, additive: mode !== 1, inited: false })
          }
        }
      }
    }
    return this._layer
  }

  /** 叠加层阶段一（挂 beforeMotionUpdate）：撤掉上帧叠加，还原动作求值的底 */
  restoreLayer(core) {
    for (const e of this.layerEntries()) {
      if (!e.additive || !e.inited) continue
      if (e.r && !e.r.enable) continue
      core.setParameterValueByIndex(e.idx, e.base)
    }
  }

  /** 叠加层阶段二（挂 afterMotionUpdate）：取干净底重新叠加 */
  applyLayer(core) {
    for (const e of this.layerEntries()) {
      const v = e.r ? e.r.value : e.m.parameterValue
      if (e.r && !e.r.enable) continue
      const cur = core.getParameterValueByIndex(e.idx)
      const mode = e.r ? (e.r.mode ?? e.m.mode) : e.m.mode
      let out
      if (mode === 2) out = cur + v
      else if (mode === 3) out = cur * v
      else out = v
      core.setParameterValueByIndex(e.idx, out)
      if (e.additive) {
        e.base = cur
        e.inited = true
      }
    }
  }

  // ---- 持久化（localStorage 模拟 PlayerPrefs）----

  saveValue(key, value) {
    try {
      localStorage.setItem(`l2d_${this.skinId}_${key}`, JSON.stringify(value))
    } catch { /* 隐私模式等场景写入失败可忽略 */ }
  }

  loadValue(key) {
    try {
      const raw = localStorage.getItem(`l2d_${this.skinId}_${key}`)
      return raw == null ? null : JSON.parse(raw)
    } catch {
      return null
    }
  }

  /** 全量复位（游戏 ClearLive2dSave）：清存档、机器回 startValue、idle 归零、白名单清空 */
  resetAll() {
    for (const m of this.machines) {
      this.saveValue(String(m.id), null)
      this.saveValue(`${m.id}__listIndex`, null)
    }
    this.saveValue('__idle', 0)
    this.saveValue('__action', 0)
    for (const m of this.machines) m.reset()
    this.idleIndex = 0
    this.isPlaying = false
    this.playActionName = ''
    this.enablePlayActions = []
    this.ignorePlayActions = []
  }

  /** HUD 读数：idle 变体号、白名单规模、按住中的机器、各机器参数实时值、
      relation 联动参数实时值 */
  hudInfo() {
    const active = this.machines.find((m) => m._active)
    const parts = this.machines.map(
      (m) => `${m.parameterName}=${Number(m.parameterValue.toFixed(2))}`,
    )
    const rels = []
    for (const m of this.machines) {
      for (const r of m.relations) {
        if (!rels.some((s) => s.startsWith(`${r.name}=`))) {
          rels.push(`${r.name}=${Number(r.value.toFixed(2))}`)
        }
      }
    }
    return (
      `idle=${this.idleIndex} 白名单=${this.enablePlayActions.length}` +
      `${active ? ` 按住:${active.drawAbleName}` : ''}  ` +
      [...parts, ...rels].join('  ')
    )
  }
}
