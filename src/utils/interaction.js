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
 * - 点击门控：每支动作的起播边界即其可达前置状态（touch_idle2/4/6/8 以
 *   caidan=1 起播，仅菜单摊开时是合法分支）。
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
    const core = model.internalModel.coreModel
    this.preserveIdx = new Set(
      [...this.statePids]
        .map((pid) => core.getParameterIndex(pid))
        .filter((i) => i >= 0 && i < core.getParameterCount()),
    )
  }

  /** 当前参数值（按参数 id；模型里不存在的参数经核心映射为虚拟下标，值为 0） */
  paramValue(pid) {
    return this.model.internalModel.coreModel.getParameterValueById(pid)
  }

  /**
   * 命中检测只看网格包围盒，不判断透明度，隐藏部位（其他姿态的判定网格、
   * 摆位零件）也会响应；这里按 drawable 不透明度过滤，只保留可见命中区。
   */
  firstVisibleHit(names) {
    const core = this.model.internalModel.coreModel
    const areas = this.model.internalModel.hitAreas ?? {}
    const hasOpacity = typeof core.getDrawableOpacity === 'function'
    for (const name of names) {
      const index = areas[name]?.index
      if (index === undefined) continue
      if (!hasOpacity || core.getDrawableOpacity(index) > 0.001) return name
    }
    return ''
  }

  /**
   * 点击门控：动作的开关型参数起播值即其可达前置状态（游戏按参数连续性
   * 授权交互）。当前状态与起播边界不符（如菜单收起时点菜单项）则不可触发。
   */
  canPlay(clipName) {
    const state = this.interaction?.clips?.[clipName]?.state
    if (!state) return true
    for (const [pid, [start]] of Object.entries(state)) {
      if (Math.abs(this.paramValue(pid) - start) > 0.05) return false
    }
    return true
  }

  /**
   * 把参数复位到 moc3 默认值——但跳过状态机参数（preserveIdx）。
   * 游戏内每个 AnimationClip 都假定从默认姿态起播；而 idle 组只覆盖约 1/5
   * 的参数，若不复位，上一支动作遗留的图层/道具开关（如 ParamCrusLLayer2、
   * heiping）会持续污染后续动作，产生穿模、碎片残影等渲染错误。
   * 在 motionStart 时调用可确保动作首次求值前参数是干净的（update 的
   * loadParameters 只恢复到"上一帧动作求值后"的值，不会冲掉这里写入的值）。
   */
  resetParameters() {
    const core = this.model.internalModel.coreModel
    const count = core.getParameterCount()
    for (let i = 0; i < count; i++) {
      if (this.preserveIdx.has(i)) continue
      core.setParameterValueByIndex(i, core.getParameterDefaultValue(i))
    }
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
 * 网格中心——绿 = 可点（起播门控通过）、红 = 被门控挡下、隐藏网格（如
 * 菜单收起时的菜单项）不显示；位置每帧跟随模型。
 *
 * @param app pixi Application（提示层挂到其 stage）
 * @param getRuntime () => InteractionRuntime | null，每帧取当前运行时
 * @param getVisible () => boolean，提示层开关
 * @returns {{ rebuild(model): void, destroy(): void, update(): string }}
 *   update 每帧调用，返回 HUD 文本（状态机参数实时值，供测试对照）
 */
export function createInteractionHints(app, getRuntime, getVisible) {
  let layer = null
  let hints = []

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
        const verts = runtime.model.internalModel.getDrawableVertices(h.idx)
        let cx = 0
        let cy = 0
        for (let j = 0; j < verts.length; j += 2) {
          cx += verts[j]
          cy += verts[j + 1]
        }
        const n = verts.length / 2
        const g = runtime.model.toGlobal({ x: cx / n, y: cy / n })
        h.dot.visible = h.label.visible = true
        h.dot.position.set(g.x, g.y)
        h.dot.clear()
        h.dot.beginFill(runtime.canPlay(h.name) ? 0x4fc08d : 0xe05555, 0.35)
        h.dot.drawCircle(0, 0, 9)
        h.dot.endFill()
        h.label.position.set(g.x + 12, g.y - 7)
      }
      const parts = [...runtime.statePids].map(
        (pid) => `${pid}=${Math.round(runtime.paramValue(pid))}`,
      )
      return parts.join('  ')
    },
  }
}
