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
   * 指针位置上的全部"可见机器分区"：网格级精确命中（meshHitTest，与游戏
   * CubismRaycaster 同一几何）的分区里过滤掉透明度归零的（隐藏部位不响应，
   * 与游戏 raycast 行为一致），且必须是 ship_l2d 配置的 draw_able_name。
   * 数组序 = 路由优先级：**ship_l2d 条目序最大的命中赢**。依据是游戏
   * Live2dChar.GetDragPart 的反汇编：遍历全部 raycast 命中，对每个命中的
   * drawable 名在 DragParts 名单里 FindIndex，更新条件 idx≥0 且 best≤idx+1
   * → running max（csinc 隐含 +1），返回名单下标最大者——与视觉渲染序、
   * 射线距离均无关。旧实现按 drawable 渲染序倒序取，只是条目序与渲染序
   * 恰好同向时结论一致（shengluyisi_5 环回点正是如此，实测才没露馅）；
   * 条目序靠前却画在上层的分区，游戏会选条目序靠后的那个，渲染序则选错。
   */
  function machineZonesAt(x, y) {
    const model = ctx.model
    const orch = ctx.orch
    if (!orch || !model) return []
    const hits = meshHitTest(model, x, y)
    const core = model.internalModel.coreModel
    const areas = model.internalModel.hitAreas ?? {}
    const hasOpacity = typeof core.getDrawableOpacity === 'function'
    const zones = []
    for (const name of hits) {
      const order = orch.zoneOrder(name)
      if (order < 0) continue
      const index = areas[name]?.index
      if (index === undefined) continue
      if (!hasOpacity || core.getDrawableOpacity(index) > 0.001) {
        zones.push({ name, order })
      }
    }
    // 名单序最大者胜：order = 分区在机器注册序（ship_l2d 条目序）里的最早
    // 位置，降序排即赢家在前
    return zones.sort((a, b) => b.order - a.order).map((z) => z.name)
  }

  /** 路由取胜者 = 数组第一个（= ship_l2d 条目序最大的命中，见 machineZonesAt） */
  function pickMachineZone(x, y) {
    return machineZonesAt(x, y)[0] ?? ''
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
    // 指针捕获：按下后无论在哪里松手（HUD 浮层上、画布外）pointerup 都保证
    // 送达画布。机器按压依赖 down/up 成对收尾（up 清 _active 与按压锁），
    // 鼠标没有隐式捕获，丢一次 up 就双滞留——实测 drag13:19 之后点 drag3:4
    // 恒显按压锁、一切播放被 ableFlag 拦死
    try {
      e.target.setPointerCapture?.(e.pointerId)
    } catch {
      /* 指针已释放等边缘态：捕获失败按无捕获走 */
    }
    pressing = true
    dragging = false
    downX = x
    downY = y
    maxDist = 0
    // 拖拽参数机分流：按下命中机器分区（可见的 draw_able_name）则由机器接管
    machineConsumed = false
    // 长按不动不追踪视线，起步判断推迟到 onPointerMove
    const zones = machineZonesAt(x, y)
    // 同点多分区留痕：重叠时谁胜出（末位命中）必须看得到——shengluyisi_5
    // 环回点 drag13:19 的热区被 TouchDrag1 大网格（腹部）盖住，路由语义改对
    // 之前点击全被 #01 接走，重叠本身不招供就没法排查
    if (zones.length > 1) {
      ctx.orch?.debug?.(`分区重叠(取:${zones[0]},同点:${zones.slice(1).join(',')})`)
    }
    // `?.`：mountModel 在 await Live2DModel.from 前就置 ctx.orch = null，
    // machineConsumed 闭包跨 remount 存活，切皮肤窗口内按下会走到 null 上
    if (zones.length) machineConsumed = ctx.orch?.onDown(zones[0], dragPos({ x, y })) ?? false
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
      // `?.` 同 onDown：按压中模型被换（mountModel 清 orch），up 不能炸
      ctx.orch?.onUp('', dragPos({ x, y }))
      return
    }
    const upZone = pickMachineZone(x, y)
    if (upZone && ctx.orch?.onUp(upZone, dragPos({ x, y }))) return
    // 松手点做网格级精确命中（游戏 CubismRaycaster 语义；model.tap 内部是
    // 包围盒 hitTest，这里直接算好命中名单直呼 handleHitAreas 绕开它）：
    // 点击走 idle/head/body 分区，拖拽走 touch_drag 分区
    const hits = meshHitTest(ctx.model, x, y) // 纯查询,无副作用
    // 落点诊断：期望命中机器分区却没命中时（如 shengluyisi_5 环回点
    // drag13:19 在 idle=11 姿态下疑似移位/隐藏），触发链里给出实际命中的
    // 分区名单——旧路径（handleHitAreas）不写触发链，缺这行会表现为"点了
    // 没任何读数"，排查没法起步
    if (hits.length) {
      ctx.orch?.debug?.(`落点未达机器分区(命中:${hits.slice(0, 4).join(',')}${hits.length > 4 ? ` 等${hits.length}个` : ''})`)
      ctx.actions.handleHitAreas(hits)
    } else {
      // 空命中也要留痕：shengluyisi_5 环回点 drag13:19 的点击两次全程静默，
      // 无法区分"没点"和"点了但网格隐藏/移位"，这次连空白都要交代
      ctx.orch?.debug?.('落点无网格(命中0个)')
    }
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
