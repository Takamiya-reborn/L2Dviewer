/**
 * 编排器（游戏 Live2D 类的路由面）：持有全部机器、idle 变体号与动作
 * 白/黑名单。单台机器的实现见 machine.js。
 */
import { DragMachine } from './machine.js'

/** 加载与模型同目录的拖拽参数机配置；缺失（未烘焙/非 L2D 皮肤）返回 null */
export async function loadL2dConfig(modelUrl) {
  return fetch(modelUrl.replace(/model3\.json$/, 'l2d.json'))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
}

/**
 * 编排器：持有全部机器、idle 变体号与动作白/黑名单（游戏 Live2D 类的路由面）。
 *
 * == 编排器级状态契约（属主 × 写入点 × 复位责任） ==
 * | 变量                    | 写入点                                         | 复位时机            |
 * | machineAble（按压锁）   | pressLock 唯一入口（写入方全集：machine.onDown/applyClickTrigger/onUp/onCancel/step 窗口作废、triggers.js type3×4+type8、resetAll）；setMachineAble 仅供测试拦截与 pressLock 落底 | pressLock(…,false) 各收尾路径 / resetAll |
 * | isPlaying/playActionName| noteMotionStart 置真（仅非 idle）/noteMotionFinish 清 | resetAll；滞留即锁死一切点击（HUD playing 读数） |
 * | enablePlayActions/ignorePlayActions | applyActiveData 唯一写（enable 在场即遮蔽 idle_enable，原文 #x>=0 恒真语义） | resetAll |
 * | idleIndex               | changeIdleIndex 唯一写（resetAll 直接置 0）     | resetAll            |
 * | _lastStartIdle          | noteMotionStart 记，noteMotionFinish 用         | resetAll            |
 * | activeOwner             | applyActiveData 落账（HUD 读数）                | resetAll            |
 *
 * 机器级状态（_active/isTriggerAtion/nextTriggerTime/…）契约见 machine.js 头
 * 注释；写机器状态前先查那张表。
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
   * 分区的路由优先级键：该分区在注册名单里的最早位置（机器按 ship_l2d 条目
   * 序构建）。游戏 GetDragPart（C#）对全部射线命中取"DragParts 名单下标最大
   * 者胜"——名单 = assistantTouchParts 排最前 + 条目序的 draw_able_name，
   * FindIndex 取首现位置，故这里同样取最早注册序作比较键。
   */
  zoneOrder(zoneName) {
    const first = this.machinesForZone(zoneName)[0]
    return first ? this.machines.indexOf(first) : -1
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
      let s = m.interactable()
      if (s === true) {
        // 机器自身可触发还不够：动作还得过白名单（游戏 checkEnablePlay 前置
        // 于播放）——shengluyisi_5 梯子中间态下 drag13:19 的点曾因不查名单
        // 恒绿，点了才在触发链里看到"被拦下"，提示层把人往死点上引
        if (!this.actionPassable(m)) s = false
      }
      if (s === true) return true
      if (s === false) blocked = true
    }
    return blocked ? false : null
  }

  /** 机器本次触发将播的动作能否过白名单；空触发机（circle/target）不播动作，
      白名单无关，恒可过。type 6 取当前下标的条目，随机数组任一项可过即可 */
  actionPassable(m) {
    const at = m.actionTrigger
    if (!at) return true
    let action = Array.isArray(at.action_list) && at.action_list.length
      ? at.action_list[Math.min(Math.max(m.actionListIndex, 1), at.action_list.length) - 1]?.action
      : at.action
    if (Array.isArray(action)) return action.some((a) => a && this.checkEnablePlay(a))
    return !action || this.checkEnablePlay(action)
  }

  /** 读模型参数实时值（游戏 EVENT_GET_PARAMETER：GetCubismParameter 缺失回 0）。
      机器参数每帧经 applyLayer 写入模型，读模型即读到机器叠加后的值 */
  readParameter(pid) {
    const idx = this.paramIndex(pid)
    if (idx < 0) return 0
    return this.model.internalModel.coreModel.getParameterValueByIndex(idx)
  }

  /** type 12 扩展门的参数值源（游戏 EVENT_GET_DRAG_PARAMETER CT:347-358）：
      按 parameterName 在机器里匹配，取该机 parameterValue（机器当前值），
      后注册者胜出，无匹配默认 0——不是模型实时值、不是 targetValue */
  readDragParameter(pid) {
    let v = 0
    for (const m of this.machines) {
      if (m.parameterName === pid) v = m.parameterValue
    }
    return v
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
    // 移动路由只按 _active（游戏 updateDrag DD:688+ 遍历按压中的机器）：
    // machineAble 是播放闸不是移动闸——down 配置型/type4 按压期间原文不上锁，
    // 挪用锁当移动门会把它们的拖动整个掐掉
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

  /**
   * 按压锁唯一写入口（游戏 setAbleWithFlag DD:1316-1324 的语义：幂等值守卫 +
   * 变迁广播）。锁滞留 = 一切播放被 machineAble 拦死，触发链里只剩"被机器
   * 按压拦下"却没有来由——reason 留痕让最后一条"按压锁→开"直接点名是哪次
   * 按压把锁带走的。全部写入方必须走这里，禁止直改 machineAble。
   */
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
      游戏里 "idle" 在白名单检查之前恒放行（Lua slot13 首条：触发改 idle
      变体的收尾分支后白名单是 48 项 touch_idle/clip 名，重播 idle 若也走
      名单会被整个拦死——实测即复位/回落后不再播任何动作）；按压锁
      （ableFlag）在游戏里是用 setEnableActions(['none action apply']) 换
      白名单实现的，idle 同样越过它，故豁免放最前 */
  checkEnablePlay(actionName) {
    if (actionName === 'idle') return true
    // type 12 扩展门（CT:176-188）：先于白/黑名单——任一 extend 机 ignore
    // 命中即拦、enable 命中即直通。原文 ableFlag 以白名单实现，直通同样
    // 越过按压锁；真实配置（shengluyisi_5）只用 ignore 屏蔽，enable 直通
    // 撬锁属原文潜在形态
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

  /** 诊断钩子：舞台侧注入 debugHook 后，触发链关键步写 console（既有消费方）；
      同时落环形缓冲 tapLog（上限 12 条，带 [s] 时间戳），供 HUD 面板读链路
      （拒按/点击判定/豁免/窗口作废/播放结果/名单写入）——"点了没反应"时按
      最后一条判定卡在哪道门 */
  debug(line) {
    ;(this.tapLog ??= []).push({ t: performance.now() / 1000, line })
    if (this.tapLog.length > 12) this.tapLog.shift()
    this.debugHook?.(line)
  }

  /**
   * 联动广播（游戏 onListenerHandle → live2ddrag onListenerEvent）：全部机器
   * 无差别收到。有消费方的事件只有两类：PLAY(1)（CT:288 播放成功后）与
   * CHANGE_IDLE(3)（changeIdleIndex）。DRAG_CLICK(2)/DOWN/XY_TRIGGER/
   * DRAG_TRIGGER 四类在原文是死路径——EVENT_ACTION_APPLY 成功回调实参恒
   * nil（CT:269/305），监听层永远收不到，不发；ON_ACTION_PARAMETER 在
   * 3759 条配置里零监听者，不发。
   */
  notice(type, data) {
    for (const m of this.machines) m.onListenerEvent(type, data)
  }

  /**
   * 机器触发 -> 播放动作。action 非空且真的播出去（存在 + 白名单放行 + 引擎
   * 接受）才应用 activeData；action 为空则直接应用（游戏"空触发"分支）。
   */
  async onActionApply(machine, action, activeData) {
    if (action) {
      // playAction 返回引擎的真实播放结果（async）：拒播时 activeData 不入账，
      // 否则 idle 变体号/白名单会记到一次没播出去的动作上（实测即"机器行
      // idle=4 而实际还在播基础 idle"的卡死态）
      const played = await this.playAction(action)
      // debug 读数：触发链关键步，debugHook 接线见 l2d/mount.js
      this.debug?.(
        `${machine.parameterName} 触发 ${action}` +
          ` 播放${played ? '成功' : '失败'}` +
          (Array.isArray(activeData?.enable)
            ? `,名单→${activeData.enable.length}项`
            : ',名单不变'),
      )
      if (played) {
        // 游戏在 checkEnablePlay 通过后、applyActiveData 之前发 PLAY 通知
        // （live2d.lua:288）：type 1 监听机在此改 target/换挡
        this.notice(1, { action })
        this.applyActiveData(machine.id, activeData, true)
      }
    } else {
      this.applyActiveData(machine.id, activeData, true)
    }
  }

  /**
   * 应用 activeData：白/黑名单 + idle 变体切换（游戏 applyActiveData）。
   * @param payloadIdle 事件负载里的 idle（联动层 EVENT_CHANGE_IDLE_INDEX 的
   *   负载值）：activeData.idle 缺省时回落到它（游戏 slot7 = activeData.idle
   *   or payload.idle）；idle_enable/idle_ignore 按这个变体号取对应名单。
   */
  applyActiveData(machineId, activeData, save, payloadIdle = null) {
    if (!activeData) return
    // Lua 空表经 bake 序列化成 {} 而非 []：enable/ignore 是序列名单，空表 =
    // 清空白/黑名单，游戏 setEnableActions({}) 照常落账——只认 isArray 会把
    // 收尾变体（touch_idle3/5/7/9 的 enable={}）的清空动作整个吞掉，白名单
    // 永久滞留在 touch_idle 链的 48 项上（实测即"走完状态机 touch_body 仍被拦"）
    const asList = (v) =>
      Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : null
    // 目标变体号（原始值）：idle_enable/idle_ignore 的按变体匹配用它——
    // 数组 idle（随机挑选）在游戏里跟数字变体号永远不相等，等价于不生效，
    // 原样保留这个语义
    const rawIdle = activeData.idle ?? payloadIdle
    let idle = rawIdle
    const enable = asList(activeData.enable)
    if (enable) {
      this.enablePlayActions = enable
      // 落账机器追踪（HUD 读数）：白名单与 idle 由同一台机的 activeData 写入，
      // 排查"名单是谁的/idle 为何没动"时直接点名，不用再靠 15 项反推
      this.activeOwner = machineId
    } else if (Array.isArray(activeData.idle_enable)) {
      // 按变体号取白名单（游戏 idle_enable 分支）：[[变体号,名单],...] 中
      // 匹配目标变体的那条生效；enable 在场时本分支整个不走（游戏 if/elseif）
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
      // 数组 idle：随机挑一个；不开 repeat_flag 时剔除当前值（游戏 applyActiveData）
      const pool = activeData.repeat_flag ? idle : idle.filter((n) => n !== this.idleIndex)
      idle = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null
    }
    if (idle != null && typeof idle === 'number') {
      // 无 idleIndex 相等守卫：原文 CT:1159 的守卫比较的是恒 nil 的 indexIndex
      //（反编译笔误），条件恒真——同值也走 changeIdleIndex（同值时广播照发、
      // 机器不复位，见 changeIdleIndex）
      this.changeIdleIndex(idle, save)
      if (save) this.saveValue('__action', machineId)
    }
  }

  changeIdleIndex(n, save = true) {
    const changed = this.idleIndex !== n
    this.idleIndex = n
    // 变体切换广播给机器：revert_idle_index 名单内的机器整体复位（游戏
    // updateStateData 的 revertIdleIndex 分支）。复位整体在
    // `l2dIdleIndex ~= idleIndex` 守卫内（DD:1355）——同值广播不复位
    if (changed) for (const m of this.machines) m.onIdleChanged(n)
    // CHANGE_IDLE 通知（游戏 changeIdleIndex 的 onListenerHandle）无条件发
    //（CT:1206-1224，同值也发，idle_change 标志监听机不消费）：type 3 监听机
    // 同值也按变体号改 target
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

  /**
   * @param clipName 起播的 clip 名
   * @param idle 是否 idle 组（idle 是循环氛围动作，库内循环动作永不
   *             isFinished、不产生 motionFinish，不能占用"反应动作播放中"
   *             状态——否则 isPlaying 永久滞留 true，点击触发恒被拦）
   */
  noteMotionStart(clipName, idle = false) {
    // 最近一次起播是否 idle 组：noteMotionFinish 判定"反应动作播完"用
    // （库的 motionFinish 事件不带 group 参数，只能在这里记）
    this._lastStartIdle = idle
    if (!idle) {
      this.isPlaying = true
      this.playActionName = clipName
    }
    // 动作起播后机器进短冷却（游戏 onListenerTrigger ON_ACTION_PLAY，DD:211）：
    // 游戏是无条件覆写 nextTriggerTime = min(limitTime, 0.2)，且广播源 CT:288
    // 对一切播出成功生效——含 idle（挂载起播、FinishAction 尾部 changeActionIdle
    // 收尾重播、变体切换重播）。触发时先设的 limitTime（默认 4s）冷却会被真正
    // 播出的动作塌缩回 0.2s，只在"触发被重复 idle 豁免/播放失败"等不产出
    // ON_ACTION_PLAY 的场合才足额生效。若只抬高不清零，触发过的分区会死满 4s
    // （实测即"绿色却点不动"）。pixi 的 motionStart 只在动作启动时发、循环不重发
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
    // 游戏 FinishAction 处理器（live2d.lua:666）尾部的 changeActionIdle：
    // 反应动作播完**显式** force 重播 "idle"——游戏没有"引擎随机回落"这回
    // 事，Unity Animator 由 "idle" 整数参数原子地选变体子状态；这里等价于
    // playLuaAction('idle')（组名路由会按 idleClipFor(idleIndex) 解析变体
    // 下标）。引擎的 startRandomMotion 回落补丁只作兜底——它的选支路径在
    // 实机上曾退化到基础 idle（idle.motion3.json 恰在组内下标 4，机器行
    // idle=4 却播基础待机即此），改走游戏本体的显式路径后不再依赖它
    if (wasPlaying && name && !idle) this.playAction?.('idle')
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
    // 按压锁一并清掉：machineAble 置真后若没走到任何清假路径（如按压中
    // 复位），checkEnablePlay 恒假会连"重置交互"自己的重播一起拦死
    this.pressLock('重置交互', false)
    this.idleIndex = 0
    this.isPlaying = false
    this.playActionName = ''
    this._lastStartIdle = false
    this.enablePlayActions = []
    this.ignorePlayActions = []
    this.activeOwner = 0
  }

  /** HUD 读数：idle 变体号、白名单规模、按住中的机器、各机器参数实时值、
      relation 联动参数实时值。返回结构化数据（键值对组），展示层负责排版 */
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
      // 名单里的 touch_idle 子集（紧凑记法 t17+t19）：唯一识别落账机器——
      // #16 的名单是 17+19，#19 收尾后是 2+4，收尾机空名单显示 空
      wlIdle: this.enablePlayActions
        .filter((c) => /^touch_idle/.test(c))
        .map((c) => c.slice('touch_idle'.length))
        .join('+'),
      // 最近一次写入白名单的机器 key 尾号（0 = 尚无落账）
      actor: this.activeOwner ?? 0,
      able: this.machineAble,
      // 反应动作播放中标记：卡死排查的关键读数——ignore_action 机器在播放中
      // 拒按、点击判定同样放行不了，isPlaying 若在动作结束后仍滞留真值即锁死
      playing: this.isPlaying,
      playName: this.playActionName,
      active: active ? active.drawAbleName : null,
      machines,
      relations,
      // 触发链最近读数（副本：ticker 每帧调 hudInfo，避免展示层持同引用）
      tap: (this.tapLog ?? []).slice(-6),
    }
  }
}
