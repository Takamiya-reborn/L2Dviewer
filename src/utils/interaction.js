/**
 * Unity 端 L2D 交互控制器（Live2dChar + 游戏自定义控制器）的 Web 还原。
 *
 * 数据源是 extract.py 生成的 <id>.interaction.json：每支动作的
 * AnimationEvent（OnAnimEvent=语音钩子、OnFinishAnim(N)=结束状态编号）与
 * 开关型参数（取值贴 0/±1 的图层/道具开关）的 [起播值, 结束值]。字段语义见
 * Unpack.md，协议逆向过程见 azurlane.md 的"交互状态机"一节。
 *
 * 游戏不在动作间复位参数，状态机参数的值跨动作持续，"点击摊开菜单 ->
 * 分支 -> 收尾"的状态机就建立在参数连续性上：
 * - 跨动作保留：touch_idle1 播完后 caidan=1（菜单摊开）持续到分支播完；
 *   连续摆位同理（touch_idle1 摊开菜单时 All_X=2.34 场景右移，idle1 变体
 *   不复写该参数，位移持续到收尾分支带回 0）——extract.py 把这类参数落盘
 *   在 clips[*].carry，与开关参数（state）一起进节点、复位时豁免；
 * - 点击门控：起播值=1 的开关是前置状态（动作依赖该图层/道具已摊开，
 *   touch_idle2/4/6/8 以 caidan=1 起播，仅菜单摊开时是合法分支）。
 *
 * 运行时把它实现成显式的有向图：节点 = 状态参数的值向量，动作 = 边
 * （起播值=1 的开关 = 前置约束，结束值 = 转移结果）。节点被显式跟踪——
 * 动作起播先挂起（pending），播完（motionFinish，即游戏 OnFinishAnim 的
 * 上报时机）才落实转移；被新动作顶掉的挂起动作按"已播完"结算（结束值
 * 是绝对值，重复应用幂等）。门控一律查节点而非实时参数：实时值会被
 * 逐帧曲线、眨眼/呼吸等姿态系统扰动（如点击瞬间正逢眨眼，ParamEyeLOpen
 * 离 1 很远，按实时值比对会误拒合法分支），节点只在转移时变化。
 */
import { Container, Graphics, Text } from 'pixi.js'
import { MotionPriority } from 'pixi-live2d-display/cubism4'

/** 加载与模型同目录的交互状态机数据；缺失（旧产物/无交互的模型）返回 null */
export async function loadInteraction(modelUrl) {
  return fetch(modelUrl.replace(/model3\.json$/, 'interaction.json'))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
}

export class InteractionRuntime {
  /**
   * @param model pixi-live2d-display 的 Live2DModel
   * @param interaction loadInteraction 的结果，null 时运行时全旁路：
   *                    参数全量复位、点击不做门控（等价旧行为）
   */
  constructor(model, interaction) {
    this.model = model
    this.interaction = interaction
    const clips = interaction?.clips ?? {}
    // 状态机参数：有动作以非默认值继承（起播边界非 0）——复位时必须跳过，
    // 否则"菜单摊开"等跨动作状态会在下一支动作开始瞬间被抹掉
    this.statePids = new Set(
      Object.values(clips)
        .flatMap((c) => Object.entries(c.state ?? {}))
        .filter(([, [start]]) => start !== 0)
        .map(([pid]) => pid),
    )
    // 连续摆位参数（carry）：菜单摊开时的场景位移（All_X）等——同样跨动作
    // 持续、同样不许被复位抹掉，但取值连续、只做保留不做门控（起播值=1 的
    // 前置约束只对开关参数成立，姿态参数凑巧取 1 不构成状态前置）
    this.carryPids = new Set(
      Object.values(clips).flatMap((c) => Object.keys(c.carry ?? {})),
    )
    // 复位豁免全集 = 开关 + 连续摆位
    this.preservePids = new Set([...this.statePids, ...this.carryPids])
    const core = model.internalModel.coreModel
    this.preserveIdx = new Set(
      [...this.preservePids]
        .map((pid) => core.getParameterIndex(pid))
        .filter((i) => i >= 0 && i < core.getParameterCount()),
    )

    // ---- 有向图节点跟踪 ----
    // 节点 = preservePids 的值向量，初值取 moc 默认（模型加载即干净默认姿态）。
    // pending 是"已起播但转移未落实"的 clip：motionFinish 结算它；被下一支
    // 动作顶掉时由 trackMotionStart 先行结算（结束值为绝对值，幂等）。
    this.eps = 0.05
    this.node = new Map(
      [...this.preservePids].map((pid) => [pid, this.paramDefault(pid)]),
    )
    // 门控前置集：起播值=1 且该值可产出（某动作结束值=1，或 moc 默认=1）。
    // 起播值 0/-1 是 t0 硬设（消隐/复位/表情预设），不构成前置——全参数严格
    // 匹配会误拦 touch_idle4/6/8（它们以 dianjikyc=0 起播只是收起菜单可点
    // 区）；不可产出的前置（如 touch_idle6 的 panjiubei=1，数据中无任何动
    // 作产出该值）若参与门控会让分支永久不可达，同样豁免，待提取补全后再
    // 收紧。
    this.gatedPids = new Set(
      Object.values(clips)
        .flatMap((c) => Object.entries(c.state ?? {}))
        .filter(([, [, end]]) => end === 1)
        .map(([pid]) => pid),
    )
    for (const pid of this.statePids) {
      if (this.paramDefault(pid) === 1) this.gatedPids.add(pid)
    }
    this.pending = null
    // 挂起的动作是否 idle 组:等待态判定用(见 canPlay)。idle 循环算等待态,
    // 其他动作播放中不算
    this.idleGroup = model.internalModel.motionManager?.groups?.idle ?? 'idle'
    this.pendingIdle = false
    // 白名单钩子：拖拽参数机编排器（L2dStage 挂载后注入）——游戏 Lua 层的
    // checkEnablePlay 对一切动作播放生效（enable/ignore 名单存 clip 名），
    // 这里前置到 canPlay，供命中路径与 playHitMotion 的组内选支共用
    this.checkEnable = null
    if (interaction) {
      const manager = model.internalModel.motionManager
      manager.on('motionStart', (group, index) => this.trackMotionStart(group, index))
      manager.on('motionFinish', () => this.trackMotionFinish())
    }
  }

