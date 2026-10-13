/** 交互状态机运行时（InteractionRuntime）：把 interaction.json 实现成显式有向图——节点 = 状态参数的值向量，动作 = 边。协议背景与字段语义见同目录 index.js 头注释。 */
import { MotionPriority } from 'pixi-live2d-display/cubism4'

/** 加载与模型同目录的交互状态机数据；缺失（旧产物/无交互的模型）返回 null */
export async function loadInteraction(modelUrl) {
  return fetch(modelUrl.replace(/model3\.json$/, 'interaction.json'))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
}

/** 平滑复位窗口缺省值（秒）：mount.js 在 motionStart 时按起播 clip 查 fades.json 的转场时长传入（与新动作的渐入窗口严格同源同值）；这里只是 fades 表缺失/未命中时的兜底，与 motionPatches.js 的 config 渐变兜底同值 */
const RESET_FADE = 0.3

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
    // 状态机参数：有动作以非默认值继承（起播边界非 0）——复位时必须跳过，否则"菜单摊开"等跨动作状态会在下一支动作开始瞬间被抹掉
    // 聚合按参数计：flatMap 横跨全部动作，某支动作里 [0,1]（起 0 收 1）的条目滤掉没关系，另一支动作 [1,0]（起播=1）的条目就是未复位的直接证据；纯 end-only（所有条目起播都是 0，如 sdrtx）才是复位管理的瞬态参数
    this.statePids = new Set(
      Object.values(clips)
        .flatMap((c) => Object.entries(c.state ?? {}))
        .filter(([, [start]]) => start !== 0)
        .map(([pid]) => pid),
    )
    // 连续摆位参数（carry）：菜单摊开时的场景位移（All_X）等——同样跨动作持续、同样不许被复位抹掉，但取值连续、只做保留不做门控（起播值=1 的前置约束只对开关参数成立，姿态参数凑巧取 1 不构成状态前置）
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
    // 节点 = preservePids 的值向量，初值取 moc 默认（模型加载即干净默认姿态）
    // pending 是"已起播但转移未落实"的 clip：motionFinish 结算它；被下一支动作顶掉时由 trackMotionStart 先行结算（结束值为绝对值，幂等）
    this.eps = 0.05
    this.node = new Map(
      [...this.preservePids].map((pid) => [pid, this.paramDefault(pid)]),
    )
    // 门控前置集：起播值=1 且该值可产出的开关（某动作从非 1 起播走到结束值=1，或 moc 默认即 1）；起播值 0/-1 是 t0 硬设（消隐/复位/表情预设），不构成前置
    // 「从非 1 起播」排除自要求自供给的死锁：若一个分支以自身才是唯一 end=1 产出者的参数起播，算可产出会让该分支从 t0 起永久不可达；不可产出且默认非 1 的前置同样豁免，待提取补全后再收紧
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
    // 挂起的动作是否 idle 组:等待态判定用(见 canPlay)。idle 循环算等待态,其他动作播放中不算
    this.idleGroup = model.internalModel.motionManager?.groups?.idle ?? 'idle'
    this.pendingIdle = false
    // 白名单钩子：拖拽参数机编排器（L2dStage 挂载后注入）——游戏 Lua 层的 checkEnablePlay 对一切动作播放生效（enable/ignore 名单存 clip 名），这里前置到 canPlay，供命中路径与 playHitMotion 的组内选支共用
    this.checkEnable = null
    if (interaction) {
      const manager = model.internalModel.motionManager
      manager.on('motionStart', (group, index) => this.trackMotionStart(group, index))
      manager.on('motionFinish', () => this.trackMotionFinish())
    }
  }

  /** moc 默认值（按参数 id；模型里不存在的参数没有默认值，按 0 处理，与 paramValue 的虚拟下标行为一致） */
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

  /** 起播：先结算被顶掉的挂起动作，再挂起新动作。idle 变体是循环动作、永不 motionFinish，其开关状态（微笑眼等 idle 姿态预设）在起播瞬间即生效并持续整个循环——立即落账进节点，否则变体循环期间节点缺这份状态，依赖它的分支（如 touch_idle14 要求 ParamEyeLSmile=1）会被门控与 HUD 误判成不可达（游戏里参数由曲线实时驱动，起播即为此值） */
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

  /** 把 clip 的结束值写进节点——有向图中沿这条边走一步。开关参数只写节点域内（statePids）的：end-only 参数（起播恒 0，如 sdrtx）由 resetParameters 的常规复位管理，写入节点会让它永久残留；连续摆位参数（carryPids）同样按结束值落账——收尾分支带回 0 的也写，节点随之清零 */
  applyEnd(clipName) {
    if (!clipName) return
    // 竞态序号：表外补全异步落账，只允许最后一次 applyEnd 的补全生效
    const seq = (this._applyEndSeq = (this._applyEndSeq ?? 0) + 1)
    const clip = this.interaction?.clips?.[clipName]
    const state = clip?.state ?? {}
    const carry = clip?.carry ?? {}
    for (const [pid, [, end]] of Object.entries(state)) {
      if (this.statePids.has(pid)) this.node.set(pid, end)
    }
    for (const [pid, [, end]] of Object.entries(carry)) {
      if (this.carryPids.has(pid)) this.node.set(pid, end)
    }
    this._syncBoundary(clipName, state, carry, seq)
  }

  /** 表外补全：节点跟随本支动作**实际驱动**的状态/摆位参数。state/carry 表剔除了首末均为 0 的开关（extract.py clip_boundary_state），但那正是有向图的回零边——基础 idle 曲线恒 0 而无表项时，节点学不到"已归零"，起播缓动会按滞留的旧节点值把开关再次摆出；对表里没记的参数按 motion3 真实末值补账，边界数据与提取同源（同一份 motion3 文件），无需重新提取 */
  _syncBoundary(clipName, state, carry, seq) {
    this.loadMotionBoundary(clipName).then((boundary) => {
      if (!boundary || seq !== this._applyEndSeq) return
      for (const [pid, value] of boundary) {
        if (!(this.statePids.has(pid) || this.carryPids.has(pid))) continue
        if (pid in state || pid in carry) continue
        this.node.set(pid, value)
      }
    })
  }

  /** clip 的参数边界（pid -> 末值）：motion3 曲线段布局 [t0,v0, type, ...]，末元素即曲线终值。挂载时 attachMotions 预热全部 clip，运行期全走缓存，起播缓动不会取到补全前的旧节点值 */
  loadMotionBoundary(clip) {
    this._boundaries ??= new Map()
    let p = this._boundaries.get(clip)
    if (!p) {
      const file = this._clipFiles?.get(clip)
      if (!file || this._motionBase == null) return Promise.resolve(null)
      p = fetch(`${this._motionBase}${file}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((m) => {
          const out = new Map()
          for (const c of m?.Curves ?? []) {
            if (c.Target !== 'Parameter') continue
            const segs = c.Segments
            if (segs?.length >= 2) out.set(c.Id, segs[segs.length - 1])
          }
          return out
        })
        .catch(() => null)
      this._boundaries.set(clip, p)
    }
    return p
  }

  /** clip 驱动的参数 id 集（motion3 全部 Parameter 曲线 Id）：起播缓动的豁免表。与 loadMotionBoundary 同文件各取所需（浏览器 HTTP 缓存去重），解析成功后同步落 _drivenSet */
  loadMotionDriven(clip) {
    this._driven ??= new Map()
    let p = this._driven.get(clip)
    if (!p) {
      const file = this._clipFiles?.get(clip)
      if (!file || this._motionBase == null) return Promise.resolve(null)
      p = fetch(`${this._motionBase}${file}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((m) => {
          const out = new Set()
          for (const c of m?.Curves ?? []) {
            if (c.Target === 'Parameter') out.add(c.Id)
          }
          this._drivenSet ??= new Map()
          this._drivenSet.set(clip, out)
          return out
        })
        .catch(() => null)
      this._driven.set(clip, p)
    }
    return p
  }

  /** clip 驱动参数的下标集（同步读解析缓存；未预热返回 null，调用方按无豁免处理） */
  drivenIdxOf(clip) {
    const set = clip ? this._drivenSet?.get(clip) : null
    if (!set) return null
    const core = this.model.internalModel.coreModel
    const out = new Set()
    for (const pid of set) {
      const idx = core.getParameterIndex(pid)
      if (idx >= 0) out.add(idx)
    }
    return out
  }

  /** 注入动作文件源（mount.js 在 runtime 创建后调）：记录 model3 同目录基址与 clip -> File 映射，并预热全部 clip 的边界缓存 */
  attachMotions(modelUrl) {
    this._motionBase = modelUrl.replace(/[^/]*$/, '')
    this._clipFiles = new Map()
    const motions = this.model.internalModel.settings?.motions ?? {}
    for (const defs of Object.values(motions)) {
      for (const d of defs ?? []) {
        const clip = (d.File ?? '').split('/').pop()?.replace(/\.motion3\.json$/, '')
        if (clip) this._clipFiles.set(clip, d.File)
      }
    }
    for (const clip of this._clipFiles.keys()) {
      this.loadMotionBoundary(clip)
      this.loadMotionDriven(clip)
    }
  }

  /** 节点复位到干净默认态（"重置交互状态"用）：清挂起转移，状态参数全部回 moc 默认；配合拖拽参数机编排器的 resetAll 一起调 */
  resetState() {
    this.node = new Map(
      [...this.preservePids].map((pid) => [pid, this.paramDefault(pid)]),
    )
    this.pending = null
    this.pendingIdle = false
  }

  /** 中性节点：全部开关状态参数都贴着 moc 默认值（无任何跨动作残留）。只查开关参数：连续摆位（姿态/位移）几乎总被某支动作残留，参与判定会让"分支挂起"永不解除、idle 永不回落 */
  isNeutral() {
    for (const pid of this.statePids) {
      const value = this.node.get(pid) ?? 0
      if (Math.abs(value - this.paramDefault(pid)) > this.eps) return false
    }
    return true
  }

  /**
   * 从网格级命中结果里挑第一个可用分区。入参来自 meshHitTest（已按渲染序排好、视觉最上层在前），本方法只做手势区分（与游戏一致）：一次 raycast 会同时命中 idle/head/body 与 drag 两族分区，控制器按手势挑族——点击取非 drag 分区，拖拽只取 drag 分区。
   * 不做透明度过滤：游戏 GetTouchPart/GetDragPart 与 CubismRaycaster 都是纯几何射线，隐藏但在位的判定网格照样响应（baifeng_2 idle17 隐藏标记实机可拖，见 gestures.js machineZonesAt 注释）。
   *
   * @param {string[]} names 命中的分区名（meshHitTest 的返回）
   * @param {'tap'|'drag'} gesture
   */
  firstVisibleHit(names, gesture = 'tap') {
    const areas = this.model.internalModel.hitAreas ?? {}
    const wantDrag = gesture === 'drag'
    for (const name of names) {
      const index = areas[name]?.index
      if (index === undefined) continue
      if (name.startsWith('touch_drag') !== wantDrag) continue
      return name
    }
    return ''
  }

  /**
   * 点击门控：与跟踪节点比对而非实时参数（实时值受逐帧曲线与眨眼/呼吸扰动）。前置只取起播值=1 且可产出的开关（见构造函数 gatedPids）——起播值=1 意味着动作依赖该图层/道具已摊开/已持有（如菜单分支以 caidan=1 起播，仅菜单摊开时合法），不符（如菜单收起时点菜单项）则不可触发。未收录/无开关参数的反应动作（touch_drag 系等，extract.py 只落盘有事件或边界数据的 clip）在游戏里由控制器状态而非参数门控。
   * 手势只在等待态被处理（动作播放中途控制器不响应手势，见下方实现）：idle 循环算等待态（pendingIdle），反应动作播完由编排器显式回落 idle、等待态即恢复；菜单摊开后的拖拽分支在 pending 清空后照常可达。
   */
  canPlay(clipName) {
    if (this.checkEnable && !this.checkEnable(clipName)) return false
    if (!this.interaction) return true
    // 手势只在等待态被处理：反应动作播出期间一切命中触发不放行（游戏内 touch_head 播完前点 touch_body/head 一律无响应，仅"重置交互"入口豁免——resetInteraction 直写路径不过这里）
    // 该检查须对有/无 state 条目的 clip 一致生效，不能只写在无 state 分支——否则有 state 的动作可被中途顶掉；菜单摊开后的拖拽不受影响——touch_idle1 播完 pending 即清空，拖拽分支（机器路径为主）照常响应
    if (!(this.pending === null || this.pendingIdle)) return false
    const state = this.interaction.clips?.[clipName]?.state
    if (!state || !Object.keys(state).length) return true
    for (const [pid, [start]] of Object.entries(state)) {
      if (start !== 1 || !this.gatedPids.has(pid)) continue
      if (Math.abs((this.node.get(pid) ?? 0) - 1) > this.eps) return false
    }
    return true
  }

  /**
   * 平滑复位登记（motionStart 触发）：目的与 resetParameters 相同——非状态参数回 moc3 默认、状态机参数对齐到跟踪节点，防止上一支动作遗留的图层/道具开关（如 ParamCrusLLayer2、heiping）污染后续动作。
   * 落笔方式为登记一个与动作渐变同窗口的缓动复位，由 applySmoothReset 每帧落笔——未驱动参数缓动到默认/节点值，两头都无跳变；硬写会毁掉交叉渐变的混合起点。resetParameters（硬写）保留给挂载入口——模型未揭幕时硬写无示人瞬跳。
   * 新动作（clip）曲线驱动的参数整段豁免：引擎渐入以参数缓冲当前值为混合基线逐帧混入曲线（起播时旧动作已被终写），复位在这些参数上不落笔，混合基线即上一支动作的实际末态——与游戏动作间不复位参数的语义一致；缓存未预热时无豁免表、全量复位。
   *
   * @param {number} [durationSec] 缓动窗口（秒）：mount.js 按起播 clip 从 fades.json 查传入，与新动作渐入严格同窗；0 秒转场（login/home/change_* 硬切）同帧瞬跳落定，等价硬写
   * @param {string|null} [clip] 新起播动作的 clip 名，驱动参数豁免表由此解析
   */
  beginSmoothReset(durationSec = RESET_FADE, clip = null) {
    const core = this.model.internalModel.coreModel
    const exempt = this.drivenIdxOf(clip)
    const entries = []
    const count = core.getParameterCount()
    for (let i = 0; i < count; i++) {
      if (this.preserveIdx.has(i) || exempt?.has(i)) continue
      const from = core.getParameterValueByIndex(i)
      const target = core.getParameterDefaultValue(i)
      if (from !== target) entries.push({ idx: i, from, target })
    }
    // 状态机/摆位参数：实时值偏离节点（打断残留，如菜单摊到一半）时缓动对齐到协议态；与硬写路径相同的节点读取时机（先于 trackMotionStart 结算被顶掉的挂起动作），语义不变只是落笔变缓；新动作驱动的参数同豁免
    for (const [pid, value] of this.node) {
      const idx = core.getParameterIndex(pid)
      if (idx < 0 || idx >= core.getParameterCount() || exempt?.has(idx)) continue
      const from = core.getParameterValueByIndex(idx)
      if (from !== value) entries.push({ idx, from, target: value })
    }
    if (durationSec <= 0) {
      // 0 秒转场（login/home/change_* 硬切）：同帧瞬跳落定，等价旧版硬写
      for (const e of entries) core.setParameterValueByIndex(e.idx, e.target)
      this._resetTween = null
      return
    }
    this._resetTween = { start: performance.now() / 1000, duration: durationSec, entries }
  }

  /** 平滑复位缓动是否仍在窗口内：挂载揭幕（mount.js）据此等初始 idle 的复位缓动走完才示人 */
  get resetPending() {
    return !!this._resetTween
  }

  /** 平滑复位每帧落笔（挂 beforeMotionUpdate：写在动作求值前——新动作曲线同帧按渐变权重混合本帧写入值，权重升满后全权接管；物理/氛围/机器层在动作求值后各自写入，不受影响）。缓动曲线与内核渐变同款 sine */
  applySmoothReset() {
    const tween = this._resetTween
    if (!tween) return
    const t = (performance.now() / 1000 - tween.start) / tween.duration
    const core = this.model.internalModel.coreModel
    if (t >= 1) {
      // 末帧补齐目标值再收窗：t 一旦越窗（帧尖峰）最后一笔 k 可能未到 1
      for (const e of tween.entries) core.setParameterValueByIndex(e.idx, e.target)
      this._resetTween = null
      return
    }
    const k = 0.5 - 0.5 * Math.cos(Math.PI * t)
    for (const e of tween.entries) {
      core.setParameterValueByIndex(e.idx, e.from + (e.target - e.from) * k)
    }
  }

  /** 按节点硬复位参数（挂载入口专用，模型未揭幕，瞬跳不示人）：非状态机参数回到 moc3 默认值，状态机参数对齐到跟踪节点的值；动作起播与重置交互的可见路径走 beginSmoothReset（见其注释） */
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
   * 命中区名 -> 动作播放（MotionPriority.FORCE）。分区名即动作文件名（见 extract.py 的 HitAreas 生成）：touch_idle3/touch_drag5 等分区各对应组里的具体一支，点哪个部位播哪支；摸头/普通触摸等则恰好有同名组。
   * 分区对应动作被门控挡下时，在组内随机挑一支当前可达的；组内全部不可达则不播——这还原了游戏"点特定地方进入交互"的状态机行为：菜单收起时点触摸区会播 touch_idle1（摊开菜单），菜单摊开时点对话区播对应分支，点完收尾分支后回到可再进入的状态。
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
