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
 * 触发类型扩展点：updateTrigger 是 type -> handler 映射表。已实现 type 2
 * （点击，含 circle/target 切换、focus 按下即触发、target_focus 跳变）；其余
 * 类型注册为 unsupported（一次性告警）。后续按 live2ddrag.lua 的 updateTrigger
 * 逐型补齐即可，下棋小游戏（type 15/16）参照 Live2DExtend 的九宫格连线判定，
 * 等有实际皮肤再实测实现。未实现但已留好数据通路：offset_circle 圆盘拖拽、
 * react_pos_x/y 视线联动、relation_parameter 联动参数（构造已解析，step 里
 * 预留调用点）、listener_data 监听器。
 */

/** 游戏点击判定阈值（live2ddrag.lua checkClickAction）：位移 <30px 且时长 <0.5s */
const CLICK_RADIUS = 30
const CLICK_TIME = 0.5
/** 点击确认延迟：松手判定成功后 0.1s 才真正触发（游戏 clickTriggerTime） */
const CLICK_CONFIRM = 0.1
/** 数值吸附死区：与目标差 <0.05 直接贴合（游戏 updateParameterValue） */
const VALUE_EPS = 0.05

/** 加载与模型同目录的拖拽参数机配置；缺失（未烘焙/非 L2D 皮肤）返回 null */
export async function loadL2dConfig(modelUrl) {
  return fetch(modelUrl.replace(/model3\.json$/, 'l2d.json'))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
}

/**
 * 触发类型 -> 处理器映射表（扩展点：往表里加条目即接入新类型）。
 * 处理器签名 (machine, now) -> void，在 step 里每帧调用，自身负责触发条件
 * 判定（冷却由 triggerAble 统一前置过滤）。type 2（点击）不在此表：它的
 * 触发由松手判定 + clickTriggerTime 确认窗口驱动（见 onUp/step）。
 * 后续按 live2ddrag.lua 的 updateTrigger 逐型补齐：1 按压计时（按住 num 附近
 * 达 time 秒）、3 按压动作（按住 time 秒，action_list 顺序播放，last 松手收尾）、
 * 6 连点（action_list 循环 + actionListIndex 持久化）、10 动作链（isName 检测
 * 当前动画过 trigger_rate）、15/16 下棋小游戏（参照 Live2DExtend：九宫格
 * 3×3 连线判定、按 getParameterTarget() ±1 记子）等，等有实际皮肤再实测。
 */
