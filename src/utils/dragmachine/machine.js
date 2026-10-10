/**
 * 单台拖拽参数机（游戏 Live2dDrag 类的 Web 还原）。模块级约定与触发类型
 * 总览见同目录 index.js 头注释；触发处理器表在 triggers.js。
 *
 * == 状态变量契约（属主 × 写入点 × 复位责任） ==
 * 改任何状态前先查这张表：跨域残留类 bug 的根因几乎都是"绕过属主直改"
 * 或"漏了某条路径的复位"。行末标注原文依据（live2ddrag.lua = DD）。
 *
 * | 变量               | 写入点（复位责任见末列）                      | 复位时机                     |
 * | _active            | onDown 置真；onUp/onCancel/stopDragIfApply 置假 | reset                        |
 * | clickTriggerTime   | onDown(down型)/onUp 判定成功置；applyClickTrigger/step 作废清 | reset        |
 * | nextTriggerTime    | triggerAction 置 limitTime；noteMotionStart 塌缩 0.2；type3+last（onUp/stopDragIfApply/checkResetTriggerTime）与 type3 松手清零 | step 递减 / reset |
 * | isTriggerAtion     | triggerAction 置真；无 action 分支/focus=1/type3 下标≠1/step !playing 清——step 每帧 !playing 即清是刻意偏离（原文只在状态广播释放 DD:1389，播放失败会滞留到下次广播，移植版取更宽容语义，不改） | reset |
 * | parameterToStart   | onUp/onCancel（revert>0）置；step 归零并回 startValue | reset                     |
 * | parameterSmoothTime| onDown=smooth；onUp/onCancel=smoothRevert；reset=smooth | reset（跨域残留防回归点） |
 * | actionListIndex    | onDown(type3)/applyTrigger 推进回绕/onListenerEvent 命中/loadSaved | reset / clearData |
 * | triggerActionTime  | onDown 归零；type 1/4 累加（触发不清零，防重发靠双闸 DD:246） | reset |
 * | extendActionFlag   | type12 handler 置真（一次性）                  | reset                        |
 * | offsetDragX/Y/TargetX/Y | onMove 累加；commitDragBase 落账；updatePartsSnap 吸附覆盖；step(checkReset)/onIdleChanged/loadSaved/reset 回 startValue | 各自路径 + reset |
 * | relations[].value/velocity/enable | updateRelations 每帧             | reset                        |
 *
 * 按压锁 machineAble 属主在编排器（orchestrator.pressLock），本文件禁止直改。
 */
