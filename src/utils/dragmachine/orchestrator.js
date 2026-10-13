/** 编排器（游戏 Live2D 类的路由面）：持有全部机器、idle 变体号与动作白/黑名单。单台机器的实现见 machine.js。 */
import { DragMachine } from './machine.js'

/** 加载与模型同目录的拖拽参数机配置；缺失（未烘焙/非 L2D 皮肤）返回 null */
export async function loadL2dConfig(modelUrl) {
  return fetch(modelUrl.replace(/model3\.json$/, 'l2d.json'))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
}

/**
 * 编排器：持有全部机器、idle 变体号与动作白/黑名单（游戏 Live2D 类的路由面）。
 * == 编排器级状态契约（属主 × 写入点 × 复位责任） ==
 * | 变量 | 写入点 | 复位时机 |
 * | machineAble（按压锁） | pressLock 唯一入口（写入方全集：machine.onDown/applyClickTrigger/onUp/onCancel/step 窗口作废、triggers.js type3×4+type8、resetAll）；setMachineAble 仅供测试拦截与 pressLock 落底 | pressLock(…,false) 各收尾路径 / resetAll |
 * | isPlaying/playActionName | noteMotionStart 清后按需置真（被顶掉动作不发 finish，起播即清算旧反应）/noteMotionFinish 清 | resetAll；滞留即锁死一切点击（HUD playing 读数） |
 * | enablePlayActions/ignorePlayActions | applyActiveData 唯一写（enable 在场即遮蔽 idle_enable，原文 #x>=0 恒真语义） | resetAll |
 * | idleIndex | changeIdleIndex 唯一写（resetAll 直接置 0） | resetAll |
 * | _lastStartIdle | noteMotionStart 记，noteMotionFinish 用 | resetAll |
 * | activeOwner | applyActiveData 落账（HUD 读数） | resetAll |
 * 机器级状态（_active/isTriggerAtion/nextTriggerTime/…）契约见 machine.js 头注释；写机器状态前先查那张表。
 * @param model pixi Live2DModel
 * @param config loadL2dConfig 的结果
 * @param playAction (clipName) => boolean 播放回调，L2dStage 提供：解析 clip 名 -> 动作组并播放（FORCE），返回是否真的播了
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
    this.playingClip = '' // 最近一次起播的 clip 名（含 idle 组——type 10 动作链的 state 名判据需要 idle clip 名，playActionName 只记反应动作）
    this.playStartAt = 0 // playingClip 的起播时刻（performance 时钟，秒）——type 10 归一化播进度的起算点
    this.clipDurationOf = null // (clipName) => 秒 | undefined，查 clip 时长；mount/sim 从 interaction.json clips 表注入，type 10 用
    this.machines = config.entries.map((e) => new DragMachine(e, this))
    // 读档：只恢复机器拖拽参数值。idle 变体号/白名单不跨会话恢复——存档里只有变体号、没有交互图状态（菜单摊开与否），单独恢复变体号会造出"菜单没开但 touch_idle1 被重复 idle 豁免跳过"的自不一致死态；游戏里两者是配套恢复的，这里拿不到后者就干脆都从干净态起步
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

  /** 机器分区名（大小写不敏感）。两边命名风格不同：ship_l2d 的 draw_able_name 是驼峰（TouchDrag1），model3.json HitAreas 的 Name 是小写下划线形式（touch_drag1），hitTest 返回的是后者——比较前剔除下划线等分隔符，否则永不匹配、机器路由整体失效。 */
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

  /** 分区的路由优先级键：该分区在注册名单里的最早位置（机器按 ship_l2d 条目序构建）。游戏 GetDragPart（C#）对全部射线命中取"DragParts 名单下标最大者胜"——名单 = assistantTouchParts 排最前 + 条目序的 draw_able_name，FindIndex 取首现位置，故这里同样取最早注册序作比较键。 */
  zoneOrder(zoneName) {
    const first = this.machinesForZone(zoneName)[0]
    return first ? this.machines.indexOf(first) : -1
  }

  /** 分区可交互状态（HUD 着色）：同名分区常挂多台机器（wuzang_3 的 TouchDrag2 挂充能 + 双联动 + 长按 4 台），任意一台可响应即算可交互；全部被挡时红、全部类型未实现时橙 */
  zoneInteractable(zoneName) {
    const ms = this.machinesForZone(zoneName)
    if (!ms.length) return null
    let blocked = false
    for (const m of ms) {
      let s = m.interactable()
      if (s === true) {
        // 机器自身可触发还不够：动作还得过白名单（游戏 checkEnablePlay 前置于播放）——不查名单的话提示层会对过不了名单的触发点报可交互
        if (!this.actionPassable(m)) s = false
      }
      if (s === true) return true
      if (s === false) blocked = true
    }
    return blocked ? false : null
  }

  /** 机器本次触发将播的动作能否过白名单；空触发机（circle/target）不播动作，白名单无关，恒可过。type 6 取当前下标的条目，随机数组任一项可过即可 */
  actionPassable(m) {
    const at = m.actionTrigger
    if (!at) return true
    let action = Array.isArray(at.action_list) && at.action_list.length
      ? at.action_list[Math.min(Math.max(m.actionListIndex, 1), at.action_list.length) - 1]?.action
      : at.action
    if (Array.isArray(action)) return action.some((a) => a && this.checkEnablePlay(a))
    return !action || this.checkEnablePlay(action)
  }

  /** 读模型参数实时值（游戏 EVENT_GET_PARAMETER：GetCubismParameter 缺失回 0）。机器参数每帧经 applyLayer 写入模型，读模型即读到机器叠加后的值 */
  readParameter(pid) {
    const idx = this.paramIndex(pid)
    if (idx < 0) return 0
    return this.model.internalModel.coreModel.getParameterValueByIndex(idx)
  }

  /** type 12 扩展门的参数值源（游戏 EVENT_GET_DRAG_PARAMETER CT:347-358）：按 parameterName 在机器里匹配，取该机 parameterValue（机器当前值），后注册者胜出，无匹配默认 0——不是模型实时值、不是 targetValue */
  readDragParameter(pid) {
    let v = 0
    for (const m of this.machines) {
      if (m.parameterName === pid) v = m.parameterValue
    }
    return v
  }

  // ---- 指针事件分发（L2dStage 调用；返回是否被机器消费）----

  /** 按下命中分区：startDrag 广播给该分区的**全部**机器（游戏 onPointDown 遍历 drags 匹配 drawAbleName，非只第一台）——wuzang_3 的 TouchDrag2 上充能、联动、长按三套机器共享分区，靠同时按压协同；各机器自己的 ignoreAction/已激活守卫在 machine.onDown 内 */
  onDown(zoneName, pos) {
    const ms = this.machinesForZone(zoneName)
    if (!ms.length) return false
    for (const m of ms) m.onDown(pos, this.isPlaying)
    return true
  }

  onMove(pos) {
    // 移动路由只按 _active（游戏 updateDrag DD:688+ 遍历按压中的机器）：machineAble 是播放闸不是移动闸——down 配置型/type4 按压期间原文不上锁，挪用锁当移动门会把它们的拖动整个掐掉
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

  /** 按压锁唯一写入口（游戏 setAbleWithFlag DD:1316-1324 的语义：幂等值守卫 + 变迁广播）。
   * 锁滞留 = 一切播放被 machineAble 拦死，触发链里只剩"被机器按压拦下"却没有来由——reason 留痕让最后一条"按压锁→开"直接点名是哪次按压把锁带走的。
   * 全部写入方必须走这里，禁止直改 machineAble。 */
  pressLock(reason, able) {
    if (this.machineAble === able) return
    this.debug?.(`按压锁→${able ? '开' : '关'}(${reason})`)
    this.setMachineAble(able)
  }

  /** 裸 setter：供测试 monkeypatch 拦截与 pressLock 落底，不留痕 */
  setMachineAble(able) {
    this.machineAble = able
  }

  /** 白名单/黑名单检查，对一切动作播放生效（游戏 checkEnablePlay）。
   * 游戏里 "idle" 在白名单检查之前恒放行（Lua slot13 首条：触发改 idle 变体的收尾分支后白名单是 48 项 touch_idle/clip 名，重播 idle 走名单会被整个拦死）。
   * 按压锁（ableFlag）在游戏里是用 setEnableActions(['none action apply']) 换白名单实现的，idle 同样越过它，故豁免放最前。 */
  checkEnablePlay(actionName) {
    if (actionName === 'idle') return true
    // type 12 扩展门（CT:176-188）：先于白/黑名单——任一 extend 机 ignore 命中即拦、enable 命中即直通。原文 ableFlag 以白名单实现，直通同样越过按压锁；真实配置（shengluyisi_5）只用 ignore 屏蔽，enable 直通撬锁属原文潜在形态
    for (const m of this.machines) {
      if (!m.extendActionFlag) continue
      const verdict = m.checkActionInExtend(actionName)
      if (verdict === 'block') return false
      if (verdict === 'pass') return true
    }
    if (this.machineAble) return false
    if (this.enablePlayActions.length && !this.enablePlayActions.includes(actionName)) return false
    if (this.ignorePlayActions.includes(actionName)) return false
    return true
  }

  /** 诊断钩子：舞台侧注入 debugHook 后，触发链关键步写 console（既有消费方）。
   * 同时落环形缓冲 tapLog（上限 12 条，带 [s] 时间戳），供 HUD 面板读触发链（拒按/点击判定/豁免/窗口作废/播放结果/名单写入），按最后一条判定卡在哪道门。 */
  debug(line) {
    ;(this.tapLog ??= []).push({ t: performance.now() / 1000, line })
    if (this.tapLog.length > 12) this.tapLog.shift()
    this.debugHook?.(line)
  }

  /** 联动广播（游戏 onListenerHandle → live2ddrag onListenerEvent）：全部机器无差别收到。
   * 有消费方的事件只有两类：PLAY(1)（CT:288 播放成功后）与 CHANGE_IDLE(3)（changeIdleIndex）。
   * DRAG_CLICK(2)/DOWN/XY_TRIGGER/DRAG_TRIGGER 四类在原文是死路径——EVENT_ACTION_APPLY 成功回调实参恒 nil（CT:269/305），监听层永远收不到，不发；ON_ACTION_PARAMETER 在 3759 条配置里零监听者，不发。 */
  notice(type, data) {
    for (const m of this.machines) m.onListenerEvent(type, data)
  }

  /** action='idle' 的变体选支（游戏 applyActiveData idle 段同款规则，live2d.lua CT:1166-1182）：数字直取（负数视为未配置）、数组按 repeat_flag 剔除当前变体后随机。返回 number | null */
  pickIdleVariant(activeData) {
    const idle = activeData.idle
    if (typeof idle === 'number') return idle >= 0 ? idle : null
    if (Array.isArray(idle) && idle.length) {
      const pool = activeData.repeat_flag ? idle : idle.filter((n) => n !== this.idleIndex)
      return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null
    }
    return null
  }

  /** 机器触发 -> 播放动作。action 非空且真的播出去（存在 + 白名单放行 + 引擎接受）才应用 activeData；action 为空则直接应用（游戏"空触发"分支）。 */
  async onActionApply(machine, action, activeData) {
    if (action) {
      // action='idle' 先切变体后播：游戏里 play("idle") 的 SetAction 与 applyActiveData 的 SetInteger("idle",n) 同帧落账（live2d.lua CT:286-291），Animator 下一帧才评估迁移——实际播出的就是 activeData 指向的新变体子状态，且游戏播放器（整数迁移）不存在"重播正在循环的同支 idle"这回事，恒成功
      // 移植端 playLuaAction 重播在循环的同支会被引擎 MotionState.reserve 以 "Motion is already playing" 拒绝（播放失败 → activeData 不入账）
      // 先落账变体再播，playLuaAction 按 idleClipFor(新变体) 解析出新 clip；游戏对 idle_focus=1 的空动作机同款先切后播先例（CT:280-284）
      // 选支只做一次并带给 applyActiveData——数组 idle 的两次随机不得各选各的；新旧变体解析出同一 clip 时预切无意义（引擎照样拒绝同支），维持原序
      let picked
      if (
        action === 'idle' &&
        activeData?.idle != null &&
        this.model.internalModel.settings?.motions?.idle
      ) {
        const variant = this.pickIdleVariant(activeData)
        if (
          variant != null &&
          variant !== this.idleIndex &&
          this.idleClipFor(variant) !== this.idleClipFor(this.idleIndex)
        ) {
          picked = variant
          this.changeIdleIndex(variant)
        }
      }
      // playAction 返回引擎的真实播放结果（async）：拒播时 activeData 不入账，否则 idle 变体号/白名单会记到一次没播出去的动作上
      // 先切路径的变体号是唯一例外——游戏侧该路径无失败形态（见上），变体先行落账与播出强绑定
      const played = await this.playAction(action)
      // debug 读数：触发链关键步，debugHook 接线见 l2d/mount.js
      this.debug?.(
        `${machine.parameterName} 触发 ${action}` +
          // type 10 的触发由 step 里归一化进度自动判定（DRAG_ANIMATION_PLAY），非点击路径
          (machine.actionTrigger?.type === 10 ? '[type10自动] ' : '') +
          ` 播放${played ? '成功' : '失败'}` +
          (picked != null ? `(idle变体→${picked}已先切)` : '') +
          (Array.isArray(activeData?.enable)
            ? `,名单→${activeData.enable.length}项`
            : ',名单不变'),
      )
      if (played) {
        // 游戏在 checkEnablePlay 通过后、applyActiveData 之前发 PLAY 通知（live2d.lua:288）：type 1 监听机在此改 target/换挡
        this.notice(1, { action })
        if (picked != null) this.applyActiveData(machine.id, activeData, true, null, picked)
        else this.applyActiveData(machine.id, activeData, true)
      }
    } else {
      this.applyActiveData(machine.id, activeData, true)
    }
  }

  /** 应用 activeData：白/黑名单 + idle 变体切换（游戏 applyActiveData）。
   * @param payloadIdle 事件负载里的 idle（联动层 EVENT_CHANGE_IDLE_INDEX 的负载值）：activeData.idle 缺省时回落到它（游戏 slot7 = activeData.idle or payload.idle）；idle_enable/idle_ignore 按这个变体号取对应名单
   * @param pickedIdle action='idle' 先切后播路径已选定的变体（onActionApply 挑好的那只）：数组 idle 不再重挑（两次随机会各选各的）、数字 idle 不再重复 changeIdleIndex（变体已落账，重复发 CHANGE_IDLE 通知是噪音）；仅在先切真正发生过时才传
   */
  applyActiveData(machineId, activeData, save, payloadIdle = null, pickedIdle) {
    if (!activeData) return
    // Lua 空表经 bake 序列化成 {} 而非 []：enable/ignore 是序列名单，空表 = 清空白/黑名单，游戏 setEnableActions({}) 照常落账——只认 isArray 会把收尾变体（touch_idle3/5/7/9 的 enable={}）的清空动作整个吞掉，白名单永久滞留在 touch_idle 链的 48 项上
    const asList = (v) =>
      Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : null
    // 目标变体号（原始值）：idle_enable/idle_ignore 的按变体匹配用它——数组 idle（随机挑选）在游戏里跟数字变体号永远不相等，等价于不生效，原样保留这个语义
    const rawIdle = activeData.idle ?? payloadIdle
    let idle = rawIdle
    const enable = asList(activeData.enable)
    if (enable) {
      this.enablePlayActions = enable
      // 落账机器追踪（HUD 读数）：白名单与 idle 由同一台机的 activeData 写入，HUD 直接点名最近写入方
      this.activeOwner = machineId
    } else if (Array.isArray(activeData.idle_enable)) {
      // 按变体号取白名单（游戏 idle_enable 分支）：[[变体号,名单],...] 中匹配目标变体的那条生效；enable 在场时本分支整个不走（游戏 if/elseif）
      for (const [variant, list] of activeData.idle_enable) {
        if (variant === rawIdle) {
          this.enablePlayActions = asList(list) ?? []
          this.activeOwner = machineId
        }
      }
    }
    const ignore = asList(activeData.ignore)
    if (ignore) this.ignorePlayActions = ignore
    else if (Array.isArray(activeData.idle_ignore)) {
      for (const [variant, list] of activeData.idle_ignore) {
        if (variant === rawIdle) this.ignorePlayActions = asList(list) ?? []
      }
    }
    if (Array.isArray(idle) && idle.length) {
      // 数组 idle：随机挑一个；不开 repeat_flag 时剔除当前值（游戏 applyActiveData）。先切路径已选定 pickedIdle 时不重挑
      if (pickedIdle !== undefined) idle = pickedIdle
      else {
        const pool = activeData.repeat_flag ? idle : idle.filter((n) => n !== this.idleIndex)
        idle = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null
      }
    } else if (pickedIdle !== undefined) {
      // 数字 idle 已在播放前落账（先切后播），重复 changeIdleIndex 只会重发 CHANGE_IDLE 通知
      idle = null
    }
    if (idle != null && typeof idle === 'number') {
      // 无 idleIndex 相等守卫：原文 CT:1159 的守卫比较的是恒 nil 的 indexIndex（反编译笔误），条件恒真——同值也走 changeIdleIndex（同值时广播照发、机器不复位，见 changeIdleIndex）
      this.changeIdleIndex(idle, save)
      if (save) this.saveValue('__action', machineId)
    }
  }

  changeIdleIndex(n, save = true) {
    const changed = this.idleIndex !== n
    this.idleIndex = n
    // 变体切换广播给机器：revert_idle_index 名单内的机器整体复位（游戏 updateStateData 的 revertIdleIndex 分支）。复位整体在 `l2dIdleIndex ~= idleIndex` 守卫内（DD:1355）——同值广播不复位
    if (changed) for (const m of this.machines) m.onIdleChanged(n)
    // CHANGE_IDLE 通知（游戏 changeIdleIndex 的 onListenerHandle）无条件发（CT:1206-1224，同值也发，idle_change 标志监听机不消费）：type 3 监听机同值也按变体号改 target
    this.notice(3, { idle: n })
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

  /** @param clipName 起播的 clip 名
   * @param idle 是否 idle 组（idle 是循环氛围动作，库内循环动作永不 isFinished、不产生 motionFinish，不能占用"反应动作播放中"状态——否则 isPlaying 永久滞留 true，点击触发恒被拦）
   */
  noteMotionStart(clipName, idle = false) {
    // 被顶掉的旧反应动作不会再发 motionFinish（库只在动作队列排空且 playing 仍真时发一次 finish，FORCE 起播杀掉旧队列条目是无声的）：新动作起播即宣告旧反应终局，先清滞留的播放中
    // 否则长按姿势播放中松手、收尾切 idle 的场合 isPlaying 永久滞留真值，全机 ignore_action 拒按 + 触发处理器 l2dIsPlaying 早退，交互整体锁死
    this.isPlaying = false
    this.playActionName = ''
    this.playingClip = clipName
    this.playStartAt = performance.now() / 1000
    // 最近一次起播是否 idle 组：noteMotionFinish 判定"反应动作播完"用（库的 motionFinish 事件不带 group 参数，只能在这里记）
    this._lastStartIdle = idle
    if (!idle) {
      this.isPlaying = true
      this.playActionName = clipName
    }
    // 动作起播后机器进短冷却（游戏 onListenerTrigger ON_ACTION_PLAY，DD:211）：游戏是无条件覆写 nextTriggerTime = min(limitTime, 0.2)，且广播源 CT:288 对一切播出成功生效——含 idle（挂载起播、FinishAction 尾部 changeActionIdle 收尾重播、变体切换重播）
    // 触发时先设的 limitTime（默认 4s）冷却会被真正播出的动作塌缩回 0.2s，只在"触发被重复 idle 豁免/播放失败"等不产出 ON_ACTION_PLAY 的场合才足额生效
    // pixi 的 motionStart 只在动作启动时发、循环不重发
    for (const m of this.machines) {
      m.nextTriggerTime = Math.min(m.limitTime, 0.2)
    }
  }

  noteMotionFinish() {
    const wasPlaying = this.isPlaying
    const name = this.playActionName
    const idle = this._lastStartIdle
    this.isPlaying = false
    this.playActionName = ''
    this.playingClip = ''
    // 游戏 FinishAction 处理器（live2d.lua:666）尾部的 changeActionIdle：反应动作播完**显式** force 重播 "idle"——游戏没有"引擎随机回落"这回事，Unity Animator 由 "idle" 整数参数原子地选变体子状态；这里等价于 playLuaAction('idle')（组名路由会按 idleClipFor(idleIndex) 解析变体下标）
    // 引擎的 startRandomMotion 回落补丁只作兜底，变体选支以这条游戏本体的显式路径为准
    if (wasPlaying && name && !idle) this.playAction?.('idle')
  }

  // ---- 每帧驱动与参数图层 ----

  step(dt) {
    for (const m of this.machines) m.step(dt, performance.now() / 1000, this.isPlaying, this.playActionName)
  }

  /** 机器参数图层（游戏 AddParameterValue/ChangeParameterData 的叠加源）：mode 1=Override 直接写机器值、2=Additive 叠加、3=Multiply 相乘；relation 联动参数随后写入（游戏对 enable 的 relation 逐帧 ChangeParameterData，mode 缺省回落机器 mode）。
   * 引擎的 save/loadParameters 会把本层写入滞留到下一帧（见 Cubism4InternalModel.update：save 在 afterMotionUpdate 之后、load 在帧尾），动作曲线没覆盖的 additive/multiply 参数会逐帧累积——游戏端是"每帧先还原参数再叠加"，这里对齐成两阶段：beforeMotionUpdate 先撤掉上帧叠加还原底值，afterMotionUpdate 取（动作求值后的）干净底重新叠加。
   * model3 里没有的参数不入层（游戏 GetCubismParameter nil 时同样不落）。 */
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
    // 按压锁一并清掉：machineAble 置真后若没走到任何清假路径（如按压中复位），checkEnablePlay 恒假会连"重置交互"自己的重播一起拦死
    this.pressLock('重置交互', false)
    this.idleIndex = 0
    this.isPlaying = false
    this.playActionName = ''
    this._lastStartIdle = false
    this.enablePlayActions = []
    this.ignorePlayActions = []
    this.activeOwner = 0
  }

  /** type 11 判定门读数：同分区同参数的多台机器归并为一道门，区间段按 num 排列并附目标动作；判定读的是模型实时值（applyClickTrigger 同源），不是机器记账值 */
  gateInfo() {
    const gates = []
    for (const m of this.machines) {
      const at = m.actionTrigger
      if (at?.type !== 11) continue
      const param = at.parameter ?? m.parameterName
      let gate = gates.find((g) => g.zone === m.drawAbleName && g.param === param)
      if (!gate) {
        gate = { zone: m.drawAbleName, param, value: null, lo: Infinity, hi: -Infinity, bands: [] }
        gates.push(gate)
      }
      const item = Array.isArray(at.action_list)
        ? at.action_list[Math.min(Math.max(m.actionListIndex, 1), at.action_list.length) - 1]
        : null
      const num = at.num ?? item?.num
      if (!num) continue
      gate.lo = Math.min(gate.lo, num[0])
      gate.hi = Math.max(gate.hi, num[1])
      gate.bands.push({ lo: num[0], hi: num[1], action: at.action ?? item?.action ?? '' })
    }
    for (const g of gates) {
      g.bands.sort((a, b) => a.lo - b.lo)
      g.value = this.readParameter(g.param)
    }
    return gates
  }

  /** HUD 读数：idle 变体号、白名单规模、按住中的机器、各机器参数实时值、relation 联动参数实时值。返回结构化数据（键值对组），展示层负责排版 */
  hudInfo() {
    const active = this.machines.find((m) => m._active)
    const machines = this.machines
      .filter((m) => m.parameterName) // mode 2 联动机本机参数为空，走"联动"行
      .map((m) => [m.parameterName, Number(m.parameterValue.toFixed(2))])
    const relations = []
    for (const m of this.machines) {
      for (const r of m.relations) {
        if (!relations.some(([name]) => name === r.name)) {
          relations.push([r.name, Number(r.value.toFixed(2))])
        }
      }
    }
    return {
      idle: this.idleIndex,
      whitelist: this.enablePlayActions.length,
      // 名单里的 touch_idle 子集（紧凑记法 t17+t19）：唯一识别落账机器——#16 的名单是 17+19，#19 收尾后是 2+4，收尾机空名单显示 空
      wlIdle: this.enablePlayActions
        .filter((c) => /^touch_idle/.test(c))
        .map((c) => c.slice('touch_idle'.length))
        .join('+'),
      // 最近一次写入白名单的机器 key 尾号（0 = 尚无落账）
      actor: this.activeOwner ?? 0,
      able: this.machineAble,
      // 反应动作播放中标记：ignore_action 机器在播放中拒按、点击判定同样放行不了，isPlaying 若在动作结束后仍滞留真值即锁死
      playing: this.isPlaying,
      playName: this.playActionName,
      active: active ? active.drawAbleName : null,
      machines,
      relations,
      gates: this.gateInfo(),
      // 触发链最近读数（副本：ticker 每帧调 hudInfo，避免展示层持同引用）
      tap: (this.tapLog ?? []).slice(-6),
    }
  }
}
