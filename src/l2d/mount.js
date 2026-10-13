/**
 * 模型挂载编排：Live2DModel.from -> 依序装配氛围层、交互状态机、拖拽参数
 * 机 -> 初始 idle -> 取景适配 -> 上报动作组。写回
 * ctx.model / ctx.runtime / ctx.orch / ctx.l2dOffset / ctx.fades。
 */
import { Live2DModel } from 'pixi-live2d-display/cubism4'
import { Ticker } from 'pixi.js'
import { installColorPatch } from './colorPatches'
import { installPalette } from './palette'
import { loadAmbient } from '../utils/ambient'
import { DragOrchestrator, loadL2dConfig } from '../utils/dragmachine'
import { InteractionRuntime, loadInteraction } from '../utils/interaction'

/**
 * @param ctx 舞台上下文（见 L2dStage.vue）：要求 ctx.camera（camera.js）、
 *   ctx.actions（actions.js）、ctx.hintsCtl（hints 提示层控制器）已就位
 * @param {string} url 模型 model3.json 地址
 */
export async function mountModel(ctx, url) {
  ctx._mounting = true
  try {
    await mountModelInner(ctx, url)
  } catch (err) {
    // 挂载失败不静默——任何一步出错都显式上报
    console.error('[l2d] 模型挂载失败', err)
    ctx.status.value = `加载失败:${err?.message ?? err}`
  } finally {
    ctx._mounting = false
  }
}

