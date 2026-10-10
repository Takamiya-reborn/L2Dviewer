/**
 * 交互状态机运行时（InteractionRuntime）：把 interaction.json 实现成显式
 * 有向图——节点 = 状态参数的值向量，动作 = 边。协议背景与字段语义见同目录
 * index.js 头注释。
 */
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
    // 否则"菜单摊开"等跨动作状态会在下一支动作开始瞬间被抹掉。
    // 聚合按参数计：flatMap 横跨全部动作，某支动作里 [0,1]（起 0 收 1）的
    // 条目滤掉没关系，另一支动作 [1,0]（起播=1）的条目就是游戏未复位的
    // 直接证据——wuzang_3 的 JIRU/GL1/Param57/Param164 在 touch_drag3/4/6/8
    // 里起 0 收 1、在 touch_drag9~14 里起播=1（收尾动作再带回 0），特效件
    // 正是被这批参数点亮的跨动作状态。纯 end-only（所有条目起播都是 0，
    // 如 sdrtx）才是复位管理的瞬态参数
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
    // 门控前置集：起播值=1 且该值可产出的开关（某动作从非 1 起播走到结束
    // 值=1，或 moc 默认即 1）。起播值 0/-1 是 t0 硬设（消隐/复位/表情预
    // 设），不构成前置——全参数严格匹配会误拦 touch_idle4/6/8（它们以
    // dianjikyc=0 起播只是收起菜单可点区）。「从非 1 起播」排除自指产出：
    // wuzang_3 的 touch_special 以 MB_fenweiqiu4/5=1 起播、自身又是唯一
    // end=1 的动作（氛围球是连续量参数，默认 0.7，曲线 t0 打满亮只是硬设
    // 不是状态前置），若算可产出则该分支从 t0 起永久不可达（自要求自供
    // 给的死锁）；不可产出且默认非 1 的前置（如 touch_idle6 的
    // panjiubei=1）同样豁免，待提取补全后再收紧。
    this.gatedPids = new Set(
      Object.values(clips)
        .flatMap((c) => Object.entries(c.state ?? {}))
        .filter(([, [start, end]]) => end === 1 && start !== 1)
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
   * 从网格级命中结果里挑第一个可用分区。入参来自 meshHitTest（已按渲染序
   * 排好、视觉最上层在前），本方法只做两件事：
   * - 透明度过滤：命中检测只看网格形状，不判断不透明度，隐藏部位（其他
   *   姿态的判定网格、摆位零件）也会响应；按 drawable 不透明度过滤，
   *   只保留可见命中区（与游戏 raycast 行为一致）；
   * - 手势区分（与游戏一致）：一次 raycast 会同时命中 idle/head/body 与
   *   drag 两族分区，控制器按手势挑族——点击取非 drag 分区，拖拽只取
   *   drag 分区。
   *
   * @param {string[]} names 命中的分区名（meshHitTest 的返回）
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
