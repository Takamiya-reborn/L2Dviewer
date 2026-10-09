<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Application, Ticker } from 'pixi.js'
import { Cubism4MotionManager, Live2DModel, MotionPriority, config } from 'pixi-live2d-display/cubism4'
import { loadAmbient } from '../utils/ambient'
import { DragOrchestrator, loadL2dConfig } from '../utils/dragmachine'
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
let view = null

// ---- 交互状态机与提示（实现在 utils/interaction.js，模拟 Unity 端控制器）----
let runtime = null
// ---- 拖拽参数机（实现在 utils/dragmachine.js，模拟 Lua 控制层路由）----
// ship_l2d 配置烘焙出的机器编排器；无配置（未烘焙/非 L2D 皮肤）时保持 null，
// 全部交互走旧的 playHitMotion 近似路径
let orch = null
// 母港摆位（l2d.json 的 live2d_offset，bake_l2d.py 烘焙）：游戏取景用，
// 无配置时 fitModel 退回 ROI 拟合
let l2dOffset = null
let hintsCtl = null
const showHints = ref(true)
// 调试信息（状态机 HUD + 点击链路诊断）独立于交互点开关
const showDebug = ref(true)
const hudState = ref('')
// 本次按压是否落在机器分区上（down 时判定，up 时分流）
let machineConsumed = false
// TODO(临时诊断): 定位"点击舞台无反应"的断链位置,结论后整体删除(tapDebug/tapLog 相关)
const tapDebug = ref('诊断:等待挂载…')
let tapLine = ''
function tapLogSet(line) {
  tapLine = line
  tapDebug.value = line
  console.log('[tap]', line)
}
function tapLogAppend(suffix) {
  tapLine += suffix
  tapDebug.value = tapLine
  console.log('[tap]', tapLine)
}

// ---- 指针交互（原生 DOM 事件，模拟 Unity 端控制器）----
// 游戏内：按住并拖动时视线跟随鼠标，长按不动不追踪，松手后回正；松手时
// 位移小于阈值算点击、否则算拖拽（触发 touch_drag 分区而非 touch_idle 分区）
const DRAG_THRESHOLD = 10
// 视线追踪起步阈值：过滤按住时的手抖，位移越过它才认定"开始拖动"
const GAZE_START_THRESHOLD = 3
let pressing = false
let dragging = false
let downX = 0
let downY = 0
let maxDist = 0
let lastGesture = 'tap'

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

/**
 * idle 确定性选支：库内的空闲回退走 startRandomMotion，用 Math.random 从组里
 * 随机挑一支。idle 循环播放（见 createMotion 补丁）后，随机只发生在回落瞬间
 * ——触发动作播完后随机换一支 idle 变体，其姿态假定与状态机遗留的开关参数
 * （摊开的菜单、手持道具等）冲突，模型会跳进一个与当前状态不符的动作。
 * 游戏内触发反应结束后回到基础待机，状态参数靠跨动作保留维持（菜单保持
 * 摊开直到收尾分支），这里同样确定性回落：idle 组恒取"文件名与组同名"的
 * 那支（idle.motion3.json，无则第 0 支）；其余组（触发面板的随机播放）
 * 仍走库内随机。
 *
 * 分支挂起（节点非中性）期间不回落 idle：游戏在 OnFinishAnim(0) 进入等待
 * 输入后保持最后一帧姿态，摊开的菜单等维持原状，直到分支由后续手势收尾；
 * 若照库内默认立刻重启 idle，motionStart 的 resetParameters 会把非状态参数
 * 清回默认，姿态当场回正、摊开的菜单消失（实测即"背景立刻回正"）。节点
 * 回到中性（收尾分支播完）后这里重新放行 idle。
 */
