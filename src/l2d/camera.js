/**
 * 取景适配（相机）：按游戏 live2dpainting.lua 语义适配模型缩放与位置，
 * 回退路径按可见内容 ROI 拟合。读取 ctx.model / ctx.app / ctx.l2dOffset /
 * ctx.fill()，把拖拽标定系数写入 ctx.dragScale（手势与 HUD 消费）。
 */

// 母港 UI 设计分辨率高度（pt）；相机固定 ⇒ 决定可见画布高
const LIVE2D_UI_HEIGHT = 750
// live2dpainting.lua 的默认根缩放（live2d_offset 无第 4 元素时）
const LIVE2D_ROOT_SCALE = 52
// 游戏端拖拽标定分辨率（竖屏 backbuffer 高，1080×1920 机型）：ship_l2d 的
// offset_x/y 以 Input.mousePosition 的屏幕像素计——游戏里 3037 画布 px 铺满
// 手机整屏，查看器里同一块画布铺满视口，窗口比手机矮时同样的手指位移换到
// 的参数量就变少（准星/滑条跟不上手，拖到头也够不到远端档位）。拖拽量按
// H_ref/视口内画布高 放大成"游戏屏幕像素"再喂机器。localStorage 的
// l2d_dragRefHeight 可覆盖标定值（对照游戏实机手感校准用）。
const DRAG_REF_HEIGHT = Number(localStorage.getItem('l2d_dragRefHeight')) || 1920

/**
 * @param ctx 舞台上下文（见 L2dStage.vue）
 * @returns {{ fitModel(): void }} fitModel 按当前视口重新适配，同时更新
 *   ctx.dragScale（拖拽坐标换算系数）
 */
export function createCamera(ctx) {
  /**
   * 按游戏取景适配（live2dpainting.lua 语义，有 live2d_offset 配置时走这条）：
   * 游戏里模型根节点 = 画布原点（canvasinfo 的 CanvasOrigin，通常画布中心）、
   * 根缩放恒 52（Unity 端 canvas px→单位是 1/PPU，故模型点 k（单位制）出现在
   * 世界 offset + k·52 处，offset 即 live2d_offset，y 向上）、相机固定不动。
   * 等价到查看器（本地 px，y 向下，= pixi 端 getDrawableVertices 的换算）：
   * - 视口中心对应模型点 k = −offset/52，即
   *     center = (W/2 − off.x·PPU/52, H/2 + off.y·PPU/52)
   * - 可见画布高 = 母港设计高 750pt ÷ (52/PPU) ≈ 3037px，全皮肤恒定
   *   （相机固定 ⇒ 取景比例与皮肤无关；750 是设计分辨率高度）
   * props.fill 仍作整体缩放系数（默认 1 = 与游戏一致）。
   * 没有 live2d_offset（未烘焙/非 L2D 皮肤）时退回 measureScene 的 ROI 拟合：
   * - 场景包围盒越出设计画布 ⇒ 模型自带背景板（L2D 房间类皮肤），参照游戏内行为取
   *   cover：铺满视口、裁掉较长方向的多余部分，任何窗口比例下都无黑边；
   * - 内容全部在画布内 ⇒ 站姿角色，保持 contain：撑满较短轴，不裁头脚。
   * 锚点优先用角色（见 pickAnchorX），并把锚点 clamp 进场景框：宽松视口（如 16:9）
   * 下场景几乎全可见，clamp 把锚点收回场景边缘内，与游戏内构图一致；
   * 竖窄视口下场景左右大幅裁切，锚点保持人物居中。纵向始终取场景中心。
   *
   * 视口尺寸必须取 app.screen（CSS 像素）：模型坐标在 autoDensity 下与 CSS 像素同单位，
   * 而 renderer.width/height 是缓冲的物理像素（CSS 尺寸 × resolution），DPR ≠ 1 时
   * （如 Windows 125% 缩放）会算出偏大 1.25 倍的 scale 且中心点偏移，导致溢出 + 不居中。
   * DPR 只影响渲染密度，不影响布局，因此适配与 resolution 彻底解耦。
   */
  function fitModel() {
    const model = ctx.model
    const app = ctx.app
    if (!model || !app) return
    const viewW = app.screen.width
    const viewH = app.screen.height
    const internal = model.internalModel
    const l2dOffset = ctx.l2dOffset
    if (l2dOffset && internal.coreModel?.getModel?.().canvasinfo) {
      const info = internal.coreModel.getModel().canvasinfo
      const rootScale = l2dOffset[3] ?? LIVE2D_ROOT_SCALE
      const pxPerPt = info.PixelsPerUnit / rootScale // 视口 pt -> 模型本地 px
      const scale = (viewH / (LIVE2D_UI_HEIGHT * pxPerPt)) * ctx.fill()
      model.scale.set(scale)
      // 游戏里同一块可见画布（≈3037 本地 px）铺满 H_ref backbuffer px
      ctx.dragScale = DRAG_REF_HEIGHT / (viewH * ctx.fill())
      // 画布原点在本地 (W/2, H/2)——与 pixi 端 getDrawableVertices 的换算同源
      // （它硬编码 W/2、H/2，不读 canvasinfo 的 CanvasOrigin），勿混用
      model.position.set(
        viewW / 2 - (internal.width / 2 - l2dOffset[0] * pxPerPt) * scale,
        viewH / 2 - (internal.height / 2 + l2dOffset[1] * pxPerPt) * scale,
      )
      return
    }
    const scene = measureScene(model)
    if (!scene) return
    const canvasW = internal.width
    const canvasH = internal.height
    const backdrop = scene.width > canvasW + 50 || scene.height > canvasH + 50
    const scale =
      (backdrop
        ? Math.max(viewW / scene.width, viewH / scene.height)
        : Math.min(viewW / scene.width, viewH / scene.height)) * ctx.fill()
    model.scale.set(scale)
    // 回退取景没有游戏取景语义，按"画布在屏幕上的实际高度"近似换算
    ctx.dragScale = DRAG_REF_HEIGHT / (canvasH * scale)
    const centerX = scene.x + scene.width / 2
    let anchorX = scene.anchorX ?? centerX
    const halfW = viewW / (2 * scale)
    if (scene.width > 2 * halfW) {
      anchorX = Math.min(Math.max(anchorX, scene.x + halfW), scene.x + scene.width - halfW)
    } else {
      anchorX = centerX
    }
    model.position.set(
      viewW / 2 - anchorX * scale,
      viewH / 2 - (scene.y + scene.height / 2) * scale,
    )
  }

  return { fitModel }
}

