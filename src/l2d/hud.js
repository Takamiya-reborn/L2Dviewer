/**
 * 每帧回调：拖拽参数机步进 + 交互点提示更新 + HUD 结构化读数组装（写入 ctx.hud.value，展示层按组分节排版）。
 * 读 ctx.orch / ctx.hintsCtl / ctx.dragScale。
 */
import { diffMotion } from './motionDiff.js'
import { createParamOverride } from './paramOverride.js'

/** motion3 JSON 按 clip 缓存：File 名从模型动作定义反查（clip 名与组名不一致时组内同名反查会落空，如 touch_idleN 收在 touch_idle 组） */
const motionJsonCache = new Map()

/** 强播 clip 名单：模型全部动作（诊断用），按模型实例缓存 */
let playClipsModel = null
let playClips = []
function ensurePlayClips(ctx) {
  const settings = ctx.model?.internalModel?.settings
  if (!settings?.motions) return []
  if (playClipsModel !== ctx.model) {
    playClipsModel = ctx.model
    playClips = Object.values(settings.motions)
      .flatMap((defs) => (defs ?? []).map((d) => (d.File ?? '').split('/').pop()?.replace(/\.motion3\.json$/, '') ?? ''))
      .filter(Boolean)
      .sort()
  }
  return playClips
}

/** 在播动作的 motion3 JSON（未取回返回 null）；URL 经 settings.resolveURL 与动作加载同源 */
function ensureMotionJson(ctx, clip) {
  if (motionJsonCache.has(clip)) return motionJsonCache.get(clip)
  const settings = ctx.model?.internalModel?.settings
  if (!settings?.motions) return null
  const base = clip.replace(/\.motion3\.json$/, '')
  for (const defs of Object.values(settings.motions)) {
    const def = (defs ?? []).find((d) => (d.File ?? '').split('/').pop()?.replace(/\.motion3\.json$/, '') === base)
    if (!def) continue
    // 取回是异步的：先落 null 占位（同步路径直接短路），落账后原地替换成 JSON，下一次采样起同步可读
    motionJsonCache.set(clip, null)
    fetch(settings.resolveURL(def.File))
      .then((res) => res.json())
      .then((json) => motionJsonCache.set(clip, json?.Meta && json.Curves ? json : null))
      .catch(() => motionJsonCache.set(clip, null))
    return null
  }
  return null
}

/**
 * 在播动作差分读数：循环本地时间由引擎侧队列条目给出（_startTimeSeconds 内核首帧落账、
 * 与 doUpdateMotion 同钟即 model.elapsedTime），混合权重直读 _stateWeight。
 * @returns {{clip, t, duration, weight, rows, count} | null}
 */
function motionDiffReadout(ctx) {
  const orch = ctx.orch
  const clip = orch?.playingClip
  if (!clip || !ctx.model) return null
  const entries = ctx.model.internalModel?.motionManager?.queueManager?._motions
  const entry = entries?.[entries.length - 1]
  if (!entry?._motion || entry._startTimeSeconds < 0) return null
  const json = ensureMotionJson(ctx, clip)
  if (!json?.Meta || !json.Curves) return null
  const duration = json.Meta.Duration ?? 0
  // 循环动作内核自回卷：本地时间按动作时长取模；非循环钳到末点
  let t = ctx.model.elapsedTime / 1000 - entry._startTimeSeconds
  t = json.Meta.Loop && duration > 0 ? t % duration : Math.min(t, duration)
  const { rows, count } = diffMotion(ctx.model, json, t)
  return {
    clip,
    t,
    duration,
    weight: entry._stateWeight,
    rows: rows.slice(0, 10),
    count,
  }
}

/** 覆盖参数的 HUD 读数：量程取自 moc3 参数表，live 为落笔实值快照；空表也返回（面板要能添加首项） */
function overrideReadout(ctx) {
  const ov = ctx.paramOverride
  const core = ctx.model?.internalModel?.coreModel
  if (!ov || !core) return null
  const list = []
  for (const [id, e] of ov.entries) {
    const idx = core.getParameterIndex(id)
    if (idx < 0) {
      list.push({ id, value: e.value, on: e.on, missing: true })
      continue
    }
    list.push({
      id,
      value: e.value,
      on: e.on,
      min: core.getParameterMinimumValue(idx),
      max: core.getParameterMaximumValue(idx),
      live: ctx.paramOverrideLive?.get(id) ?? core.getParameterValueByIndex(idx),
    })
  }
  return { list, set: ov.set, toggle: ov.toggle, remove: ov.remove }
}