  /** moc 默认值（按参数 id；模型里不存在的参数没有默认值，按 0 处理，
      与 paramValue 的虚拟下标行为一致） */
  paramDefault(pid) {
    const core = this.model.internalModel.coreModel
    const index = core.getParameterIndex(pid)
    return index >= 0 && index < core.getParameterCount()
      ? core.getParameterDefaultValue(index)
      : 0
  }

  /** 当前参数值（按参数 id；模型里不存在的参数经核心映射为虚拟下标，值为 0） */
  paramValue(pid) {
    return this.model.internalModel.coreModel.getParameterValueById(pid)
  }

  /** motion3 文件路径 -> clip 名（settings 的动作定义按组/下标给出） */
  clipOf(group, index) {
    const def = this.model.internalModel.settings?.motions?.[group]?.[index]
    return (def?.File ?? '').split('/').pop()?.replace(/\.motion3\.json$/, '') || null
  }

  /** 起播：先结算被顶掉的挂起动作，再挂起新动作。idle 变体是循环动作、
      永不 motionFinish，它的开关状态（微笑眼等 idle 姿态预设）在起播瞬间
      即生效并持续整个循环——立即落账进节点，否则变体循环期间节点缺这份
      状态，依赖它的分支（如 touch_idle14 要求 ParamEyeLSmile=1）会被门控
      与 HUD 误判成不可达（游戏里参数由曲线实时驱动，起播即为此值） */
  trackMotionStart(group, index) {
    if (this.pending) this.applyEnd(this.pending)
    this.pending = this.clipOf(group, index)
    this.pendingIdle = group === this.idleGroup
    if (this.pendingIdle && this.pending) this.applyEnd(this.pending)
  }

  /** 播完：落实挂起动作的转移（游戏 OnFinishAnim 的上报时机） */
  trackMotionFinish() {
    this.applyEnd(this.pending)
    this.pending = null
    this.pendingIdle = false
  }

  /** 把 clip 的结束值写进节点——有向图中沿这条边走一步。开关参数只写节点域
      内（statePids）的：end-only 参数（起播恒 0，如 sdrtx）由 resetParameters
      的常规复位管理，写入节点会让它永久残留。连续摆位参数（carryPids）同样
      按结束值落账——收尾分支带回 0 的也写，节点随之清零 */
  applyEnd(clipName) {
    const clip = this.interaction?.clips?.[clipName]
    if (!clip) return
    for (const [pid, [, end]] of Object.entries(clip.state ?? {})) {
      if (this.statePids.has(pid)) this.node.set(pid, end)
    }
    for (const [pid, [, end]] of Object.entries(clip.carry ?? {})) {
      if (this.carryPids.has(pid)) this.node.set(pid, end)
    }
  }