const TRIGGER_HANDLERS = {}

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
    this.warned = false
  }

  /** 模型里是否存在本机参数（不存在则只记账不写模型，与游戏 GetCubismParameter 为 nil 一致） */
  hasParam() {
    return this.orch.paramIndex(this.parameterName) >= 0
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
   * type 2 点击触发：checkClickAction 判定成功后由 step 调到（clickTriggerTime
   * 到期窗口内）。播放 action（白名单检查在编排器 playAction 里）并应用
   * activeData；无 action 的机器（TouchDrag1/2/4/6）只做 target 切换。
   */
  applyClickTrigger() {
    this.clickTriggerTime = null
    this.orch.setMachineAble(false)
    this.triggerAction()
    this.applyTrigger()
  }

  /** 游戏触发入口（onEventCallback EVENT_ACTION_APPLY 的 action 分支） */
  applyTrigger() {
    const at = this.actionTrigger
    if (!at) return
    const activeData = this.actionTriggerActive
    // 重复 idle 豁免：目标 idle 与当前相同且未开 repeat_flag 时整个触发跳过
    // （菜单已摊开时再点摊开区无效，游戏 onEventCallback 的前置检查）
    if (activeData?.idle != null) {
      const idle = activeData.idle
      const same =
        typeof idle === 'number'
          ? idle === this.orch.idleIndex
          : Array.isArray(idle) && idle.length === 1 && idle[0] === this.orch.idleIndex
      if (same && !activeData.repeat_flag) return
    }
    // circle + target：点击把参数设到 target；已在 target 则回 startValue
    // （0↔1 图层切换的机制）
    let target = at.target ?? null
    if (at.circle != null && target != null && target === this.parameterTargetValue) {
      target = this.startValue
    }
    const action = this.filterAction(at.action)
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
    if (this.ignoreAction && playing) return
    if (this._active) return
    this._active = true
    this._downPos = pos
    this._downTime = performance.now() / 1000
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
      this.offsetDragY = this.offsetDragTargetY + (pos.y - this._downPos.y) / this.offsetY
      this.setTargetValue(this.fixTarget(this.offsetDragY))
    }
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
    // 反应动作播放中点击不触发；例外是 focus=1 且播的正是本机动作
    // （游戏 checkClickAction：未播放恒可点，播放中仅上述例外）
    const clickAllowed = this.orch.isPlaying
      ? at?.focus === 1 && this.orch.playActionName === at.action
      : true
    if (at?.down) {
      // down 型在按下时已排程，松手只收尾
    } else if (dx && dy && quick && clickAllowed) {
      // 松手判定成功，0.1s 后触发（游戏 clickTriggerTime）
      this.clickTriggerTime = now + CLICK_CONFIRM
    } else {
      this.orch.setMachineAble(false)
    }
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
    this.updatePartsSnap()
    this.saveData()
  }

  /** parts_data 档位吸附：松手时目标值贴到最近档位（游戏 updatePartsParameter） */
  updatePartsSnap() {
    if (!this.partsData) return
    const value = this.parameterTargetValue
    let best = null
    let bestDist = null
    this.partsData.forEach((part, i) => {
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
    if (v < 0 && this.dragDirect === 1) v = 0
    else if (v > 0 && this.dragDirect === 2) v = 0
    if (this.rangeAbs) v = Math.abs(v)
    if (v < this.range[0]) v = this.range[0]
    else if (this.range[1] < v) v = this.range[1]
    return v
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
      }
    }
    if (able && this.actionTrigger) {
      const handler = TRIGGER_HANDLERS[this.actionTrigger.type]
      if (handler) handler(this, now)
      else if (!this.warned && this.actionTrigger.type !== 2) {
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
  }

  /** 持久化（游戏 saveData：revert=-1 且未禁用时存目标值） */
  saveData() {
    if (this.revert === -1 && this.saveParameterFlag) {
      this.orch.saveValue(String(this.id), this.parameterTargetValue)
    }
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
    this.idleIndex = this.loadValue('__idle') ?? 0
    this.enablePlayActions = []
    this.ignorePlayActions = []
    this.machineAble = false // 有机器按下期间屏蔽动作播放（游戏 EVENT_ACTION_ABLE）
    this.isPlaying = false
    this.playActionName = ''
    this.machines = config.entries.map((e) => new DragMachine(e, this))
    // 读档：机器参数值 + 上次停留状态的白名单（游戏 loadLive2dData）
    for (const m of this.machines) m.loadSaved(this.loadValue(String(m.id)))
    const savedAction = this.loadValue('__action')
    if (this.idleIndex > 0 && savedAction) {
      const saved = this.machines.find((m) => m.id === savedAction)
      if (saved?.actionTriggerActive) this.applyActiveData(saved.id, saved.actionTriggerActive, false)
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
  machineByZone(zoneName) {
    if (!zoneName || !this.machines.length) return null
    const key = String(zoneName).toLowerCase().replace(/[^a-z0-9]/g, '')
    return (
      this.machines.find((m) => m.drawAbleName.toLowerCase().replace(/[^a-z0-9]/g, '') === key) ??
      null
    )
  }

  // ---- 指针事件分发（L2dStage 调用；返回是否被机器消费）----

  onDown(zoneName, pos) {
    const m = this.machineByZone(zoneName)
    if (!m) return false
    m.onDown(pos, this.isPlaying)
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

  /**
   * 机器触发 -> 播放动作。action 非空且真的播出去（存在 + 白名单放行）才应用
   * activeData；action 为空则直接应用（游戏"空触发"分支）。
   */
  onActionApply(machine, action, activeData) {
    if (action) {
      const played = this.playAction(action)
      if (played) this.applyActiveData(machine.id, activeData, true)
    } else {
      this.applyActiveData(machine.id, activeData, true)
    }
  }

  /** 应用 activeData：白/黑名单 + idle 变体切换（游戏 applyActiveData） */
  applyActiveData(machineId, activeData, save) {
    if (!activeData) return
    if (Array.isArray(activeData.enable)) this.enablePlayActions = activeData.enable
    if (Array.isArray(activeData.ignore)) this.ignorePlayActions = activeData.ignore
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
    // 动作起播后机器进短冷却（游戏 onListenerTrigger ON_ACTION_PLAY）
    for (const m of this.machines) {
      if (m.nextTriggerTime < 0.2) m.nextTriggerTime = 0.2
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
   * 机器参数图层：机器参数是叠加在动作求值结果之上的来源（游戏
   * AddParameterValue(param, start, mode)），挂 afterMotionUpdate 写入。
   * mode 1=Override 直接写机器值、2=Additive 叠加、3=Multiply 相乘。
   */
  applyLayer(core) {
    for (const m of this.machines) {
      if (!m.hasParam()) continue
      const idx = this.paramIndex(m.parameterName)
      const cur = core.getParameterValueByIndex(idx)
      let v
      if (m.mode === 2) v = cur + m.parameterValue
      else if (m.mode === 3) v = cur * m.parameterValue
      else v = m.parameterValue
      core.setParameterValueByIndex(idx, v)
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
    for (const m of this.machines) this.saveValue(String(m.id), null)
    this.saveValue('__idle', 0)
    this.saveValue('__action', 0)
    for (const m of this.machines) m.reset()
    this.idleIndex = 0
    this.isPlaying = false
    this.playActionName = ''
    this.enablePlayActions = []
    this.ignorePlayActions = []
  }

  /** HUD 读数：idle 变体号、白名单规模、各机器参数实时值 */
  hudInfo() {
    const parts = this.machines.map(
      (m) => `${m.parameterName}=${Number(m.parameterValue.toFixed(2))}`,
    )
    return `idle=${this.idleIndex} 白名单=${this.enablePlayActions.length}  ${parts.join('  ')}`
  }
}
