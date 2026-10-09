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

  /** 诊断钩子：舞台侧注入 debugHook 后，触发链关键步
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
      // debug 读数：触发链关键步，debugHook 接线见 l2d/mount.js
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
      relation 联动参数实时值。返回结构化数据（键值对组），展示层负责排版 */
  hudInfo() {
    const active = this.machines.find((m) => m._active)
    const machines = this.machines.map((m) => [
      m.parameterName,
      Number(m.parameterValue.toFixed(2)),
    ])
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
      active: active ? active.drawAbleName : null,
      machines,
      relations,
    }
  }
}