/** 模型全参数清单（注入面板备选，点行即注入）：id/量程/默认值按模型实例缓存，实值每帧快照（update 后 save/load 还原成动作基值） */
let paramListModel = null
let paramListDefs = []
function paramListReadout(ctx) {
  const core = ctx.model?.internalModel?.coreModel
  if (!core) return null
  if (paramListModel !== ctx.model) {
    paramListModel = ctx.model
    // 参数 ID 表在裸核心模型上（框架 CubismModel 没有 getParameterIds，那是 EyeBlink 的方法）
    const raw = core.getModel()
    const count = raw.parameters.count
    paramListDefs = []
    for (let i = 0; i < count; i++) {
      paramListDefs.push({
        id: raw.parameters.ids[i],
        min: core.getParameterMinimumValue(i),
        max: core.getParameterMaximumValue(i),
        def: core.getParameterDefaultValue(i),
      })
    }
  }
  return paramListDefs.map((p) => ({ ...p, value: core.getParameterValueById(p.id) }))
}

/**
 * @param ctx 舞台上下文（见 L2dStage.vue）
 * @returns {(deltaMS: number) => void} 挂到 pixi ticker 的回调
 */
export function createTickerCallback(ctx) {
  ctx.paramOverride ??= createParamOverride()
  let lastDiffAt = 0
  // 差分采样已注册的模型实例：每次挂载换新模型，逐模型注册一次 beforeModelUpdate 钩子
  let diffModel = null
  return () => {
    // 拖拽参数机每帧步进（平滑趋近/回弹倒计时/点击确认窗口/触发调度）
    ctx.orch?.step(ctx.app.ticker.deltaMS / 1000)
    const live = ctx.hintsCtl.update()
    const rt = ctx.runtime
    // 动作差分采样挂 beforeModelUpdate 事件（低频 0.12s 窗）：该事件在主动作/视线/物理/机器各层落笔之后、
    // 内核 update() 之前触发——update 返回后 save/load 已把参数还原成动作基值，事后读数看不到叠加层
    if (ctx.model && diffModel !== ctx.model) {
      diffModel = ctx.model
      ctx.model.internalModel.on('beforeModelUpdate', () => {
        const now = performance.now()
        if (now - lastDiffAt >= 120) {
          lastDiffAt = now
          ctx.motionDiff = motionDiffReadout(ctx)
        }
        // 参数覆盖层在差分采样之后落笔：注入值压过动作/物理/机器/视线全部层，也不污染差分读数
        const core = ctx.model.internalModel.coreModel
        ctx.paramOverride.apply(core)
        // 落笔实值在 update 前快照：update 返回后 save/load 已把参数还原成动作基值，事后读数看不到落笔值
        const live = (ctx.paramOverrideLive ??= new Map())
        live.clear()
        for (const id of ctx.paramOverride.entries.keys()) live.set(id, core.getParameterValueById(id))
      })
    }
    ctx.hud.value = {
      zones: live?.state ?? [],
      carried: live?.carried ?? [],
      rings: live?.rings ?? [],
      dots: live?.dots ?? [],
      machine: ctx.orch?.hudInfo() ?? null,
      scale: ctx.dragScale,
      // 挂起/播放中的动作（有向图 pending）：对照特效开关读数与动作的对应关系
      // idleFallback = 最近一次 idle 起播的路由依据（显式路由/引擎回落/来源）
      motion: rt
        ? { name: rt.pending, idle: rt.pendingIdle, fallback: ctx.idleFallback ?? null }
        : null,
      // 在播动作参数差分（曲线应值 vs 模型实值）
      motionDiff: ctx.motionDiff ?? null,
      // 参数覆盖层（注入测试）：增删改由 HudPanel 直调，量程/实值每帧读数
      override: overrideReadout(ctx),
      // 模型全参数清单（注入备选）：点行注入，过滤在展示层做
      paramList: paramListReadout(ctx),
      // 强播入口（诊断）：任意 clip 直接起播，走 playLuaAction 全套路由入账，差分面板随动
      play: ctx.actions ? { clips: ensurePlayClips(ctx), run: (name) => ctx.actions.playLuaAction(name) } : null,
      // 调色板：面板开合（BANZI）+ 色轴实时值 + 循环/复位回调（HudPanel 点击用）
      palette: ctx.palette
        ? {
            ...ctx.palette.read(),
            cycle: (id) => ctx.palette.cycle(id),
            reset: () => ctx.palette.reset(),
          }
        : null,
    }
  }
}