  /** 节点复位到干净默认态（"重置交互状态"用）：清挂起转移，状态参数全部
      回 moc 默认。配合拖拽参数机编排器的 resetAll 一起调 */
  resetState() {
    this.node = new Map(
      [...this.preservePids].map((pid) => [pid, this.paramDefault(pid)]),
    )
    this.pending = null
    this.pendingIdle = false
  }

  /** 中性节点：全部开关状态参数都贴着 moc 默认值（无任何跨动作残留）。
      只查开关参数：连续摆位（姿态/位移）几乎总被某支动作残留，参与判定
      会让"分支挂起"永不解除、idle 永不回落 */
  isNeutral() {
    for (const pid of this.statePids) {
      const value = this.node.get(pid) ?? 0
      if (Math.abs(value - this.paramDefault(pid)) > this.eps) return false
    }
    return true
  }

  /**
   * 命中检测只看网格包围盒，不判断透明度，隐藏部位（其他姿态的判定网格、
   * 摆位零件）也会响应；这里按 drawable 不透明度过滤，只保留可见命中区。
   *
   * 手势区分（与游戏一致）：一次 raycast 会同时命中 idle/head/body 与 drag
   * 两族分区，控制器按手势挑族——点击取非 drag 分区，拖拽只取 drag 分区。
   *
   * @param {string[]} names 命中的分区名（internalModel.hitTest 的返回）
   * @param {'tap'|'drag'} gesture
   */
  firstVisibleHit(names, gesture = 'tap') {
    const core = this.model.internalModel.coreModel
    const areas = this.model.internalModel.hitAreas ?? {}
    const hasOpacity = typeof core.getDrawableOpacity === 'function'
    const wantDrag = gesture === 'drag'
    for (const name of names) {
      const index = areas[name]?.index
      if (index === undefined) continue
      if (name.startsWith('touch_drag') !== wantDrag) continue
      if (!hasOpacity || core.getDrawableOpacity(index) > 0.001) return name
    }
    return ''
  }

  /**
   * 点击门控：与跟踪节点比对而非实时参数（实时值受逐帧曲线与眨眼/呼吸
   * 扰动）。前置只取起播值=1 且可产出的开关（见构造函数 gatedPids）——
   * 起播值=1 意味着动作依赖该图层/道具已摊开/已持有（如菜单分支以
   * caidan=1 起播，仅菜单摊开时合法）。不符（如菜单收起时点菜单项）则
   * 不可触发。未收录/无开关参数的反应动作（touch_drag 系等，extract.py
   * 只落盘有事件或边界数据的 clip）在游戏里由控制器状态而非参数门控。
   * 手势只在等待态被处理（动作播放中途控制器不响应手势），而 idle 循环
   * 与分支挂起（姿态保持、等待后续手势收尾）都算等待态，故按"无挂起
   * 动作或挂起的是 idle"放行——菜单摊开后等待拖拽（touch_idle1 ->
   * touch_drag*）正是挂起态下的合法分支，旧的"仅中性节点"近似会误拦。
   */
  canPlay(clipName) {
    if (this.checkEnable && !this.checkEnable(clipName)) return false
    if (!this.interaction) return true
    const state = this.interaction.clips?.[clipName]?.state
    if (!state || !Object.keys(state).length) {
      return this.pending === null || this.pendingIdle
    }
    for (const [pid, [start]] of Object.entries(state)) {
      if (start !== 1 || !this.gatedPids.has(pid)) continue
      if (Math.abs((this.node.get(pid) ?? 0) - 1) > this.eps) return false
    }
    return true
  }

  /**
   * 按节点复位参数：非状态机参数回到 moc3 默认值，状态机参数对齐到跟踪
   * 节点的值。游戏内每个 AnimationClip 都假定从默认姿态起播；而 idle 组只
   * 覆盖约 1/5 的参数，若不复位，上一支动作遗留的图层/道具开关（如
   * ParamCrusLLayer2、heiping）会持续污染后续动作，产生穿模、碎片残影等
   * 渲染错误。状态机参数不能简单复位也不能简单保留——被中途打断的动作会
   * 把实时值留在半途（如菜单摊到一半），节点才是协议意义上的当前状态，
   * 对齐到节点同时消除打断残留。在 motionStart 时调用可确保动作首次求值
   * 前参数是干净的（update 的 loadParameters 只恢复到"上一帧动作求值后"的
   * 值，不会冲掉这里写入的值；新动作曲线随后逐帧接管它涉及到的参数）。
   */
  resetParameters() {
    const core = this.model.internalModel.coreModel
    const count = core.getParameterCount()
    for (let i = 0; i < count; i++) {
      if (this.preserveIdx.has(i)) continue
      core.setParameterValueByIndex(i, core.getParameterDefaultValue(i))
    }
    for (const [pid, value] of this.node) core.setParameterValueById(pid, value)
  }

