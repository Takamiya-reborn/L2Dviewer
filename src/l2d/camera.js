/**
 * 取景适配（相机）：按游戏 live2dpainting.lua 语义适配模型缩放与位置，回退路径按可见内容 ROI 拟合。
 * 读取 ctx.model / ctx.app / ctx.l2dOffset / ctx.fill()，把拖拽标定系数写入 ctx.dragScale（手势与 HUD 消费）。
 */

// 母港 UI 设计分辨率宽（pt）；CanvasScaler 按宽适配（1334pt 恒铺满屏幕宽，高度随宽高比伸缩），
// 相机固定 ⇒ 可见画布宽恒定、高随视口宽高比变化
// 依据：mainlive2dpainting.lua 的半身像皮肤轮询屏幕尺寸重算 GetHalfBodyOffsetY（rect.height 随屏幕变），
// 按"高恒 750pt"适配时 rect.height 恒定无需重算——只有按宽适配才需要
const LIVE2D_UI_WIDTH = 1334
// live2dpainting.lua 的默认根缩放（live2d_offset 无第 4 元素时）
const LIVE2D_ROOT_SCALE = 52
// 主页 mellow 主题表外皮肤的 L2D 容器位移 x（MainPaintingView.MESH_POSITION_X_OFFSET）
const MELLOW_FALLBACK_SHIFT_X = 145
// 半身像老皮肤名单（MainPaintingShift.IsLimitYPos）：容器 y 恒为半身公式，不吃主题位移 y
const HALF_BODY_PAINTINGS = new Set(['biaoqiang', 'z23', 'lafei', 'lingbo', 'mingshi', 'xuefeng'])
// 游戏端拖拽标定分辨率（1080×1920 机型横屏宽 1920px）：ship_l2d 的 offset_x/y 以 Input.mousePosition 的屏幕像素计。
// 按宽适配下屏幕像素/pt = 设备宽/1334，与设备宽高比无关；拖拽量按 W_ref/视口宽 放大成"游戏屏幕像素"再喂机器。
// localStorage 的 l2d_dragRefHeight 可覆盖标定值（历史键名，对照游戏实机校准用）。
const DRAG_REF_WIDTH = Number(localStorage.getItem('l2d_dragRefHeight')) || 1920

/**
 * @param ctx 舞台上下文（见 L2dStage.vue）
 * @returns {{ fitModel(): void }} fitModel 按当前视口重新适配，同时更新 ctx.dragScale（拖拽坐标换算系数）
 */