/**
 * 遍历可见 drawable，返回场景包围盒（本地 px 空间）与角色锚点。
 * - 与画布实质相交的可见件按完整矩形并入：背景板本身经常越出画布两侧，
 *   按旧逻辑裁剪到画布会让它的真实中心丢失；画布外远处仍是特效/摆位零件
 *   的停车位，不相交即排除，不会撑大包围盒。
 * - drawable 顶点在模型首次 update 时才由核心算出，加载瞬间读到的只是
 *   陈旧值，因此调用方需在首帧后再适配（见 mount.js）。
 */
function measureScene(model) {
  const internal = model.internalModel
  const core = internal?.coreModel
  const count = core?.getDrawableCount?.() ?? 0
  if (!count || !internal.width || !internal.height) return null
  const canvasW = internal.width
  const canvasH = internal.height
  const hitIds = new Set((internal.settings?.hitAreas ?? []).map((h) => h.Id))
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const hitBoxes = []
  const hasOpacity = typeof core.getDrawableOpacity === 'function'
  for (let i = 0; i < count; i++) {
    if (hasOpacity && core.getDrawableOpacity(i) <= 0.001) continue
    const verts = internal.getDrawableVertices(i)
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let j = 0; j < verts.length; j += 2) {
      const x = verts[j]
      const y = verts[j + 1]
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    if (x1 <= x0 || y1 <= y0) continue
    if (Math.min(x1, canvasW) - Math.max(x0, 0) > 50 && Math.min(y1, canvasH) - Math.max(y0, 0) > 50) {
      if (x0 < minX) minX = x0
      if (x1 > maxX) maxX = x1
      if (y0 < minY) minY = y0
      if (y1 > maxY) maxY = y1
    }
    if (hitIds.has(core.getDrawableId(i))) {
      hitBoxes.push({ cx: (x0 + x1) / 2, y0, area: (x1 - x0) * (y1 - y0) })
    }
  }
  if (minX === Infinity || maxX <= minX || maxY <= minY) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY, anchorX: pickAnchorX(hitBoxes, canvasW) }
}

/**
 * 从命中区网格推角色取景锚点（中心 x）。
 * 命中区里混着三类 mesh：当前姿态的角色部位（头/身/特殊…）、角色其他摆位的
 * 判定框（如房间另一侧的头部判定）、停车位上的微小判定点。后两类都要排除：
 * - 丢弃面积过小的（停车位上的点通常只有几像素）；
 * - 按中心 x 聚类（间距超过画布 15% 视为另一群），取成员最多的一群——
 *   当前姿态的角色部位彼此紧邻；
 * - 群内取最上（y0 最小）的框：头部判定最能代表取景中心。
 * 无命中区或全部被排除时返回 null，fitModel 退化为场景中心。
 */
function pickAnchorX(hitBoxes, canvasW) {
  const big = hitBoxes.filter((b) => b.area > (canvasW * 0.0125) ** 2)
  if (!big.length) return null
  big.sort((a, b) => a.cx - b.cx)
  const clusters = [[big[0]]]
  for (let i = 1; i < big.length; i++) {
    const last = clusters[clusters.length - 1]
    if (big[i].cx - last[last.length - 1].cx < canvasW * 0.15) last.push(big[i])
    else clusters.push([big[i]])
  }
  clusters.sort((a, b) => b.length - a.length)
  const best = clusters[0].slice().sort((a, b) => a.y0 - b.y0 || b.area - a.area)
  return best[0].cx
}
