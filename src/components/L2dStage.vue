<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Application, Ticker } from 'pixi.js'
import { Cubism4MotionManager, Live2DModel, MotionPriority, config } from 'pixi-live2d-display/cubism4'
import { loadAmbient } from '../utils/ambient'
import { InteractionRuntime, createInteractionHints, loadInteraction } from '../utils/interaction'

const props = defineProps({
  modelUrl: { type: String, required: true },
  /** 内容适配系数：1 = 撑满较短轴，<1 留边，>1 允许少量裁切 */
  fill: { type: Number, default: 1 },
})

const emit = defineEmits(['motions'])

const canvasHost = ref(null)
const status = ref('正在初始化舞台…')
const currentMotion = ref('')

let app = null
let model = null
let resizeObserver = null
let dprQuery = null

// ---- 交互状态机与提示（实现在 utils/interaction.js，模拟 Unity 端控制器）----
let runtime = null
let hintsCtl = null
const showHints = ref(true)
const hudState = ref('')

Live2DModel.registerTicker(Ticker)

/**
 * 动作硬切：碧蓝航线的 motion3.json 全部没有声明 FadeInTime/FadeOutTime，
 * 游戏内也是硬切。而 pixi-live2d-display 会对缺省值回退到
 * config.motionFadingDuration=500ms / idleMotionFadingDuration=2000ms 的渐变，
 * 渐变期间两套动作对图层开关参数（heiping、dianjikyc、Limit_box、All_Size 等）
 * 各自按权重输出，产生半透明道具、错位缩放等穿模/残影，故归零改为硬切。
 */
config.motionFadingDuration = 0
config.idleMotionFadingDuration = 0

/**
 * 尊重 motion3.json 的 Meta.Loop：本库 CubismMotion.parse 不读取该字段
 * （只暴露 setLoop setter），导致 idle/login 播完一遍后随机重启另一支 idle，
 * 且重启瞬间两套姿态混合。改为循环后同支 idle 无缝衔接，行为与游戏内一致。
 */
const createMotion = Cubism4MotionManager.prototype.createMotion
Cubism4MotionManager.prototype.createMotion = function (data, group, definition) {
  const motion = createMotion.call(this, data, group, definition)
  if (data?.Meta?.Loop) motion.setIsLoop(true)
  return motion
}

/** 查询当前设备像素比并应用到渲染器（贴图为 4096，无需封顶）。 */
function applyResolution() {
  const dpr = window.devicePixelRatio || 1
  if (!app || app.renderer.resolution === dpr) return
  app.renderer.resolution = dpr
  app.resize() // 让 resizeTo 按 CSS 尺寸以新分辨率重建缓冲
}

/** DPR 变化只会改变 matchMedia 的匹配结果，用一次性查询实现持续监听。 */
function watchDpr() {
  dprQuery?.removeEventListener('change', onDprChange)
  dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
  dprQuery.addEventListener('change', onDprChange)
}

function onDprChange() {
  applyResolution()
  watchDpr() // 重新挂到新的 DPR 值上
}

/**
 * 按真实场景做取景适配：
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
  if (!model || !app) return
  const scene = measureScene()
  if (!scene) return
  const viewW = app.screen.width
  const viewH = app.screen.height
  const canvasW = model.internalModel.width
  const canvasH = model.internalModel.height
  const backdrop = scene.width > canvasW + 50 || scene.height > canvasH + 50
  const scale =
    (backdrop
      ? Math.max(viewW / scene.width, viewH / scene.height)
      : Math.min(viewW / scene.width, viewH / scene.height)) * props.fill
  model.scale.set(scale)
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

/**
 * 遍历可见 drawable，返回场景包围盒（本地 px 空间）与角色锚点。
 * - 与画布实质相交的可见件按完整矩形并入：背景板本身经常越出画布两侧，
 *   按旧逻辑裁剪到画布会让它的真实中心丢失；画布外远处仍是特效/摆位零件
 *   的停车位，不相交即排除，不会撑大包围盒。
 * - drawable 顶点在模型首次 update 时才由核心算出，加载瞬间读到的只是
 *   陈旧值，因此调用方需在首帧后再适配（见 mountModel）。
 */