export function createCamera(ctx) {
  /**
   * 按游戏取景适配（live2dpainting.lua 语义，有 live2d_offset 配置时走这条）；没有 live2d_offset（未烘焙/非 L2D 皮肤）时退回 measureScene 的 ROI 拟合。
   */
  function fitModel() {
    const model = ctx.model
    const app = ctx.app
    if (!model || !app) return
    // 视口尺寸必须取 app.screen（CSS 像素）：模型坐标在 autoDensity 下与 CSS 像素同单位，而 renderer.width/height 是缓冲的物理像素（CSS 尺寸 × resolution），DPR ≠ 1 时（如 Windows 125% 缩放）会算出偏大 1.25 倍的 scale 且中心点偏移
    // DPR 只影响渲染密度、不影响布局，适配与 resolution 彻底解耦
    const viewW = app.screen.width
    const viewH = app.screen.height
    const internal = model.internalModel
    const l2dOffset = ctx.l2dOffset
    if (l2dOffset && internal.coreModel?.getModel?.().canvasinfo) {
      const info = internal.coreModel.getModel().canvasinfo
      const rootScale = l2dOffset[3] ?? LIVE2D_ROOT_SCALE
      // 主页取景的容器位移（mellow 主题，NewMainScene 默认）：painting 根节点 _tf 按 meshImageShift 移动、
      // l2dContainer 再按 l2dShift 移动，模型根（画布原点）在容器内再叠加 live2d_offset。三层合计：
      // shift 表皮肤 = l2d_shift − (145, 10)；表外皮肤 = (0, −10)（meshImage −145 与 l2dShift +145 抵消）。
      // l2d_shift[4] 的容器缩放在游戏 AdjustPosition 里未消费，不实现。半身像老皮肤（IsLimitYPos 名单）
      // 容器 y 被半身公式覆盖：−rect.height/2 + 325·容器缩放（缩放恒 1），rect.height = 屏幕高 pt = 1334·视口高/宽
      let shiftX = 0
      let shiftY = -10
      if (ctx.mainuiShift) {
        shiftX = ctx.mainuiShift.l2d_shift[0] - MELLOW_FALLBACK_SHIFT_X
        shiftY = ctx.mainuiShift.l2d_shift[1] - 10
      }
      if (ctx.painting && HALF_BODY_PAINTINGS.has(ctx.painting.replace(/_\d+$/, ''))) {
        shiftY = -10 - (LIVE2D_UI_WIDTH * viewH / viewW) / 2 + 325
      }
      // 游戏里模型根节点 = 画布原点（canvasinfo 的 CanvasOrigin，通常画布中心），世界位置 = 容器位移 + live2d_offset（pt，y 向上），
      // 根缩放 = live2d_offset[4]（默认 52）；相机固定 ⇒ 可见画布宽恒 1334pt、高 = 1334·视口高/宽
      // 等价到查看器（本地 px，y 向下）：视口中心对应模型点 (W/2 − (off.x+shift.x)·pp, H/2 + (off.y+shift.y)·pp)
      const pxPerPt = info.PixelsPerUnit / rootScale // 视口 pt -> 模型本地 px
      const scale = (viewW / (LIVE2D_UI_WIDTH * pxPerPt)) * ctx.fill()
      model.scale.set(scale)
      // 游戏里同一块可见画布宽铺满 W_ref backbuffer px
      ctx.dragScale = DRAG_REF_WIDTH / (viewW * ctx.fill())
      // 画布原点在本地 (W/2, H/2)——与 pixi 端 getDrawableVertices 的换算同源（它硬编码 W/2、H/2，不读 canvasinfo 的 CanvasOrigin），勿混用
      model.position.set(
        viewW / 2 - (internal.width / 2 - (l2dOffset[0] + shiftX) * pxPerPt) * scale,
        viewH / 2 - (internal.height / 2 + (l2dOffset[1] + shiftY) * pxPerPt) * scale,
      )
      return
    }
    const scene = measureScene(model)
    if (!scene) return
    const canvasW = internal.width
    const canvasH = internal.height
    // 场景包围盒越出设计画布 ⇒ 模型自带背景板（L2D 房间类皮肤），参照游戏内行为取 cover：铺满视口、裁掉较长方向的多余部分，任何窗口比例下都无黑边
    // 内容全部在画布内 ⇒ 站姿角色，保持 contain：撑满较短轴，不裁头脚
    const backdrop = scene.width > canvasW + 50 || scene.height > canvasH + 50
    const scale =
      (backdrop
        ? Math.max(viewW / scene.width, viewH / scene.height)
        : Math.min(viewW / scene.width, viewH / scene.height)) * ctx.fill()
    model.scale.set(scale)
    // 回退取景没有游戏取景语义，按"画布在屏幕上的实际高度"近似换算
    ctx.dragScale = DRAG_REF_HEIGHT / (canvasH * scale)
    // 锚点优先用角色（见 pickAnchorX），并 clamp 进场景框：宽松视口（如 16:9）下场景几乎全可见，clamp 把锚点收回场景边缘内，与游戏内构图一致；竖窄视口下场景左右大幅裁切，锚点保持人物居中
    // 纵向始终取场景中心
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
 * drawable 顶点在模型首次 update 时才由核心算出，加载瞬间读到的只是陈旧值，调用方需在首帧后再适配（见 mount.js）。
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
    // 与画布实质相交（>50px）的可见件按完整矩形并入：背景板经常越出画布两侧，裁剪到画布会丢失其真实中心；画布外远处是特效/摆位零件的停车位，不相交即排除、不撑大包围盒
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
 * 命中区里混着三类 mesh：当前姿态的角色部位（头/身/特殊…）、角色其他摆位的判定框（如房间另一侧的头部判定）、停车位上的微小判定点，后两类排除：
 * - 丢弃面积过小的（停车位上的点通常只有几像素）
 * - 按中心 x 聚类（间距超过画布 15% 视为另一群），取成员最多的一群——当前姿态的角色部位彼此紧邻
 * - 群内取最上（y0 最小）的框：头部判定最能代表取景中心
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