const startRandomMotion = Cubism4MotionManager.prototype.startRandomMotion
Cubism4MotionManager.prototype.startRandomMotion = function (group, priority) {
  if (group === this.groups.idle) {
    // 有拖拽参数机时，idle 变体号由机器触发链维护（游戏 changeIdleIndex：
    // Animator SetInteger("idle")），回落恒取当前变体；节点非中性（菜单摊开
    // 等状态残留）正是变体姿态的前提，不再拦截
    if (orch) {
      const defs = this.definitions[group] ?? []
      const clip = orch.idleClipFor(orch.idleIndex)
      const base = defs.findIndex(
        (d) => (d.File ?? '').split('/').pop() === `${clip}.motion3.json`,
      )
      return this.startMotion(group, Math.max(base, 0), priority)
    }
    if (runtime && !runtime.isNeutral()) return Promise.resolve(false)
    const defs = this.definitions[group] ?? []
    const base = defs.findIndex(
      (d) => (d.File ?? '').split('/').pop() === `${group}.motion3.json`,
    )
    return this.startMotion(group, Math.max(base, 0), priority)
  }
  return startRandomMotion.call(this, group, priority)
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
// 母港 UI 设计分辨率高度（pt）；相机固定 ⇒ 决定可见画布高
const LIVE2D_UI_HEIGHT = 750
// live2dpainting.lua 的默认根缩放（live2d_offset 无第 4 元素时）
const LIVE2D_ROOT_SCALE = 52
function fitModel() {
  if (!model || !app) return
  const viewW = app.screen.width
  const viewH = app.screen.height
  const internal = model.internalModel
  if (l2dOffset && internal.coreModel?.getModel?.().canvasinfo) {
    const info = internal.coreModel.getModel().canvasinfo
    const rootScale = l2dOffset[3] ?? LIVE2D_ROOT_SCALE
    const pxPerPt = info.PixelsPerUnit / rootScale // 视口 pt -> 模型本地 px
    const scale = (viewH / (LIVE2D_UI_HEIGHT * pxPerPt)) * props.fill
    model.scale.set(scale)
    // 画布原点在本地 (W/2, H/2)——与 pixi 端 getDrawableVertices 的换算同源
    // （它硬编码 W/2、H/2，不读 canvasinfo 的 CanvasOrigin），勿混用
    model.position.set(
      viewW / 2 - (internal.width / 2 - l2dOffset[0] * pxPerPt) * scale,
      viewH / 2 - (internal.height / 2 + l2dOffset[1] * pxPerPt) * scale,
    )
    return
  }
  const scene = measureScene()
  if (!scene) return
  const canvasW = internal.width
  const canvasH = internal.height
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
  try {
    await mountModelInner(url)
  } catch (err) {
    // TODO(临时诊断): 挂载失败不再静默——任何一步出错都显式上报
    console.error('[l2d] 模型挂载失败', err)
    status.value = `加载失败:${err?.message ?? err}`
    tapDebug.value = `挂载失败:${err?.message ?? err}`
  }
}

async function mountModelInner(url) {
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
  orch = null
  l2dOffset = null
  model = await Live2DModel.from(url, {
    autoInteract: false,
    idleMotionGroup: 'idle', // 本项目 idle 组为小写（Cubism 默认是 "Idle"）
  })
  model.internalModel.motionManager.on('motionStart', () => runtime?.resetParameters())
  // 常驻氛围层：effect 组（垂发/扶手布的微风摆动）在游戏内永远循环叠加，
  // 这里挂在 afterMotionUpdate（主动作求值后、saveParameters 前）直写参数，
  // 物理与姿态系统不触碰这些参数，故不会与本层互相覆盖；
  // effect 缺失/加载失败只跳过本层，不应中断整个挂载
  try {
    const ambient = await loadAmbient(url, model.internalModel.settings)
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
  runtime = new InteractionRuntime(model, await loadInteraction(url))
  // 拖拽参数机：数据与模型同目录（<id>.l2d.json，bake_l2d.py 烘焙产物）；
  // 播放回调解析 clip 名 -> 动作组（白名单里存的是 clip 名，如 touch_idle1、
  // idle1），机器分区命中后由编排器接管路由
  const l2dConfig = await loadL2dConfig(url)
  if (l2dConfig) {
    l2dOffset = l2dConfig.live2d_offset ?? null
    orch = new DragOrchestrator(model, l2dConfig, playLuaAction)
    // TODO(临时诊断): 触发链关键步（拒按/点击判定/豁免/播放/名单）接进 tap 日志
    orch.debugHook = (s) => tapLogAppend(s)
    // 刷新即重置（游戏 ClearLive2dSave 语义：拖拽值回 start_value、idle 归零、
    // 白名单清空、存档清除）。偏离游戏的持久化恢复语义——查看器定位是交叉
    // 测试工具，每次加载从干净态起步，避免上轮测试的档位/状态残留串场
    orch.resetAll()
    runtime.checkEnable = (name) => orch.checkEnablePlay(name)
    const manager = model.internalModel.motionManager
    manager.on('motionStart', (group, index) =>
      orch.noteMotionStart(runtime.clipOf(group, index), group === runtime.idleGroup),
    )
    manager.on('motionFinish', () => orch.noteMotionFinish())
    const core = model.internalModel.coreModel
    model.internalModel.on('beforeMotionUpdate', () => orch.restoreLayer(core))
    model.internalModel.on('afterMotionUpdate', () => orch.applyLayer(core))
    // 挂载即落基础 idle（变体 0）：库的 idle 自启虽经 startRandomMotion 补丁按
    // 当前变体解析，但首帧前 FORCE 抢跑消掉竞态，明确从干净态起步——不然随机
    // 命中摆位变体（如 wuzang_3 组内下标 0 是 idle4）会把摆位判定框一起摆进来
    playLuaAction(orch.idleClipFor(0))
  }
  fitModel()
  // drawable 顶点在模型首次 update 时才由核心算出，上面的适配只能拿到陈旧值；
  // 两帧后（顶点就绪、idle 已应用）按真实场景重新适配一次
  requestAnimationFrame(() => requestAnimationFrame(fitModel))
  status.value = ''

  // 点击/拖拽 -> 手动做命中检测（autoInteract 已关闭），命中区域 -> 播放对应动作
  model.on('hit', (areas) => {
    if (!runtime) return
    const name = runtime.firstVisibleHit(areas, lastGesture)
    const played = name && runtime.playHitMotion(name)
    if (played) {
      currentMotion.value = played.group
      // TODO(临时诊断): 记录命中后链路结果
      tapLogAppend(`→ 可见命中 '${name}' → 已起播 ${played.group}`)
    } else if (name) {
      // TODO(临时诊断)
      tapLogAppend(`→ '${name}' 被门控拦下`)
    }
  })

  // 上报动作组清单，供状态触发面板展示
  emit('motions', Object.keys(model.internalModel.settings?.motions ?? {}))
  hintsCtl.rebuild(model)
  // TODO(临时诊断)
  tapLogSet('挂载完成:点按角色试试（按住拖动跟随视线，松手触发动作）')
  // TODO(临时诊断): 暴露运行时对象与命中区解析结果,供控制台深查
  console.log('[l2d] hitAreas 解析:', JSON.stringify(model.internalModel.hitAreas))
  console.log('[l2d] settings.hitAreas:', JSON.stringify(model.internalModel.settings?.hitAreas))
  window.__l2d = { get model() { return model }, get runtime() { return runtime } }
}

function playMotion(group) {
  if (!model) return
  // 白名单/黑名单对面板触发同样生效（游戏 TriggerAction 也走 checkEnablePlay；
  // 名单存 clip 名，面板动作组与 clip 同名）
  if (orch && !orch.checkEnablePlay(group)) return
  currentMotion.value = group
  // FORCE：点击反应任何时候都可打断当前动作（与游戏内行为一致）。
  // 面板是游戏内系统事件（登录/任务/回港…）的复现，属外部触发、不做点击
  // 门控（与游戏一致，如 login 的起播边界在干净默认态下也不满足）；但状态
  // 转移照常入账——interaction.js 在 motionManager 的 motionStart/motionFinish
  // 上统一跟踪所有动作，无论触发来源。
  model.motion(group, idleGroupIndex(group), MotionPriority.FORCE)
}
// 面板触发 idle 组时按当前变体解析（游戏 SetInteger("idle") 播当前变体
// 子状态，不是随机）；返回组内下标，查不到时 undefined 退回随机
function idleGroupIndex(group) {
  if (!orch || group !== runtime?.idleGroup) return undefined
  const defs = model.internalModel.settings?.motions?.[group] ?? []
  const want = orch.idleClipFor(orch.idleIndex)
  const i = defs.findIndex(
    (d) => (d.File ?? '').split('/').pop()?.replace(/\.motion3\.json$/, '') === want,
  )
  return i >= 0 ? i : undefined
}

/** 重置交互状态（对应游戏内 Live2dConst.ClearLive2dSave 的"重置"入口）：
    清 localStorage 存档、机器回初始值、idle 归零、白名单清空，并重放基础 idle */
function resetInteraction() {
  if (!orch || !model) return
  orch.resetAll()
  runtime?.resetState()
  playLuaAction(orch.idleClipFor(0))
}

/** 指针事件坐标 -> 舞台 CSS 像素坐标（与模型布局同一空间） */
function pointerPos(e) {
  const rect = app.view.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

/**
 * 拖拽参数机的动作播放回调：clip 名 -> 动作组解析后 FORCE 播放。
 * 白名单/黑名单在这里前置检查（游戏 checkEnablePlay 对一切播放生效）；
 * 名单存的是 clip 名（touch_idle1、idle1 等），组名与 clip 名不一致时
 * （touch_idleN 收在 touch_idle 组、idleN 收在 idle 组）按文件名反查组内下标。
 * @returns {boolean} 是否真的播了（不存在/被白名单拦下返回 false）
 */
function playLuaAction(clipName) {
  if (!orch) return false
  if (!orch.checkEnablePlay(clipName)) {
    // TODO(临时诊断)
    orch.debug?.(
      `${clipName} 被${orch.machineAble ? '机器按压(ableFlag)' : '白/黑名单'}拦下` +
        `(白名单${orch.enablePlayActions.length}项)`,
    )
    return false
  }
  const motions = model?.internalModel.settings?.motions ?? {}
  let group = null
  let index
  if (motions[clipName]) {
    group = clipName
    // 组名动作 = 游戏喂 Animator 的子状态路由，不是随机挑选：idle 组播当前
    // 变体所在的子状态（游戏 SetInteger("idle") 后播当前变体 clip），其余组
    // 按同名 clip 反查下标（如 main_1 组里的 main_1）。都查不到才退回随机
    const want =
      clipName === runtime?.idleGroup ? orch.idleClipFor(orch.idleIndex) : clipName
    const defs = motions[group] ?? []
    const i = defs.findIndex(
      (d) => (d.File ?? '').split('/').pop()?.replace(/\.motion3\.json$/, '') === want,
    )
    if (i >= 0) index = i
  } else {
    for (const [g, defs] of Object.entries(motions)) {
      const i = (defs ?? []).findIndex(
        (d) => (d.File ?? '').split('/').pop()?.replace(/\.motion3\.json$/, '') === clipName,
      )
      if (i >= 0) {
        group = g
        index = i
        break
      }
    }
  }
  if (!group) {
    console.warn(`[l2d] 动作 ${clipName} 在模型里不存在，跳过播放`)
    return false
  }
  currentMotion.value = group
  model.motion(group, index, MotionPriority.FORCE)
  return true
}

/**
 * 挑出指针位置上第一个"可见的机器分区"：hitTest 命中的分区里过滤掉
 * 透明度归零的（隐藏部位不响应，与游戏 raycast 行为一致），且必须是
 * ship_l2d 配置的 draw_able_name；返回命中分区名（HitAreas 的 Name）或 ''。
 */
function pickMachineZone(x, y) {
  if (!orch || !model) return ''
  const hits = model.hitTest(x, y)
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
  model?.focus(x, y)
}

/** 视线回正：焦点归零，focusController 内部缓动过渡 */
function resetGaze() {
  model?.internalModel.focusController.focus(0, 0)
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
  // TODO(临时诊断): 先落"按下"日志再做命中判定——判定环节若抛错也能留痕
  tapLogSet(`按下(${Math.round(x)},${Math.round(y)}) `)
  try {
    const downZone = pickMachineZone(x, y)
    if (downZone) machineConsumed = orch.onDown(downZone, { x, y })
    // TODO(临时诊断): 命中分区但机器未激活 = 反应动作播放中被 ignore_action 拒绝
    const activated = downZone && orch.machines.some((m) => m._active)
    tapLogAppend(
      downZone ? `机器[${downZone}]${activated ? '' : '(未激活:反应播放中?)'} ` : '未命中分区 ',
    )
    if (downZone) {
      // TODO(临时诊断): 命中分区判定框的实时包围盒（模型本地画布 px，
      // moc3 画布空间，与提示层描边同源）——排查"判定框异常大"用
      const area = model.internalModel.hitAreas?.[downZone]
      if (area?.index >= 0) {
        const verts = model.internalModel.getDrawableVertices(area.index)
        let x0 = Infinity
        let y0 = Infinity
        let x1 = -Infinity
        let y1 = -Infinity
        for (let j = 0; j < verts.length; j += 2) {
          const vx = verts[j]
          const vy = verts[j + 1]
          if (vx < x0) x0 = vx
          if (vx > x1) x1 = vx
          if (vy < y0) y0 = vy
          if (vy > y1) y1 = vy
        }
        tapLogAppend(
          `${downZone} 判定框 ${Math.round(x1 - x0)}×${Math.round(y1 - y0)}px @(${Math.round((x0 + x1) / 2)},${Math.round((y0 + y1) / 2)}) `,
        )
      }
    }
  } catch (err) {
    console.error('[l2d] pointerdown 命中判定异常', err)
    tapLogAppend(`判定出错:${err?.message ?? err} `)
  }
}

function onPointerMove(e) {
  if (!pressing) return
  const { x, y } = pointerPos(e)
  maxDist = Math.max(maxDist, Math.hypot(x - downX, y - downY))
  if (!dragging && maxDist > GAZE_START_THRESHOLD) dragging = true
  if (dragging) followGaze(x, y)
  // 按住期间拖拽参数机持续驱动（游戏 onPointDrag 对全部机器广播）
  orch?.onMove({ x, y })
}

function onPointerUp(e) {
  if (!pressing) return
  pressing = false
  if (dragging) resetGaze()
  if (!model) return
  const { x, y } = pointerPos(e)
  lastGesture = maxDist >= DRAG_THRESHOLD ? 'drag' : 'tap'
  // 机器接管的按压：松手交回编排器（点击判定/吸附/回弹都在机器里收尾），
  // 不再走 model.tap 旧路径；按下没碰到机器分区但松手落在机器分区上时同样
  // 交给编排器收尾（未激活的机器不构成点击，与游戏 startDrag 前置一致）
  if (machineConsumed) {
    orch.onUp('', { x, y })
    // TODO(临时诊断)
    tapLogAppend(`松手(${Math.round(x)},${Math.round(y)}) 机器处理 `)
    return
  }
  const upZone = pickMachineZone(x, y)
  if (upZone && orch.onUp(upZone, { x, y })) {
    // TODO(临时诊断): 带上"按下不在分区上"的原因，与松手落点分区对照
    tapLogAppend(`松手(${Math.round(x)},${Math.round(y)}) 落点分区[${upZone}]未激活（按下不在分区上） `)
    return
  }
  // 松手点做命中检测：点击走 idle/head/body 分区，拖拽走 touch_drag 分区
  const hits = model.hitTest(x, y) // 纯查询,无副作用
  // TODO(临时诊断)
  tapLogAppend(`松手(${Math.round(x)},${Math.round(y)}) ${lastGesture} 命中[${hits.join(',') || '无'}] `)
  model.tap(x, y)
}

function onPointerCancel() {
  if (!pressing) return
  pressing = false
  if (dragging) resetGaze()
  // 拖拽被系统打断（移出画布等）：机器按压作废，不构成点击
  orch?.onCancel()
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
  view = app.view
  canvasHost.value.appendChild(view)
  // 指针交互走原生 DOM 事件（pixi v6 事件管线在本项目里不触发，见诊断；
  // 原生路径只依赖 canvas 本身，语义与 Unity 端一致：按住跟随、松手判定）
  view.addEventListener('pointerdown', onPointerDown)
  view.addEventListener('pointermove', onPointerMove)
  view.addEventListener('pointerup', onPointerUp)
  view.addEventListener('pointercancel', onPointerCancel)
  view.addEventListener('pointerleave', onPointerCancel)
  // TODO(临时诊断): 探测 pixi 事件管线是否存活（无副作用），结论后删除
  app.stage.interactive = true
  app.stage.hitArea = app.screen
  let pixiMoveLogged = false
  app.stage.on('pointertap', () => console.log('[diag] pixi pointertap 也触发了'))
  app.stage.on('pointermove', () => {
    if (!pixiMoveLogged) {
      pixiMoveLogged = true
      console.log('[diag] pixi pointermove 也触发了（pixi 事件管线存活）')
    }
  })
  // 交互点提示逐帧跟随模型（顶点/透明度/门控状态都在变），HUD 取其返回文本；
  // 末参取编排器：提示标签按 l2d.json 显示分区驱动的参数（网格名与反应
  // 编号在部分皮肤是错位的，如 shengluyisi_5 的 TouchDrag23 -> touch_drag25）
  hintsCtl = createInteractionHints(app, () => runtime, () => showHints.value, () => orch)
  app.ticker.add(() => {
    // 拖拽参数机每帧步进（平滑趋近/回弹倒计时/点击确认窗口/触发调度）
    orch?.step(app.ticker.deltaMS / 1000)
    hudState.value = hintsCtl.update() + (orch ? `  ${orch.hudInfo()}` : '')
  })
  // ResizeObserver 兼顾窗口变化与容器变化（如侧栏收起/展开）
  resizeObserver = new ResizeObserver(fitModel)
  resizeObserver.observe(canvasHost.value)
  await mountModel(props.modelUrl)
})

onBeforeUnmount(() => {
  view?.removeEventListener('pointerdown', onPointerDown)
  view?.removeEventListener('pointermove', onPointerMove)
  view?.removeEventListener('pointerup', onPointerUp)
  view?.removeEventListener('pointercancel', onPointerCancel)
  view?.removeEventListener('pointerleave', onPointerCancel)
  view = null
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
    <div class="stage-toolbar">
      <button class="hint-toggle" type="button" @click="showHints = !showHints">
        {{ showHints ? '隐藏交互点' : '显示交互点' }}
      </button>
      <button class="hint-toggle" type="button" @click="showDebug = !showDebug">
        {{ showDebug ? '隐藏调试信息' : '显示调试信息' }}
      </button>
      <button v-if="orch" class="hint-toggle" type="button" @click="resetInteraction">
        重置交互
      </button>
    </div>
    <p v-if="showDebug && hudState" class="hud">{{ hudState }}</p>
    <p v-if="showDebug && tapDebug" class="tap-debug">{{ tapDebug }}</p>
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
  touch-action: none;
  /* 按住拖拽属于交互语义，屏蔽浏览器默认手势 */
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

/* 交互点/调试开关：右下角一排 + 状态机参数 HUD（测试用） */
.stage-toolbar {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: flex;
  gap: 8px;
}

.hint-toggle {
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
  right: 12px;
  bottom: 44px;
  max-width: 46%;
  color: #9fd9bd;
  font: 500 11px/1.5 ui-monospace, monospace;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
  user-select: none;
}

/* TODO(临时诊断): 点击链路诊断输出,定位后随相关代码一起删除 */
.tap-debug {
  position: absolute;
  top: 12px;
  left: 12px;
  max-width: 70%;
  color: #000;
  font: 700 12px/1.5 system-ui, sans-serif;
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.6);
  user-select: none;
  pointer-events: none;
  white-space: pre-wrap;
}
</style>
