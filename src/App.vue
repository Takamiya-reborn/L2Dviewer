<script setup>
import { computed, ref } from 'vue'
import L2dStage from './components/L2dStage.vue'
import PullDialog from './components/PullDialog.vue'
import SkinTab from './components/tabs/SkinTab.vue'
import StateTab from './components/tabs/StateTab.vue'
import { CATALOG, MODELS, TRIGGER_LABELS, TRIGGER_ORDER, campLabel, loadModels } from './utils/models'

const activeId = ref(MODELS[0]?.id ?? '')
const activeModel = computed(() => MODELS.find((m) => m.id === activeId.value))

/**
 * 侧栏吃全量目录（catalog 是已烘焙清单的超集）：state 标记资源在盘情况
 * （baked 绿点可点直接加载 / cached 已拉待烘焙 / remote 需从设备拉取），
 * 非 baked 点击走拉取确认。baked 判据以本地清单实时为准（烘焙后 loadModels
 * 刷新即转绿，不等目录重拉）；目录拉取失败回退为只显示已烘焙清单。
 */
const bakedIds = computed(() => new Set(MODELS.map((m) => m.id)))
const tabs = computed(() =>
  CATALOG.entries.length
    ? CATALOG.entries.map((e) => ({
      id: e.painting,
      label: e.name,
      state: bakedIds.value.has(e.painting) ? 'baked' : (e.state ?? 'remote'),
      camp: campLabel(e.camp),
      // 形态标记：ani=有 spine 版本；l2d 缺省真（目录条目缺省来自 live2d 索引）
      ani: e.ani ?? false,
      l2d: e.l2d ?? true,
    }))
    : MODELS.map((m) => ({ id: m.id, label: m.name, state: 'baked', camp: '其他', ani: false, l2d: true })),
)

/** 待拉取确认的皮肤条目（SkinTab 灰色条目点击时设置，PullDialog 关闭时清空） */
const pullTarget = ref(null)

/** 烘焙完成：刷新清单拿新皮肤的 url，再选中即自动重挂加载 */
async function onBaked(painting) {
  await loadModels()
  activeId.value = painting
  pullTarget.value = null
}

const stageRef = ref(null)
/** 当前模型的可触发动作组（由舞台加载后上报）与最近一次触发项 */
const triggers = ref([])
const activeTrigger = ref('')
/**
 * 状态触发面板展示全量动作组：idle/touch_idle/touch_drag 等常驻与手势组也出
 * 按钮（触发开关不只驱动动作、还驱动语音）；模型里没有可播动作的组点击即
 * no-op。effect 例外——它是 ambient.js 采样叠加的常驻氛围层，既非事件也无
 * 台词，不进面板。按 TRIGGER_ORDER 排列，未收录的排末尾。
 */
const AMBIENT_GROUPS = new Set(['effect'])
const triggerItems = computed(() => {
  const rank = (id) => {
    const i = TRIGGER_ORDER.indexOf(id)
    return i === -1 ? TRIGGER_ORDER.length : i
  }
  return triggers.value
    .filter((id) => !AMBIENT_GROUPS.has(id))
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
    <L2dStage v-if="activeModel" ref="stageRef" class="stage" :key="activeModel.id" :model-url="activeModel.url"
      @motions="triggers = $event" />
    <SkinTab v-model="activeId" :tabs="tabs" title="皮肤列表" @pull-request="pullTarget = $event" />
    <StateTab :items="triggerItems" :active="activeTrigger" title="状态触发" @select="playTrigger" />
    <PullDialog :target="pullTarget" @close="pullTarget = null" @baked="onBaked" />
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