  /**
   * 命中区名 -> 动作播放（MotionPriority.FORCE）。分区名即动作文件名
   * （见 extract.py 的 HitAreas 生成）：touch_idle3/touch_drag5 等分区
   * 各对应组里的具体一支，点哪个部位播哪支；摸头/普通触摸等则恰好有同名组。
   * 分区对应动作被门控挡下时，在组内随机挑一支当前可达的；组内全部不可达
   * 则不播——这还原了游戏"点特定地方进入交互"的状态机行为：菜单收起时点
   * 触摸区会播 touch_idle1（摊开菜单），菜单摊开时点对话区播对应分支，
   * 点完收尾分支后回到可再进入的状态。
   *
   * @returns {null | {group: string}} 实际播放的动作组名；无动作/全部被拦下返回 null
   */
  playHitMotion(name) {
    const motions = this.model.internalModel.settings?.motions ?? {}
    const base = motions[name] ? name : name.replace(/\d+$/, '')
    const defs = motions[base]
    if (!defs?.length) return null
    const entries = defs.map((d, index) => ({
      index,
      clip: (d.File ?? '').split('/').pop()?.replace(/\.motion3\.json$/, '') ?? '',
    }))
    const exact = entries.find((e) => e.clip === name)
    const pool = entries.filter((e) => this.canPlay(e.clip))
    const pick =
      exact && this.canPlay(exact.clip)
        ? exact
        : pool[Math.floor(Math.random() * pool.length)]
    if (!pick) return null
    this.model.motion(base, pick.index, MotionPriority.FORCE)
    return { group: base }
  }
}

/**
 * 交互点可视化提示（测试用）：每个命中区一个半透明圆点标在其 drawable
 * 网格中心，外加网格包围盒轮廓（isHit 的实际判定范围）——绿 = 可交互、
 * 红 = 被挡下、橙 = 游戏配置了触发但查看器未实现该触发类型、隐藏网格
 * （如菜单收起时的菜单项）不显示；位置每帧跟随模型。
 *
 * 红绿判定按真实路由分家：机器分区（ship_l2d 有 draw_able_name 匹配）由
 * 拖拽参数机接管，不查 interaction.json 的参数门控——颜色按机器自身的
 * 可触发条件（冷却/单触发/播放中/重复 idle 豁免，取编排器路由到的那台，
 * 与游戏 GetDragPart 的"注册顺序第一台赢"一致）判定；无机器的分区
 * （touch_head/body 等 C# 路径）才按起播门控（canPlay）判定。两种判据
 * 混用会把"机器照样能拖"的分区画红、"未实现触发类型/冷却中"的分区画绿。
 *
 * 标签显示分区驱动的参数（编排器 l2d.json 的 draw_able_name -> parameter），
 * 不用网格自己的名字：部分皮肤的网格名与反应编号是错位的（shengluyisi_5:
 * TouchDrag23 网格驱动 touch_drag25、TouchDrag25 驱动 touch_drag29——
 * 游戏 sharecfg ship_l2d 原始数据即如此），按网格名标注会把 drag25 的
 * 范围/中心画到 TouchDrag25 网格上，与游戏内实际触发位置对不上。多个
 * 机器共用同一分区时参数用 "+" 连接；无机器的分区（摸头/普通触摸等）
 * 沿用网格名。
 *
 * @param app pixi Application（提示层挂到其 stage）
 * @param getRuntime () => InteractionRuntime | null，每帧取当前运行时
 * @param getVisible () => boolean，提示层开关
 * @param getOrch () => DragOrchestrator | null，拖拽参数机编排器
 * @returns {{ rebuild(model): void, destroy(): void, update(): string }}
 *   update 每帧调用，返回 HUD 文本（状态机参数实时值，供测试对照）
 */
