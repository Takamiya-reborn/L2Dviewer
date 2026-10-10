/**
 * 模型挂载编排：销毁旧模型 -> Live2DModel.from -> 依序装配氛围层、交互
 * 状态机、拖拽参数机 -> 初始 idle -> 取景适配 -> 上报动作组。写回
 * ctx.model / ctx.runtime / ctx.orch / ctx.l2dOffset / ctx.hasOrch。
 */
import { Live2DModel } from 'pixi-live2d-display/cubism4'
import { loadAmbient } from '../utils/ambient'
import { DragOrchestrator, loadL2dConfig } from '../utils/dragmachine'
import { InteractionRuntime, loadInteraction } from '../utils/interaction'

/**
 * @param ctx 舞台上下文（见 L2dStage.vue）：要求 ctx.camera（camera.js）、
 *   ctx.actions（actions.js）、ctx.hintsCtl（hints 提示层控制器）已就位
 * @param {string} url 模型 model3.json 地址
 */
export async function mountModel(ctx, url) {
  try {
    await mountModelInner(ctx, url)
  } catch (err) {
    // 挂载失败不静默——任何一步出错都显式上报
    console.error('[l2d] 模型挂载失败', err)
    ctx.status.value = `加载失败:${err?.message ?? err}`
  }
}

async function mountModelInner(ctx, url) {
  // 挂载时序令牌：挂载内有多个 await（Live2DModel.from 要数秒），快速连续
  // 切皮肤时两个挂载交错——先启动的后完成，会把 ctx.model/runtime/orch 覆盖
  // 成旧实例、新旧两只模型同时滞留舞台（后加者在上面），交互/HUD/复位全绑
  // 到看不见的那只（实测即"切过皮肤后状态卡死、重置交互无效"）。每次挂载
  // 自增，任何 await 醒来发现令牌过期就丢弃自己的模型直接退出
  const seq = (ctx._mountSeq = (ctx._mountSeq ?? 0) + 1)
  const stale = () => seq !== ctx._mountSeq
  const app = ctx.app
  ctx.status.value = '加载模型…'
  ctx.hintsCtl.destroy()
  if (ctx.model) {
    app.stage.removeChild(ctx.model)
    ctx.model.destroy()
    ctx.model = null
  }
  // 新模型先按"无状态机"处理（interaction.json 就绪后运行时才接管；
  // 首支动作起播若早于数据就绪，模型本来就是干净的默认参数，无需复位）
  ctx.runtime = null
  ctx.orch = null
  ctx.l2dOffset = null
  ctx.hasOrch.value = false
  const model = await Live2DModel.from(url, {
    autoInteract: false,
    idleMotionGroup: 'idle', // 本项目 idle 组为小写（Cubism 默认是 "Idle"）
  })
  if (stale()) {
    model.destroy()
    return
  }
  ctx.model = model
  model.internalModel.motionManager.on('motionStart', () => ctx.runtime?.resetParameters())
  // 常驻氛围层：effect 组（垂发/扶手布的微风摆动）在游戏内永远循环叠加，
  // 这里挂在 afterMotionUpdate（主动作求值后、saveParameters 前）直写参数，
  // 物理与姿态系统不触碰这些参数，故不会与本层互相覆盖；
  // effect 缺失/加载失败只跳过本层，不应中断整个挂载
  try {
    const ambient = await loadAmbient(url, model.internalModel.settings)
    if (stale()) {
      model.destroy()
      return
    }
    if (ambient) {
      const core = model.internalModel.coreModel
      model.internalModel.on('afterMotionUpdate', () => ambient.apply(core, performance.now() / 1000))
    }
  } catch (err) {
    console.warn('[l2d] 常驻氛围层加载失败,已跳过', err)
  }
  app.stage.addChild(model)
  // 交互状态机：数据与模型同目录（<id>.interaction.json，本项目扩展产物），
  // 加载失败时运行时全旁路（参数全量复位、点击不做门控），退化为旧行为
  const interaction = await loadInteraction(url)
  if (stale()) {
    model.destroy()
    return
  }
  ctx.runtime = new InteractionRuntime(model, interaction)
  // 拖拽参数机：数据与模型同目录（<id>.l2d.json，bake_l2d.py 烘焙产物）；
  // 播放回调解析 clip 名 -> 动作组（白名单里存的是 clip 名，如 touch_idle1、
  // idle1），机器分区命中后由编排器接管路由
  const l2dConfig = await loadL2dConfig(url)
  if (stale()) {
    model.destroy()
    return
  }
  if (l2dConfig) {
    ctx.l2dOffset = l2dConfig.live2d_offset ?? null
    const orch = new DragOrchestrator(model, l2dConfig, ctx.actions.playLuaAction)
    ctx.orch = orch
    // 触发链关键步（拒按/点击判定/豁免/播放/名单）进控制台，供浏览器自测读链路
    orch.debugHook = (s) => console.log('[l2d:tap]', s)
    // 刷新即重置（游戏 ClearLive2dSave 语义：拖拽值回 start_value、idle 归零、
    // 白名单清空、存档清除）。偏离游戏的持久化恢复语义——查看器定位是交叉
    // 测试工具，每次加载从干净态起步，避免上轮测试的档位/状态残留串场
    orch.resetAll()
    ctx.runtime.checkEnable = (name) => orch.checkEnablePlay(name)
    const manager = model.internalModel.motionManager
    manager.on('motionStart', (group, index) =>
      orch.noteMotionStart(ctx.runtime.clipOf(group, index), group === ctx.runtime.idleGroup),
    )
    manager.on('motionFinish', () => orch.noteMotionFinish())
    const core = model.internalModel.coreModel
    model.internalModel.on('beforeMotionUpdate', () => orch.restoreLayer(core))
    model.internalModel.on('afterMotionUpdate', () => orch.applyLayer(core))
    // 挂载即落基础 idle（变体 0）：库的 idle 自启虽经 startRandomMotion 补丁按
    // 当前变体解析，但首帧前 FORCE 抢跑消掉竞态，明确从干净态起步——不然随机
    // 命中摆位变体（如 wuzang_3 组内下标 0 是 idle4）会把摆位判定框一起摆进来
    ctx.actions.playLuaAction(orch.idleClipFor(0))
    ctx.hasOrch.value = true
  }
  ctx.camera.fitModel()
  // drawable 顶点在模型首次 update 时才由核心算出，上面的适配只能拿到陈旧值；
  // 两帧后（顶点就绪、idle 已应用）按真实场景重新适配一次
  requestAnimationFrame(() => requestAnimationFrame(() => ctx.camera.fitModel()))
  ctx.status.value = ''

  // 点击/拖拽 -> 手动做命中检测（autoInteract 已关闭），命中区域 -> 播放对应动作
  // （model.on('hit') 仅作后备：常规路径在 onPointerUp 里用 meshHitTest 精确
  // 命中后直呼 handleHitAreas，绕开 model.tap 内部的包围盒 hitTest）
  model.on('hit', ctx.actions.handleHitAreas)

  // 上报动作组清单，供状态触发面板展示
  ctx.emit('motions', Object.keys(model.internalModel.settings?.motions ?? {}))
  ctx.hintsCtl.rebuild(model)
}
