<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 自绘滚动条：隐藏原生滚动条（叠加滚动条模式下 ::-webkit-scrollbar 会被浏览器忽略），
 * 按滚动位置画半透明滑块。根节点 flex:1 占满父容器的剩余高度（父容器需为 flex 列布局），
 * 滑轨只覆盖本组件区域——面板里标题/搜索框等固定区不参与滚动与滑轨。
 * 滑轨距容器右缘 inset px，用于避开骑在边缘的开关把手。滑块可拖拽，滑轨空白处点击跳转。
 */
const props = defineProps({
  /** 滑轨（滑块右缘）距容器右缘的距离（px） */
  inset: { type: Number, default: 4 },
  /** 滑块宽度（px） */
  width: { type: Number, default: 14 },
})

const viewport = ref(null)
const content = ref(null)
const scrollable = ref(false)
const thumbH = ref(0)
const thumbTop = ref(0)

const MARGIN = 4 // 滑轨上下留白
let trackH = 0
let ro = null
let drag = null

function update() {
  const el = viewport.value
  if (!el) return
  const maxScroll = el.scrollHeight - el.clientHeight
  scrollable.value = maxScroll > 0
  if (!scrollable.value) return
  trackH = el.clientHeight - MARGIN * 2
  thumbH.value = Math.max(28, Math.round((trackH * el.clientHeight) / el.scrollHeight))
  thumbTop.value = MARGIN + (el.scrollTop / maxScroll) * (trackH - thumbH.value)
}

function onThumbDown(e) {
  drag = { y: e.clientY, top: viewport.value.scrollTop }
  e.currentTarget.setPointerCapture(e.pointerId)
}

function onThumbMove(e) {
  if (!drag) return
  const el = viewport.value
  const maxScroll = el.scrollHeight - el.clientHeight
  const maxThumb = Math.max(1, trackH - thumbH.value)
  el.scrollTop = drag.top + ((e.clientY - drag.y) * maxScroll) / maxThumb
}

function onThumbUp() {
  drag = null
}

function onTrackDown(e) {
  if (e.target !== e.currentTarget) return // 只响应滑轨空白处，滑块点击交给拖拽
  const el = viewport.value
  const rect = e.currentTarget.getBoundingClientRect()
  const ratio = (e.clientY - rect.top - thumbH.value / 2) / Math.max(1, trackH - thumbH.value)
  el.scrollTop = ratio * (el.scrollHeight - el.clientHeight)
}

onMounted(() => {
  update()
  ro = new ResizeObserver(update)
  ro.observe(viewport.value)
  ro.observe(content.value)
})

onBeforeUnmount(() => ro?.disconnect())
</script>

<template>
  <div class="custom-scroll">
    <div ref="viewport" class="viewport" @scroll="update">
      <div ref="content" class="content">
        <slot />
      </div>
    </div>
    <div v-show="scrollable" class="track" :style="{ right: inset + 'px', width: width + 'px' }"
      @pointerdown="onTrackDown">
      <div class="thumb" :style="{ top: thumbTop + 'px', height: thumbH + 'px', width: width + 'px' }"
        @pointerdown="onThumbDown" @pointermove="onThumbMove" @pointerup="onThumbUp" @pointercancel="onThumbUp" />
    </div>
  </div>
</template>

<style scoped>
.custom-scroll {
  position: relative;
  overflow: hidden;
  flex: 1;
  min-height: 0;
}

/* 原生滚动条双向隐藏：Firefox 走 scrollbar-width，Chromium 走 webkit 伪元素 */
.viewport {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  scrollbar-width: none;
}

.viewport::-webkit-scrollbar {
  display: none;
}

.track {
  position: absolute;
  top: 0;
  bottom: 0;
  cursor: pointer;
}

.thumb {
  position: absolute;
  left: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.18);
  touch-action: none;
  transition: background 0.15s;
}

.thumb:hover {
  background: rgba(255, 255, 255, 0.3);
}

.thumb:active {
  background: rgba(255, 255, 255, 0.38);
}
</style>
