<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Application } from 'pixi.js'
import { createInteractionHints } from '../utils/interaction'
import { installMotionPatches } from '../l2d/motionPatches'
import { createCamera } from '../l2d/camera'
import { createActions } from '../l2d/actions'
import { mountModel } from '../l2d/mount'
import { createGestures } from '../l2d/gestures'
import { createTickerCallback } from '../l2d/hud'
import { createClickEffect } from '../l2d/clickEffect'
import HudPanel from './debug/HudPanel.vue'

const props = defineProps({
  modelUrl: { type: String, required: true },
  /** 内容适配系数：1 = 撑满较短轴，<1 留边，>1 允许少量裁切 */
  fill: { type: Number, default: 1 },
})

const emit = defineEmits(['motions'])

const canvasHost = ref(null)
const status = ref('正在初始化舞台…')
const currentMotion = ref('')
// 交互点提示（utils/interaction 的 hints 覆盖层）开关
const showHints = ref(true)
// 触点涟漪（游戏"触点特效"的复刻，l2d/clickEffect.js）开关；
// 与游戏 SHOW_TOUCH_EFFECT 同语义（默认开），localStorage 持久化
const showRipple = ref(localStorage.getItem('l2d.showClickRipple') !== '0')
watch(showRipple, (v) => localStorage.setItem('l2d.showClickRipple', v ? '1' : '0'))
// 调试信息（状态机 HUD 读数）独立于交互点开关；hud 为结构化数据
const showDebug = ref(true)
const hud = ref(null)
// 当前皮肤是否配了拖拽参数机（决定"重置交互"按钮显隐；挂载时回填）
const hasOrch = ref(false)

let app = null
let rippleCtl = null
let resizeObserver = null
let dprQuery = null
let view = null

/**
 * 舞台上下文：各 l2d/ 模块共享的可变状态（单舞台实例，直接可变对象）。
 * - 引用型字段（app/model/runtime/orch/l2dOffset/hintsCtl/actions/camera）
 *   由 motionPatches/camera/mount/gestures/hud 各模块读写；
 * - dragScale（拖拽标定，camera 写）与 lastGesture（手势判定，gestures 写）
 *   是跨模块传值；
 * - status/currentMotion/hud/showHints/hasOrch 是响应式桥（l2d/ 只透传
 *   .value，不 import vue）；fill/emit 回传组件侧的 props 与事件。
 */
const ctx = {
  app: null,
  view: null,
  model: null,
  runtime: null,
  orch: null,
  l2dOffset: null,
  hintsCtl: null,
  actions: null,
  camera: null,
  dragScale: 1,
  lastGesture: 'tap',
  status,
  currentMotion,
  hud,
  hasOrch,
  fill: () => props.fill,
  emit,
}

// 动作库补丁（渐变归零 / Meta.Loop / idle 确定性选支）：安装一次，读 ctx
installMotionPatches(ctx)
// 取景适配与动作播放 API
ctx.camera = createCamera(ctx)
const actions = createActions(ctx)
ctx.actions = actions

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

const gestures = createGestures(ctx)

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
  ctx.app = app
  ctx.view = app.view
  watchDpr()
  view = app.view
  canvasHost.value.appendChild(view)
  // 指针交互走原生 DOM 事件（pixi v6 事件管线在本项目里不触发，见
  // scripts/tests/probe/pixi_events.mjs；原生路径只依赖 canvas 本身，语义
  // 与 Unity 端一致：按住跟随、松手判定）
  view.addEventListener('pointerdown', gestures.onPointerDown)
  view.addEventListener('pointermove', gestures.onPointerMove)
  view.addEventListener('pointerup', gestures.onPointerUp)
  view.addEventListener('pointercancel', gestures.onPointerCancel)
  view.addEventListener('pointerleave', gestures.onPointerCancel)
  // 交互点提示逐帧跟随模型（顶点/透明度/门控状态都在变），HUD 取其返回读数；
  // 末参取编排器：提示标签按 l2d.json 显示分区驱动的参数（网格名与反应
  // 编号在部分皮肤是错位的，如 shengluyisi_5 的 TouchDrag23 -> touch_drag25）
  ctx.hintsCtl = createInteractionHints(app, () => ctx.runtime, () => showHints.value, () => ctx.orch)
  // 触点涟漪：独立于模型，只依赖 canvas 指针事件；update 走同一 ticker
  rippleCtl = createClickEffect(app, view, () => showRipple.value)
  app.ticker.add(() => rippleCtl.update(app.ticker.deltaMS / 1000))
  app.ticker.add(createTickerCallback(ctx))
  // ResizeObserver 兼顾窗口变化与容器变化（如侧栏收起/展开）
  resizeObserver = new ResizeObserver(() => ctx.camera.fitModel())
  resizeObserver.observe(canvasHost.value)
  await mountModel(ctx, props.modelUrl)
})

onBeforeUnmount(() => {
  view?.removeEventListener('pointerdown', gestures.onPointerDown)
  view?.removeEventListener('pointermove', gestures.onPointerMove)
  view?.removeEventListener('pointerup', gestures.onPointerUp)
  view?.removeEventListener('pointercancel', gestures.onPointerCancel)
  view?.removeEventListener('pointerleave', gestures.onPointerCancel)
  view = null
  dprQuery?.removeEventListener('change', onDprChange)
  dprQuery = null
  resizeObserver?.disconnect()
  resizeObserver = null
  rippleCtl?.destroy()
  rippleCtl = null
  ctx.hintsCtl?.destroy()
  ctx.model?.destroy()
  app?.destroy(true)
  ctx.app = null
  ctx.view = null
  ctx.model = null
})

watch(() => props.modelUrl, (url) => url && mountModel(ctx, url))

/** 供外部（状态触发面板）直接播放指定动作组 */
defineExpose({ play: (group) => ctx.actions.playMotion(group) })
</script>

<template>
  <div class="stage">
    <div ref="canvasHost" class="canvas-host" />
    <HudPanel :hud="hud" :show-hints="showHints" :show-debug="showDebug" :has-orch="hasOrch" :show-ripple="showRipple"
      @toggle-hints="showHints = !showHints" @toggle-debug="showDebug = !showDebug"
      @toggle-ripple="showRipple = !showRipple" @reset="actions.resetInteraction()" />
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
</style>