async function mountModelInner(ctx, url) {
  // 挂载时序令牌：挂载内有多个 await（Live2DModel.from 要数秒），快速连续切皮肤时两个挂载交错——先启动的后完成，会把 ctx.model/runtime/orch 覆盖成旧实例、新旧两只模型同时滞留舞台（后加者在上面），交互/HUD/复位全绑到看不见的那只
  // 每次挂载自增，任何 await 醒来发现令牌过期就丢弃自己的模型直接退出
  const seq = (ctx._mountSeq = (ctx._mountSeq ?? 0) + 1)
  const stale = () => seq !== ctx._mountSeq
  const app = ctx.app
  // per-drawable multiply/screen 渲染补丁（调色板换色的渲染侧，装一次全局生效）
  installColorPatch()
  ctx.status.value = '加载模型…'
  // 上一次挂载可能死在标记设置与起播之间，残留标记会错切新挂载的首支新 clip
  ctx._entryHardCutClip = null
  ctx.hintsCtl.destroy()
  // 旧模型挂载期间保持上台可见（新模型揭幕时再收走），重置/切肤全程无黑屏空窗
  const oldModel = ctx.model
  // 新模型先按"无状态机"处理（interaction.json 就绪后运行时才接管；首支动作起播若早于数据就绪，模型本来就是干净的默认参数，无需复位）
  ctx.runtime = null
  ctx.orch = null
  ctx.l2dOffset = null
  const model = await Live2DModel.from(url, {
    autoInteract: false,
    idleMotionGroup: 'idle', // 本项目 idle 组为小写（Cubism 默认是 "Idle"）
  })
  if (stale()) {
    model.destroy()
    return
  }
  ctx.model = model
  // 装配序列未走完前不上台，揭幕在挂载尾部
  model.visible = false
  // 逐 clip 转场时长表（<id>.fades.json，extract.py 的 animator_fades 从 bundle 的 AnimatorController 提取）：motionPatches.createMotion 按它设置动作渐入时长，动作起播的复位缓动窗口也取同一值——两处严格同源
  // 缺失时全旁路（渐变走 config 兜底 300ms、复位走 RESET_FADE 兜底）
  ctx.fades = await fetch(url.replace(/model3\.json$/, 'fades.json'))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  if (stale()) {
    model.destroy()
    return
  }
  // 动作起播的参数复位改走平滑路径（见 runtime.beginSmoothReset）：瞬跳会毁掉动作交叉渐变的混合起点
  // 落笔钩子在 runtime 创建后挂（下方 beforeMotionUpdate），这里只登记缓动窗口；窗口取起播 clip 的转场时长（trackMotionStart 尚未结算挂起动作，节点读取时机不变）
  // 首个 motionStart 跳过复位：入口参数已硬写干净态，无遗留可清
  // 后续动作照常开窗，清上一支动作的遗留开关；新动作驱动的参数豁免（引擎渐入自带混合，见 beginSmoothReset）
  let firstMotion = true
  model.internalModel.motionManager.on('motionStart', (group, index) => {
    const clip = ctx.runtime?.clipOf(group, index)
    if (firstMotion) {
      firstMotion = false
      return
    }
    ctx.runtime?.beginSmoothReset(
      clip ? (ctx.fades?.transitions?.[clip] ?? ctx.fades?.default ?? undefined) : undefined,
      clip,
    )
  })
  // 常驻氛围层：effect 组（垂发/扶手布的微风摆动）在游戏内永远循环叠加，这里挂在 afterMotionUpdate（主动作求值后、saveParameters 前）直写参数，物理与姿态系统不触碰这些参数，故不会与本层互相覆盖
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
  // 交互状态机：数据与模型同目录（<id>.interaction.json，本项目扩展产物），加载失败时运行时全旁路（参数全量复位、点击不做门控），退化为旧行为
  const interaction = await loadInteraction(url)
  if (stale()) {
    model.destroy()
    return
  }
  ctx.runtime = new InteractionRuntime(model, interaction)
  // 动作边界预热：节点跟随每支动作实际驱动的状态/摆位参数（表外回零边补账）
  ctx.runtime.attachMotions(url)
  // 库的 idle 自启挂在 Ticker.shared（Live2DModel.from 的 init 即注册共享 ticker），首个 tick 早于本行——from 之后这里已串行 await 了氛围层/交互数据，auto idle 的 motionStart 已错过且无人监听；循环 idle 永不 motionFinish、重播同支又被 MotionState.reserve 拒绝，此后再无 motionStart
  // 向 state 的当前动作补一次起播结算（此刻 _clipFiles 已注入，表外边界补全一次到位）；reserve 已留位未 start 的场合（currentGroup 仍空）不补——随后的 motionStart 会落在已注册的监听器上
  const mountState = model.internalModel.motionManager.state
  if (mountState?.currentGroup !== undefined) {
    ctx.runtime.trackMotionStart(mountState.currentGroup, mountState.currentIndex)
  }
  // 调色板控制层（色轴参数 skin 没有时整层旁路）
  installPalette(ctx, model)
  // 平滑复位每帧落笔：先于机器叠加层的 restoreLayer 注册（同事件按注册序触发）——机器加/乘参数的底值还原保持原语义，不被缓动写入覆盖
  model.internalModel.on('beforeMotionUpdate', () => ctx.runtime.applySmoothReset())
  // 拖拽参数机：数据与模型同目录（<id>.l2d.json，extract.py 烘焙产物）；播放回调解析 clip 名 -> 动作组（白名单里存的是 clip 名，如 touch_idle1、idle1），机器分区命中后由编排器接管路由
  const l2dConfig = await loadL2dConfig(url)
  if (stale()) {
    model.destroy()
    return
  }
  // 初始 idle 的 clip 名，揭幕窗口取它的转场时长用
  let entryIdle = null
  // 入口硬切的缓存 motion 句柄，揭幕时恢复其表值转场时长（后续变体切换照常渐入）
  let entryMotion = null
  if (l2dConfig) {
    ctx.l2dOffset = l2dConfig.live2d_offset ?? null
    const orch = new DragOrchestrator(model, l2dConfig, ctx.actions.playLuaAction)
    ctx.orch = orch
    // 触发链关键步（拒按/点击判定/豁免/播放/名单）进控制台，供浏览器自测读链路
    orch.debugHook = (s) => console.log('[l2d:tap]', s)
    // type 10 动作链的归一化进度查 clip 时长（interaction.json clips 表与 Animator 同源）
    orch.clipDurationOf = (clip) => ctx.runtime?.interaction?.clips?.[clip]?.duration
    // 刷新即重置（游戏 ClearLive2dSave 语义：拖拽值回 start_value、idle 归零、白名单清空、存档清除）
    // 偏离游戏的持久化恢复语义——查看器定位是交叉测试工具，每次加载从干净态起步，避免上轮测试的档位/状态残留串场
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
    // 挂载即落基础 idle（变体 0）
    // moc3 默认里触点标记与交互道具摆在其触区/屏内位置，idle 曲线持有它们的屏外泊车位（如 MB_Saliva_Curvature11=1 时 TouchDrag17 网格停在角色身上，曲线值 0 -> 停到屏外）
    // 入口按控制器默认态语义起播：entry state 无转场时长，首支 idle 满权重应用曲线，标记直接出生在泊车位；若走普通渐入，混合窗内标记会从触区横穿屏幕归位
    const wantIdle = orch.idleClipFor(0)
    entryIdle = wantIdle
    manager.stopAllMotions()
    ctx.runtime.resetParameters()
    // auto idle 在 Live2DModel.from 时已创建同支 motion（渐入取 fades 表 0.5s），直接改写其渐入时长；尚未创建的由 createMotion 的一次性标记兜住
    const idleGroup = ctx.runtime.idleGroup
    const defs = model.internalModel.settings?.motions?.[idleGroup] ?? []
    const idx = defs.findIndex((d) => (d.File ?? '').endsWith(`/${wantIdle}.motion3.json`))
    entryMotion = manager.motionGroups?.[idleGroup]?.[idx]
    if (entryMotion) entryMotion.setFadeInTime(0)
    else ctx._entryHardCutClip = wantIdle
    ctx.actions.playLuaAction(wantIdle)
  }
  ctx.camera.fitModel()
  // drawable 顶点在模型首次 update 时才由核心算出，上面的适配只能拿到陈旧值；两帧后（顶点就绪、idle 已应用）按真实场景重新适配一次
  // 入口 idle 为硬切起播（fadeIn=0 满权重），首帧即泊车位，揭幕不等渐入沉降
  // 仅当动作起播开了复位缓动窗（resetPending）时顺延揭幕，3 秒硬上限：门控卡死退化为提前揭幕，不反成永久黑屏
  const revealStart = performance.now()
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      // 挂载过期时本模型可能已上台，须自行收走，避免滞留舞台
      const discard = () => {
        if (ctx.model === model) {
          ctx.model = null
          app.stage.removeChild(model)
          model.destroy()
        }
      }
      if (stale()) {
        discard()
        return
      }
      ctx.camera.fitModel()
      const reveal = () => {
        if (stale()) {
          discard()
          return
        }
        const pending = ctx.runtime?.resetPending
        if (pending && performance.now() - revealStart < 3000) {
          requestAnimationFrame(reveal)
          return
        }
        if (pending) console.warn('[l2d] 揭幕超时: 复位缓动窗口未闭合,强制显示')
        // 入口硬切只作用于起播一瞬，缓存 motion 的转场时长恢复表值，后续变体切换照常渐入
        entryMotion?.setFadeInTime(
          ctx.fades?.transitions?.[entryIdle] ?? ctx.fades?.default ?? 0.3,
        )
        ctx._entryHardCutClip = null
        // 揭幕即收走旧模型：挂载期间旧模型保持可见，重置/切肤全程无黑屏空窗
        if (oldModel && !oldModel.destroyed) {
          app.stage.removeChild(oldModel)
          oldModel.destroy()
        }
        if (ctx.model) ctx.model.visible = true
        ctx.status.value = ''
      }
      reveal()
    }),
  )

  // 临时诊断：挂载后 60 帧内观察更新链。探针挂在 app.ticker（NORMAL 优先级、晚于既有回调），读数判读：
  //   - 探针静默 -> app.ticker 某个回调每帧抛异常，整帧（含渲染）被杀
  //   - 打印但 model.deltaTime≈0 -> Ticker.shared 没在给模型送 tick（autoUpdate 注册/摘除链断），模型停在首帧姿态
  //   - 打印且 deltaTime≈16.7 -> 更新链正常，问题在更深处（motionManager 等）
  let probeFrames = 0
  const probe = () => {
    if (++probeFrames > 60) {
      app.ticker.remove(probe)
      return
    }
    if (probeFrames % 30 === 0) {
      console.log(
        `[l2d] 帧探针 ${probeFrames}: deltaTime=${model.deltaTime.toFixed(1)}` +
        ` Ticker.shared=${Ticker.shared.count}个监听(started=${Ticker.shared.started})` +
        ` autoUpdate=${model.autoUpdate}`,
      )
    }
  }
  app.ticker.add(probe)

  // 点击/拖拽 -> 手动做命中检测（autoInteract 已关闭），命中区域 -> 播放对应动作
  // （model.on('hit') 仅作后备：常规路径在 onPointerUp 里用 meshHitTest 精确命中后直呼 handleHitAreas，绕开 model.tap 内部的包围盒 hitTest）
  model.on('hit', ctx.actions.handleHitAreas)

  // 上报动作组清单，供状态触发面板展示
  ctx.emit('motions', Object.keys(model.internalModel.settings?.motions ?? {}))
  ctx.hintsCtl.rebuild(model)
}
