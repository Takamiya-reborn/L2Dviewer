/**
 * 全管线仿真 harness：真实 InteractionRuntime + DragOrchestrator + createActions
 * 代码 + 真实 moc3 参数表 + 真实 motion3 采样，在 node 里按 60fps 复现 viewer
 * 的帧循环（restoreLayer -> motion 曲线 -> applyLayer）。probe/simulate.mjs 与
 * 场景脚本共用，装配顺序与 mount.js 对齐。
 */
import fs from 'fs'
import path from 'path'
import { loadMocModel } from './cubism.mjs'
import { loadMotion, sampleCurve } from './motion3.mjs'

/**
 * @param {string} dir 皮肤目录（含 <name>.moc3 / .model3.json / .l2d.json /
 *        .interaction.json）
 * @param {object} opts
 * @param {string} [opts.name]            皮肤名，默认取目录名
 * @param {number} [opts.dt]              步长，默认 1/60
 * @param {number} [opts.idleCooldown]    idle 回落节流，默认 0.3（仿库内）
 * @param {Function|null} [opts.debugHook] orchestrator 的 [tap] 调试钩子
 * @param {Function} [opts.log]           动作播放日志出口（默认收集进 motionLog）
 * @returns 各装配件 + step/playSeconds/clickZone 场景原语
 */