import { TRIGGER_HANDLERS } from './triggers.js'

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
    // 联动层数据（游戏 live2ddrag.lua 的 listenerType/listenerChange/listenerApply）：
    // {type, change: [[kind, matchList, value, listIndex?]], apply: [kind, ranges]}
    this.listenerData = entry.listener_data && typeof entry.listener_data === 'object' ? entry.listener_data : null
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
    this.extendActionFlag = false // type 12 扩展门置位（游戏 extendActionFlag）
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
    // 不广播 DRAG_CLICK：游戏 checkClickAction 成功回调的 onEventNotice
    // （ON_ACTION_DRAG_CLICK）实参恒为 nil（live2d.lua CT:269/305 slot5(slot12)，
    // slot12 从未赋值），监听层永远收不到——click_cd 冷却与 listener_data
    // type 2 在原文是死路径，本地三模型配置也零使用。真路径只有 PLAY（CT:288）
    // 与 CHANGE_IDLE（changeIdleIndex），见 orchestrator.notice
    this.orch.pressLock(`点击确认 ${this.drawAbleName}`, false)
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

  /** 游戏按住期间的收尾豁免（isApplyStopDrag DD:543）：仅 type 14
      （DRAG_MOVE_DOWN_UP）为 false，本型未移植，恒可收尾 */
  isApplyStopDrag() {
    return this.actionTrigger?.type !== 14
  }

  /**
   * 游戏触发收尾（apply 块三分支的 slot11，DD:424-428/443-484）：按压中
   * 触发即松开拖拽——单 action 触发、action_list 回绕、无 action 触发三处
   * 调用；action_list 非回绕推进不调。未按压 no-op（游戏 stopDrag 整体被
   * _active 包裹，DD:257）。尾部对齐游戏 stopDrag（DD:256-280）：回弹倒计时、
   * type3+last 清冷却（checkResetTriggerTime）、拖拽基准落账、档位吸附、存档；
   * 不动按压锁——游戏靠下一帧 updateTrigger 松手分支解锁（DD:1074-1076）
   */
  stopDragIfApply() {
    if (!this.isApplyStopDrag() || !this._active) return
    this._active = false
    if (this.revert > 0) {
      this.parameterToStart = this.revert
      this.parameterSmoothTime = this.smoothRevert
    }
    if (this.actionTrigger?.type === 3 && this.actionTrigger.last) this.nextTriggerTime = 0
    this.commitDragBase()
    this.updatePartsSnap()
    this.saveData()
  }

  /** 游戏触发入口（onEventCallback EVENT_ACTION_APPLY 的 action 分支）。
      触发冷却/连点下标的推进都按游戏 apply 块的分支顺序落账：先取本次
      action 与 activeData（type 6 从 action_list 按 actionListIndex 取并推进
      下标），再过重复 idle 豁免，最后才是 circle/target 与播放（async：等待
      引擎真实播放结果后才应用 activeData） */
  async applyTrigger() {
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
      // 回绕即一轮完成：slot11 收尾松开拖拽（DD:461-467，非回绕推进不调）
      if (idx === at.action_list.length) this.stopDragIfApply()
    } else if (at.action != null) {
      // action 分支（可为随机数组）；空串动作走编排器的"空触发"路径
      action = this.filterAction(at.action)
      this.triggerAction()
      this.stopDragIfApply()
    } else {
      // 无 action 无 action_list（circle/target 纯开关机）：游戏同样过一遍
      // triggerAction，但立即清掉单触发标记（isTriggerAtion 不滞留）
      this.triggerAction()
      this.isTriggerAtion = false
      this.stopDragIfApply()
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
// debug 读数：触发链关键步，debugHook 接线见 l2d/mount.js
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
    await this.orch.onActionApply(this, action, activeData)
  }

  filterAction(action) {
    return Array.isArray(action) ? action[Math.floor(Math.random() * action.length)] : action
  }

  /**
   * 联动层（游戏 live2ddrag.lua onListenerEvent）：编排器把事件扇给全部
   * 机器，这里分两段——
   * ① 冷却副作用：原文 onListenerTrigger 还有 DRAG_CLICK → click_cd 名单
   *    自封 limitTime 冷却一条（DD:207-209），但该通知在原文是死路径
   *    （EVENT_ACTION_APPLY 成功回调实参恒 nil，CT:269/305，见
   *    applyClickTrigger 注释），不移植。PLAY 的 min(limitTime,0.2) 塌缩在
   *    编排器 noteMotionStart 统一做（覆盖非机器路径，实测定案），不在此重复。
   * ② listenerType 匹配的机器才继续：change 名单按事件类型取校验名
   *    （PLAY=动作名 / CHANGE_IDLE=变体号，区分大小写与数字/字符串）做
   *    contains 命中 → kind 1 相对增量（target += value）、kind 2 绝对赋值
   *    （target = value，数据定案：kind1 全是 ±Δ 计数/充能条，kind2 是
   *    分区→档位阶梯与置位/清零对），过 fixTarget 钳制；命中即复位连点
   *    下标（第 4 元缺省 1——配置从未写过第 4 元，缺省复位是真实副作用）。
   *    listener_data.type 2（DRAG_CLICK）随通知死路径一并失效，不再接受。
   *    change_focus=false 的暂存分支配置零使用，未移植。
   * ③ apply 段（kind 1 全库仅 20703701 用）：target 落进区间 [low,high) →
   *    整包 {idle, activeData} 交编排器 applyActiveData（游戏
   *    EVENT_CHANGE_IDLE_INDEX 处理器），idle_enable/idle_ignore 按该变体
   *    取名单后再切 idle。多区间命中取最后一条、目标 idle 与当前变体相同
   *    时整个事件不发（enable/ignore 一并跳过，DD:183-193）。
   */
  onListenerEvent(type, data) {
    const ld = this.listenerData
    if (!ld || ld.type !== type) return
    const checkName = type === 1 ? data.action : type === 3 ? data.idle : undefined
    if (checkName == null) return
    let changed = false
    for (const ch of ld.change ?? []) {
      if (!Array.isArray(ch?.[1]) || !ch[1].includes(checkName)) continue
      this.setTargetValue(this.fixTarget(ch[0] === 1 ? this.parameterTargetValue + ch[2] : ch[2]))
      changed = true
      const listIndex = ch.length >= 4 ? ch[3] : 1
      if (listIndex > 0) this.actionListIndex = listIndex
// debug 读数：触发链关键步，debugHook 接线见 l2d/mount.js
      this.orch.debug?.(
        `${this.parameterName} 联动 type${type} 命中[${checkName}] kind${ch[0]} ${ch[2]} → target ${this.parameterTargetValue}`,
      )
    }
    if (!changed) return
    const apply = ld.apply
    if (!Array.isArray(apply) || apply[0] !== 1) return
    // 多区间命中取最后一条（DD:187-191 循环覆写不 break）；目标 idle 与当前
    // 变体相同时整个 EVENT_CHANGE_IDLE_INDEX 不发——enable/ignore 落账一并
    // 跳过（DD:193 守卫），不是"切了没效果"而是"根本没切"
    let hit = null
    for (const range of apply[1] ?? []) {
      const [low, high, idle] = range
      if (this.parameterTargetValue >= low && this.parameterTargetValue < high) hit = idle
    }
    if (hit != null && hit !== this.orch.idleIndex) {
      this.orch.debug?.(`${this.parameterName} 联动 apply 命中 → idle ${hit}`)
      this.orch.applyActiveData(this.id, this.actionTriggerActive, true, hit)
    }
  }

  /** 触发冷却启动（游戏 triggerAction） */
  triggerAction() {
    this.nextTriggerTime = this.limitTime
    this.isTriggerAtion = true
  }

  /**
   * type 12 扩展门裁决（游戏 checkActionInExtendFlag DD:1281-1314，由控制层
   * checkEnablePlay CT:176-188 在白/黑名单之前查询）：返回 'block' 拦截 /
   * 'pass' 直通（越过白/黑名单与按压锁——锁以白名单实现，直通同样越过）/
   * null 不表态。参数值按名查他机 parameterValue（EVENT_GET_DRAG_PARAMETER
   * CT:347-358：后注册者胜出、缺省 0；不是模型实时值也不是 targetValue）；
   * 区间左开右闭 (num[0], num[1]]；名单取本机 actionTriggerActive.ignore/
   * .enable（bake 空表 {} 经 Array.isArray 判假即不含动作），同命中时
   * ignore 优先（CT:181-185 if/elseif 顺序）
   */
  checkActionInExtend(actionName) {
    if (!this.extendActionFlag) return null
    const num = this.actionTrigger.num
    if (!Array.isArray(num) || num.length < 2) return null
    const v = this.orch.readDragParameter(this.actionTrigger.parameter)
    if (!(num[0] < v && v <= num[1])) return null
    const ad = this.actionTriggerActive
    if (Array.isArray(ad?.ignore) && ad.ignore.includes(actionName)) return 'block'
    if (Array.isArray(ad?.enable) && ad.enable.includes(actionName)) return 'pass'
    return null
  }

  // ---- 指针事件（游戏 startDrag / onDrag / stopDrag）----

  onDown(pos, playing) {
    if (this.ignoreAction && playing) {
// debug 读数：触发链关键步，debugHook 接线见 l2d/mount.js
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
    // 按压锁：原文只有无 down 配置的点击型在 checkClickAction firstActive
    // 上锁（DD:1408-1410）；down 配置型按下即触发不上锁，type 3/8 的锁在各自
    // handler 分支里。锁时机比原文（下一帧 updateTrigger）提前到按下同步，
    // 语义等价——本移植 onDown 没有 updateTrigger 帧
    const atDown = this.actionTrigger
    if (atDown && (atDown.type === 2 || atDown.type === 6 || atDown.type === 9) && !atDown.down) {
      this.orch.pressLock(`按下 ${this.drawAbleName}`, true)
    }
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
// debug 读数：触发链关键步，debugHook 接线见 l2d/mount.js
      this.orch.debug?.(`${this.parameterName} 点击判定成功,0.1s后触发`)
    } else {
      this.orch.pressLock(`非点击松手 ${this.drawAbleName}`, false)
      if (clickJudged) {
// debug 读数：触发链关键步，debugHook 接线见 l2d/mount.js
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
    this.orch.pressLock(`取消 ${this.drawAbleName}`, false)
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
        this.orch.pressLock(`确认窗作废 ${this.parameterName}`, false)
// debug 读数：触发链关键步，debugHook 接线见 l2d/mount.js
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
   * false 被冷却·单触发·播放中·重复 idle 豁免·点参档位挡下 / null 触发类型未实现。
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
    // type 9 点参：他参不贴近 num（±0.05）时白点（与 applyClickTrigger 同判据，
    // 读模型实时值）——档位不满足的机器画绿会误导成"绿了点不动"
    if (at.type === 9) {
      const v = this.orch.readParameter(at.parameter ?? this.parameterName)
      if (v == null || Math.abs((at.num ?? 0) - v) > 0.05) return false
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
    this._active = false // 按压中的机器一并松开（编排器 resetAll 调用）
    this.clickTriggerTime = null
    this.parameterToStart = null
    this.isTriggerAtion = false
    this.extendActionFlag = false
    this.nextTriggerTime = 0
    // 平滑状态一并归位：松手路径会把 parameterSmoothTime 留在 smoothRevert，
    // 复位后若不还原，下次触发用回弹时长插值（跨域残留）
    this.parameterSmoothTime = this.smooth
    this.parameterSmooth = 0
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