export function createInteractionHints(app, getRuntime, getVisible, getOrch = null) {
  let layer = null
  let hints = []

  /** 分区名（hitArea Name，如 touch_drag23）-> 驱动参数名（如 touch_drag25）。
      归一化规则与 DragOrchestrator.machineByZone 一致（剔大小写与分隔符）；
      无机器覆盖时返回 null，调用方回落到网格名 */
  function zoneParams(orch, zoneName) {
    if (!orch?.machines?.length) return null
    const key = String(zoneName).toLowerCase().replace(/[^a-z0-9]/g, '')
    const found = []
    for (const m of orch.machines) {
      if (String(m.drawAbleName).toLowerCase().replace(/[^a-z0-9]/g, '') !== key) continue
      if (!found.includes(m.parameterName)) found.push(m.parameterName)
    }
    return found.length ? found.join('+') : null
  }

  return {
    rebuild(model) {
      this.destroy()
      layer = new Container()
      const areas = model.internalModel.hitAreas ?? {}
      hints = Object.entries(areas).map(([name, area]) => {
        const dot = new Graphics()
        const label = new Text(name, {
          fontSize: 10,
          fill: 0xffffff,
          letterSpacing: 0.5,
        })
        label.alpha = 0.85
        layer.addChild(dot, label)
        return { name, idx: area.index, dot, label }
      })
      app.stage.addChild(layer)
    },

    destroy() {
      if (layer) {
        app.stage.removeChild(layer)
        layer.destroy({ children: true })
        layer = null
      }
      hints = []
    },

    update() {
      if (!layer) return ''
      const runtime = getRuntime()
      if (!getVisible() || !runtime) {
        layer.visible = false
        return ''
      }
      layer.visible = true
      const core = runtime.model.internalModel.coreModel
      const hasOpacity = typeof core.getDrawableOpacity === 'function'
      for (const h of hints) {
        if (!hasOpacity || core.getDrawableOpacity(h.idx) <= 0.001) {
          h.dot.visible = h.label.visible = false
          continue
        }
        // 标签 = 分区驱动的参数（见函数注释）。逐帧解析：编排器随模型热切换
        const orch = getOrch?.()
        const params = zoneParams(orch, h.name)
        if (params && h.label.text !== params) h.label.text = params
        const verts = runtime.model.internalModel.getDrawableVertices(h.idx)
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        let cx = 0
        let cy = 0
        for (let j = 0; j < verts.length; j += 2) {
          const x = verts[j]
          const y = verts[j + 1]
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
          cx += x
          cy += y
        }
        const n = verts.length / 2
        const g = runtime.model.toGlobal({ x: cx / n, y: cy / n })
        h.dot.visible = h.label.visible = true
        h.dot.position.set(0, 0)
        h.dot.clear()
        // 判定网格包围盒轮廓（模型空间取角点转全局坐标）：isHit 就是这个
        // 矩形的精确包含测试，画出实际覆盖范围，对照松手位置排查命中落空
        const p0 = runtime.model.toGlobal({ x: minX, y: minY })
        const p1 = runtime.model.toGlobal({ x: maxX, y: maxY })
        // 颜色按真实路由判定（见函数注释）：机器分区看参数机的可触发条件
        // （同名多机时任意一台可响应即绿），其余分区看 interaction.json 的
        // 起播门控；橙 = 触发类型未实现
        const hasMachine = params && orch?.machinesForZone(h.name).length
        const state = params ? orch?.zoneInteractable(h.name) : null
        const color =
          state === true || (!hasMachine && runtime.canPlay(h.name))
            ? 0x4fc08d
            : state === null
              ? 0xe0a03c
              : 0xe05555
        h.dot.beginFill(color, 0.06)
        h.dot.drawRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y)
        h.dot.lineStyle(1, color, 0.8)
        h.dot.drawRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y)
        h.dot.endFill()
        h.dot.beginFill(color, 0.35)
        h.dot.drawCircle(g.x, g.y, 9)
        h.dot.endFill()
        h.label.position.set(g.x + 12, g.y - 7)
      }
      const parts = [...runtime.statePids].map(
        (pid) => `${pid}=${Math.round(runtime.paramValue(pid))}`,
      )
      // 连续摆位只报节点里的非默认残留（实时值被逐帧曲线扰动，不适合读数）
      const carried = [...runtime.carryPids].filter(
        (pid) =>
          Math.abs((runtime.node.get(pid) ?? 0) - runtime.paramDefault(pid)) >
          runtime.eps,
      )
      parts.push(
        ...carried.map((pid) => `${pid}=${runtime.node.get(pid)}`),
      )
      return parts.join('  ')
    },
  }
}
