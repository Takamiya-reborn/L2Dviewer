<script setup>
import { computed, ref } from 'vue'
import L2dStage from './components/L2dStage.vue'
import SkinTab from './components/SkinTab.vue'
import StateTab from './components/StateTab.vue'
import { MODELS, TRIGGER_LABELS, TRIGGER_ORDER } from './utils/models'

const activeId = ref(MODELS[0]?.id ?? '')
const activeModel = computed(() => MODELS.find((m) => m.id === activeId.value))

/** SkinTab 吃 { id, label }，模型名通过 label 字段适配，避免清单耦合视图。 */
const tabs = computed(() => MODELS.map((m) => ({ id: m.id, label: m.name })))

const stageRef = ref(null)
/** 当前模型的可触发动作组（由舞台加载后上报）与最近一次触发项 */
const triggers = ref([])
const activeTrigger = ref('')
/**
 * 不进状态触发面板的动作组：idle 是自动循环的待机动作、effect 是常驻氛围层
 * （ambient.js 叠加）、touch_idle/touch_drag 只由舞台手势（点击/拖拽松手）
 * 触发；按 TRIGGER_ORDER 排列，未收录的排末尾。
 */
const NON_TRIGGERS = new Set(['idle', 'effect', 'touch_idle', 'touch_drag'])
const triggerItems = computed(() => {
  const rank = (id) => {
    const i = TRIGGER_ORDER.indexOf(id)
    return i === -1 ? TRIGGER_ORDER.length : i
  }
  return triggers.value
    .filter((id) => !NON_TRIGGERS.has(id))
    .map((id) => ({ id, label: TRIGGER_LABELS[id] ?? id }))
    .sort((a, b) => rank(a.id) - rank(b.id)) // Array.sort 稳定，同级保持声明顺序
})

function playTrigger(id) {
  activeTrigger.value = id
  stageRef.value?.play(id)
}
</script>

<template>
  <div class="layout">
    <!-- 舞台永远占满容器，两侧栏作为蒙板浮在上面 -->
    <L2dStage
      v-if="activeModel"
      ref="stageRef"
      class="stage"
      :key="activeModel.id"
      :model-url="activeModel.url"
      :fill="0.8"
      @motions="triggers = $event"
    />
    <SkinTab v-model="activeId" :tabs="tabs" title="皮肤列表" />
    <StateTab :items="triggerItems" :active="activeTrigger" title="状态触发" @select="playTrigger" />
  </div>
</template>

<style scoped>
.layout {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.stage {
  width: 100%;
  height: 100%;
}
</style>