export async function createPipelineSim(dir, {
  name = path.basename(dir),
  dt = 1 / 60,
  idleCooldown = 0.3,
  debugHook = null,
  log = null,
} = {}) {
  // Core 先加载（pixi-live2d-display 在模块求值时检查 window.Live2DCubismCore），
  // src 模块随后动态 import
  const { model } = await loadMocModel(dir)
  const { InteractionRuntime } = await import('../../../src/utils/interaction/runtime.js')
  const { DragOrchestrator } = await import('../../../src/utils/dragmachine/orchestrator.js')
  const { createActions } = await import('../../../src/l2d/actions.js')

  const P = model.parameters
  const count = P.count

  // ---- coreModel 适配器（InteractionRuntime/DragOrchestrator 用到的接口）----
  const idxOfId = new Map(P.ids.map((id, i) => [id, i]))
  const values = new Float32Array(count)
  for (let i = 0; i < count; i++) values[i] = P.defaultValues[i]
  const core = {
    getParameterIndex: (pid) => idxOfId.get(pid) ?? -1,
    getParameterCount: () => count,
    getParameterDefaultValue: (i) => P.defaultValues[i],
    getParameterValueByIndex: (i) => values[i],
    setParameterValueByIndex: (i, v) => {
      values[i] = Math.min(P.maximumValues[i], Math.max(P.minimumValues[i], v))
    },
    getParameterValueById: (pid) => {
      const i = idxOfId.get(pid)
      return i === undefined ? 0 : values[i]
    },
    setParameterValueById: (pid, v) => {
      const i = idxOfId.get(pid)
      if (i !== undefined) core.setParameterValueByIndex(i, v)
    },
  }
  const model3 = JSON.parse(fs.readFileSync(`${dir}/${name}.model3.json`, 'utf8'))
  const settings = { motions: model3.FileReferences.Motions }
  const stubModel = { internalModel: { coreModel: core, settings, motionManager: null } }

  // 事件总线：MotionManager.on 仿真（InteractionRuntime 构造时挂 motionStart/motionFinish）
  const listeners = { motionStart: [], motionFinish: [] }
  let active = null // {group,index,clip,t,loop,duration}
  stubModel.internalModel.motionManager = {
    groups: { idle: 'idle' },
    on: (ev, fn) => listeners[ev]?.push(fn),
    emit: (ev, ...args) => { for (const fn of listeners[ev] ?? []) fn(...args) },
    stopAllMotions: () => { active = null }, // 仿库内：清队列 + state.reset
  }

  // ---- 动作播放仿真（pixi-live2d-display 库行为的最小还原）----
  let now = 0
  // 机器内部（onDown/onUp/step 的 clickTriggerTime 等）用 performance.now()，
  // 这里统一替换成仿真时钟，否则压缩时间轴下点击窗口永不命中
  globalThis.performance = { now: () => now * 1000 }
  const motionLog = []
  const emitLog = log ?? ((line) => motionLog.push(line))

  // ---- 装配（对应 mount.js）----
  const interaction = JSON.parse(fs.readFileSync(`${dir}/${name}.interaction.json`, 'utf8'))
  // mount.js 注册顺序：resetParameters 先于 runtime 的 trackMotionStart
  stubModel.internalModel.motionManager.on('motionStart', () => runtime?.resetParameters())
  const runtime = new InteractionRuntime(stubModel, interaction)
  const l2d = JSON.parse(fs.readFileSync(`${dir}/${name}.l2d.json`, 'utf8'))
  const ctx = { model: stubModel, orch: null, runtime, currentMotion: { value: '' }, lastGesture: 'tap' }

  function startMotion(group, index) {
    const clip = (settings.motions[group][index].File ?? '').split('/').pop().replace(/\.motion3\.json$/, '')
    const m = loadMotion(dir, clip)
    active = { group, index, clip, t: 0, loop: !!m.Meta.Loop, duration: m.Meta.Duration }
    emitLog(`[start] ${now.toFixed(2)} ${clip}${group === runtime.idleGroup ? '(idle)' : ''} idleIndex=${orch?.idleIndex}`)
    // motionStart 事件经总线按 mount.js 注册顺序分发
    stubModel.internalModel.motionManager.emit('motionStart', group, index)
  }
  function finishMotion() {
    const clip = active.clip
    active = null
    emitLog(`[finish] ${now.toFixed(2)} ${clip}`)
    stubModel.internalModel.motionManager.emit('motionFinish')
  }

  ctx.actions = createActions(ctx)
  // createActions 里 model.motion(group,index,priority)：FORCE 恒播，从简
  stubModel.motion = (group, index) => {
    startMotion(group, index)
    return Promise.resolve(true)
  }
  const orch = new DragOrchestrator(stubModel, l2d, ctx.actions.playLuaAction)
  orch.debugHook = debugHook
  ctx.orch = orch
  runtime.checkEnable = (n) => orch.checkEnablePlay(n)
  stubModel.internalModel.motionManager.on('motionStart', (g, i) =>
    orch.noteMotionStart(runtime.clipOf(g, i), g === runtime.idleGroup))
  stubModel.internalModel.motionManager.on('motionFinish', () => orch.noteMotionFinish())

  // ---- 帧循环 ----
  let idleFallbackCooldown = 0
  function step() {
    now += dt
    orch.step(dt)
    if (active) {
      // 库内每帧：beforeMotionUpdate(restoreLayer) -> 曲线 -> afterMotionUpdate(applyLayer)
      orch.restoreLayer(core)
      const m = loadMotion(dir, active.clip)
      const t = Math.min(active.t, active.duration)
      for (const c of m.Curves) {
        if (c.Target !== 'Parameter') continue
        core.setParameterValueById(c.Id, sampleCurve(c.Segments, t))
      }
      orch.applyLayer(core)
      active.t += dt
      if (!active.loop && active.t >= active.duration) finishMotion()
    } else {
      idleFallbackCooldown -= dt
      if (idleFallbackCooldown <= 0) {
        // 补丁版 startRandomMotion：orch 存在时按 idleClipFor(idleIndex) 解析
        const clip = orch.idleClipFor(orch.idleIndex)
        const defs = settings.motions[runtime.idleGroup] ?? []
        const base = defs.findIndex((d) => (d.File ?? '').split('/').pop() === clip + '.motion3.json')
        startMotion(runtime.idleGroup, Math.max(base, 0))
        idleFallbackCooldown = idleCooldown // 仿库内回落节流
      }
    }
  }

  const flush = () => new Promise((r) => setImmediate(r))
  async function clickZone(zone, hold = 0.15) {
    orch.onDown(zone, { x: 0, y: 0 })
    const until = now + hold
    while (now < until) { step(); await flush() }
    orch.onUp(zone, { x: 0, y: 0 })
    await flush()
  }
  async function playSeconds(sec) {
    const until = now + sec
    while (now < until) { step(); await flush() }
  }

  return {
    dir, name, model, P, count, idxOfId, values, core,
    stubModel, settings, interaction, l2d,
    runtime, orch, ctx, actions: ctx.actions,
    motionLog, loadMotion, sampleCurve, flush,
    step, clickZone, playSeconds,
    now: () => now,
  }
}
