/**
 * 指针手势状态机（原生 DOM 事件，模拟 Unity 端控制器）：游戏内按住并拖动时
 * 视线跟随鼠标，长按不动不追踪，松手后回正；松手时位移小于阈值算点击、
 * 否则算拖拽（触发 touch_drag 分区而非 touch_idle 分区）。按下先尝试机器
 * 分区分流（拖拽参数机接管），未消费再走 meshHitTest 精确命中 -> 状态机
 * 播放路径。读 ctx.app / ctx.model / ctx.orch / ctx.dragScale /
 * ctx.actions.handleHitAreas，写 ctx.lastGesture。
 */
import { meshHitTest } from '../utils/interaction'

// 游戏内：松手时位移小于阈值算点击、否则算拖拽
const DRAG_THRESHOLD = 10
// 视线追踪起步阈值：过滤按住时的手抖，位移越过它才认定"开始拖动"
const GAZE_START_THRESHOLD = 3

/**
 * @param ctx 舞台上下文（见 L2dStage.vue）
 * @returns {{ onPointerDown, onPointerMove, onPointerUp, onPointerCancel }}
 *   绑定到 canvas 的四个原生指针监听器
 */
export function createGestures(ctx) {
  let pressing = false
  let dragging = false
  let downX = 0
  let downY = 0
  let maxDist = 0
  // 本次按压是否落在机器分区上（down 时判定，up 时分流）
  let machineConsumed = false

  /** 指针事件坐标 -> 舞台 CSS 像素坐标（与模型布局同一空间） */
  function pointerPos(e) {
    const rect = ctx.app.view.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  /** 指针坐标 -> 拖拽机坐标系（游戏屏幕像素）：机器只用差值，命中判定仍用
      视口 px，故只有喂给编排器的坐标过 dragScale */
  function dragPos(p) {
    return { x: p.x * ctx.dragScale, y: p.y * ctx.dragScale }
  }

  /**
   * 挑出指针位置上第一个"可见的机器分区"：网格级精确命中（meshHitTest，与
   * 游戏 CubismRaycaster 同一几何）的分区里过滤掉透明度归零的（隐藏部位不
   * 响应，与游戏 raycast 行为一致），且必须是 ship_l2d 配置的 draw_able_name；
   * 返回命中分区名（HitAreas 的 Name）或 ''。
   */
  function pickMachineZone(x, y) {
    const model = ctx.model
    const orch = ctx.orch
    if (!orch || !model) return ''
    const hits = meshHitTest(model, x, y)
    const core = model.internalModel.coreModel
    const areas = model.internalModel.hitAreas ?? {}
    const hasOpacity = typeof core.getDrawableOpacity === 'function'
    for (const name of hits) {
      if (!orch.machineByZone(name)) continue
      const index = areas[name]?.index
      if (index === undefined) continue
      if (!hasOpacity || core.getDrawableOpacity(index) > 0.001) return name
    }
    return ''
  }

  /** 按住期间视线跟随指针 */
  function followGaze(x, y) {
    ctx.model?.focus(x, y)
  }

  /** 视线回正：焦点归零，focusController 内部缓动过渡 */
  function resetGaze() {
    ctx.model?.internalModel.focusController.focus(0, 0)
  }

  function onPointerDown(e) {
    const { x, y } = pointerPos(e)
    pressing = true
    dragging = false
    downX = x
    downY = y
    maxDist = 0
    // 拖拽参数机分流：按下命中机器分区（可见的 draw_able_name）则由机器接管
    machineConsumed = false
    // 长按不动不追踪视线，起步判断推迟到 onPointerMove
    const downZone = pickMachineZone(x, y)
    if (downZone) machineConsumed = ctx.orch.onDown(downZone, dragPos({ x, y }))
  }

  function onPointerMove(e) {
    if (!pressing) return
    const { x, y } = pointerPos(e)
    maxDist = Math.max(maxDist, Math.hypot(x - downX, y - downY))
    if (!dragging && maxDist > GAZE_START_THRESHOLD) dragging = true
    if (dragging) followGaze(x, y)
    // 按住期间拖拽参数机持续驱动（游戏 onPointDrag 对全部机器广播）
    ctx.orch?.onMove(dragPos({ x, y }))
  }

  function onPointerUp(e) {
    if (!pressing) return
    pressing = false
    if (dragging) resetGaze()
    if (!ctx.model) return
    const { x, y } = pointerPos(e)
    const lastGesture = maxDist >= DRAG_THRESHOLD ? 'drag' : 'tap'
    ctx.lastGesture = lastGesture
    // 机器接管的按压：松手交回编排器（点击判定/吸附/回弹都在机器里收尾），
    // 不再走 model.tap 旧路径；按下没碰到机器分区但松手落在机器分区上时同样
    // 交给编排器收尾（未激活的机器不构成点击，与游戏 startDrag 前置一致）
    if (machineConsumed) {
      ctx.orch.onUp('', dragPos({ x, y }))
      return
    }
    const upZone = pickMachineZone(x, y)
    if (upZone && ctx.orch.onUp(upZone, dragPos({ x, y }))) return
    // 松手点做网格级精确命中（游戏 CubismRaycaster 语义；model.tap 内部是
    // 包围盒 hitTest，这里直接算好命中名单直呼 handleHitAreas 绕开它）：
    // 点击走 idle/head/body 分区，拖拽走 touch_drag 分区
    const hits = meshHitTest(ctx.model, x, y) // 纯查询,无副作用
    if (hits.length) ctx.actions.handleHitAreas(hits)
  }

  function onPointerCancel() {
    if (!pressing) return
    pressing = false
    if (dragging) resetGaze()
    // 拖拽被系统打断（移出画布等）：机器按压作废，不构成点击
    ctx.orch?.onCancel()
  }

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel }
}