function measureScene() {
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

async function mountModel(url) {
  status.value = '加载模型…'
  hintsCtl.destroy()
  if (model) {
    app.stage.removeChild(model)
    model.destroy()
    model = null
  }
  // 新模型先按"无状态机"处理（interaction.json 就绪后运行时才接管；
  // 首支动作起播若早于数据就绪，模型本来就是干净的默认参数，无需复位）
  runtime = null
  model = await Live2DModel.from(url, {
    autoInteract: false,
    idleMotionGroup: 'idle', // 本项目 idle 组为小写（Cubism 默认是 "Idle"）
  })
  model.internalModel.motionManager.on('motionStart', () => runtime?.resetParameters())
  // 常驻氛围层：effect 组（垂发/扶手布的微风摆动）在游戏内永远循环叠加，
  // 这里挂在 afterMotionUpdate（主动作求值后、saveParameters 前）直写参数，
  // 物理与姿态系统不触碰这些参数，故不会与本层互相覆盖
  const ambient = await loadAmbient(url, model.internalModel.settings)
  if (ambient) {
    const core = model.internalModel.coreModel
    model.internalModel.on('afterMotionUpdate', () => ambient.apply(core, performance.now() / 1000))
  }
  app.stage.addChild(model)
  // 交互状态机：数据与模型同目录（<id>.interaction.json，本项目扩展产物），
  // 加载失败时运行时全旁路（参数全量复位、点击不做门控），退化为旧行为
  runtime = new InteractionRuntime(model, await loadInteraction(url))
  fitModel()
  // drawable 顶点在模型首次 update 时才由核心算出，上面的适配只能拿到陈旧值；
  // 两帧后（顶点就绪、idle 已应用）按真实场景重新适配一次
  requestAnimationFrame(() => requestAnimationFrame(fitModel))
  status.value = ''

  // 点击 -> 手动做命中检测（autoInteract 已关闭），命中区域 -> 播放对应动作
  model.on('hit', (areas) => {
    if (!runtime) return
    const name = runtime.firstVisibleHit(areas)
    const played = name && runtime.playHitMotion(name)
    if (played) currentMotion.value = played.group
  })

  // 上报动作组清单，供状态触发面板展示
  emit('motions', Object.keys(model.internalModel.settings?.motions ?? {}))
  hintsCtl.rebuild(model)
}

function playMotion(group) {
  if (!model) return
  currentMotion.value = group
  // FORCE：点击反应任何时候都可打断当前动作（与游戏内行为一致）
  model.motion(group, undefined, MotionPriority.FORCE)
}

onMounted(async () => {
  // resolution 按设备像素比渲染，否则高分屏上 canvas 被拉伸导致模糊；
  // autoDensity 让 canvas 的 CSS 尺寸仍等于容器尺寸，只是内部像素更密
  app = new Application({
    backgroundAlpha: 0,
    resizeTo: canvasHost.value,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    antialias: true,
  })
  watchDpr()
  canvasHost.value.appendChild(app.view)
  // 指针事件挂在 stage 上，只注册一次（挂进 mountModel 会随模型切换叠加）
  app.stage.interactive = true
  app.stage.hitArea = app.screen
  // 拖拽视线跟随：指针位置 -> focus
  app.stage.on('pointermove', (e) => {
    if (model) model.focus(e.global.x, e.global.y)
  })
  // 点击 -> 手动做命中检测（autoInteract 已关闭），命中区域 -> 播放对应动作
  app.stage.on('pointertap', (e) => {
    if (model) model.tap(e.global.x, e.global.y)
  })
  // 交互点提示逐帧跟随模型（顶点/透明度/门控状态都在变），HUD 取其返回文本
  hintsCtl = createInteractionHints(app, () => runtime, () => showHints.value)
  app.ticker.add(() => {
    hudState.value = hintsCtl.update()
  })
  // ResizeObserver 兼顾窗口变化与容器变化（如侧栏收起/展开）
  resizeObserver = new ResizeObserver(fitModel)
  resizeObserver.observe(canvasHost.value)
  await mountModel(props.modelUrl)
})

onBeforeUnmount(() => {
  dprQuery?.removeEventListener('change', onDprChange)
  dprQuery = null
  resizeObserver?.disconnect()
  resizeObserver = null
  hintsCtl?.destroy()
  model?.destroy()
  app?.destroy(true)
})

watch(() => props.modelUrl, (url) => url && mountModel(url))

/** 供外部（状态触发面板）直接播放指定动作组 */
defineExpose({ play: playMotion })
</script>

<template>
  <div class="stage">
    <div ref="canvasHost" class="canvas-host" />
    <button class="hint-toggle" type="button" @click="showHints = !showHints">
      {{ showHints ? '隐藏交互点' : '显示交互点' }}
    </button>
    <p v-if="showHints && hudState" class="hud">{{ hudState }}</p>
    <p v-if="status" class="status">{{ status }}</p>
  </div>
</template>

<style scoped>
.stage {
  position: relative;
  width: 100%;
  height: 100%;
}

.canvas-host {
  width: 100%;
  height: 100%;
}

.canvas-host :deep(canvas) {
  display: block;
}

.status {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: #8a8a93;
  font: 14px/1.6 system-ui, sans-serif;
  user-select: none;
}

/* 交互点提示：左下角开关 + 状态机参数 HUD（测试用） */
.hint-toggle {
  position: absolute;
  left: 12px;
  bottom: 12px;
  padding: 5px 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(16, 16, 20, 0.72);
  backdrop-filter: blur(12px);
  color: #8a8a93;
  font: 500 12px/1.4 system-ui, sans-serif;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.hint-toggle:hover {
  background: rgba(35, 35, 44, 0.9);
  color: #e8e8ee;
}

.hud {
  position: absolute;
  left: 12px;
  bottom: 44px;
  max-width: 46%;
  color: #9fd9bd;
  font: 500 11px/1.5 ui-monospace, monospace;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
  user-select: none;
}
</style>
