<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'

/**
 * 拉取确认/进度浮层：点未烘焙条目时弹出，确认后由 dev server 跑
 * "adb 拉取 bundle -> extract.js 烘焙"，前端轮询 /api/job 展示进度。
 * 完成时 emit('baked', painting) 交由父层刷新清单并加载。
 */
const props = defineProps({
  /** 拉取目标 SkinTab 条目 { id, label }；null = 关闭 */
  target: { type: Object, default: null },
})
const emit = defineEmits(['close', 'baked'])

const phase = ref('confirm') // confirm | progress | error
const devices = ref([])
const deviceReady = ref(false)
const job = ref(null)
let pollTimer = null

const online = computed(() => devices.value.filter((d) => d.state === 'device'))
const phaseText = computed(() =>
  job.value?.phase === 'extract' ? '正在解包烘焙…' : '正在拉取 bundle…',
)
const logTail = computed(() => (job.value?.log ?? []).slice(-5).join('\n'))
/** 服务端聚合的进度（{ percent, label }，percent 为 null 表示不定态） */
const progress = computed(() => job.value?.progress ?? null)

async function loadDevices() {
  deviceReady.value = false
  try {
    const r = await fetch('/api/device')
    devices.value = (await r.json()).devices ?? []
  } catch {
    devices.value = []
  }
  deviceReady.value = true
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function pollOnce() {
  try {
    const r = await fetch('/api/job')
    const data = await r.json()
    if (data.status === 'done') {
      stopPoll()
      emit('baked', props.target.id)
    } else if (data.status === 'error') {
      stopPoll()
      job.value = data
      phase.value = 'error'
    } else if (data.status === 'running') {
      job.value = data
    }
  } catch { /* 单次轮询失败静默重试 */ }
}

async function start() {
  phase.value = 'progress'
  try {
    const r = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ painting: props.target.id }),
    })
    const body = await r.json()
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
    job.value = body.job
    stopPoll()
    pollTimer = setInterval(pollOnce, 1500)
  } catch (err) {
    job.value = { error: err.message, log: [] }
    phase.value = 'error'
  }
}

function close() {
  stopPoll()
  emit('close')
}

watch(
  () => props.target,
  (target) => {
    stopPoll()
    if (target) {
      phase.value = 'confirm'
      job.value = null
      loadDevices()
    }
  },
)
onBeforeUnmount(stopPoll)
</script>

<template>
  <div v-if="target" class="overlay" @click.self="phase !== 'progress' && close()">
    <div class="dialog">
      <button class="close" type="button" title="关闭" @click="close">
        <X :size="16" />
      </button>

      <!-- 确认态：展示 adb 设备，无在线设备时禁用确认 -->
      <template v-if="phase === 'confirm'">
        <h3 class="title">拉取皮肤「{{ target.label }}」？</h3>
        <p class="hint">将从设备拉取 bundle 并解包烘焙到 models/，完成后自动加载。</p>
        <div v-if="!deviceReady" class="device loading">正在检测设备…</div>
        <ul v-else-if="online.length" class="device">
          <li v-for="d in online" :key="d.serial">{{ d.model || '未知型号' }}（{{ d.serial }}）</li>
        </ul>
        <p v-else class="device none">未检测到 adb 设备，请先连接模拟器/手机</p>
        <div class="actions">
          <button class="btn" type="button" @click="close">取消</button>
          <button class="btn primary" type="button" :disabled="deviceReady && !online.length" @click="start">
            确认拉取
          </button>
        </div>
      </template>

      <!-- 进度态：进度条（不定态走滑动动画），不再刷日志 -->
      <template v-else-if="phase === 'progress'">
        <h3 class="title">{{ progress?.label ?? phaseText }}</h3>
        <div class="bar" :class="{ indeterminate: progress?.percent == null }">
          <div class="fill" :style="progress?.percent != null ? { width: progress.percent + '%' } : null" />
        </div>
        <p class="pct">{{ progress?.percent != null ? Math.round(progress.percent) + '%' : '处理中…' }}</p>
      </template>

      <!-- 失败态：错误原文 + 重试 -->
      <template v-else>
        <h3 class="title">拉取失败</h3>
        <pre class="log error">{{ job?.error }}</pre>
        <pre v-if="logTail" class="log">{{ logTail }}</pre>
        <div class="actions">
          <button class="btn" type="button" @click="close">关闭</button>
          <button class="btn primary" type="button" @click="start">重试</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.45);
}

/* 对齐 SkinTab .panel 的浮层主题 */
.dialog {
  position: relative;
  width: 380px;
  padding: 20px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: rgba(16, 16, 20, 0.92);
  backdrop-filter: blur(12px);
  color: #e8e8ee;
}

.close {
  position: absolute;
  top: 10px;
  right: 10px;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: #8a8a93;
  cursor: pointer;
}

.close:hover {
  color: #e8e8ee;
}

.title {
  margin: 0 0 10px;
  font: 600 15px/1.4 system-ui, sans-serif;
}

.hint {
  margin: 0 0 12px;
  color: #8a8a93;
  font: 500 12px/1.5 system-ui, sans-serif;
}

.device {
  margin: 0 0 12px;
  padding: 0;
  list-style: none;
  color: #c8c8d0;
  font: 500 13px/1.6 system-ui, sans-serif;
}

.device.none {
  color: #e05a5a;
}

.device.loading {
  color: #8a8a93;
}

.log {
  max-height: 160px;
  margin: 0 0 12px;
  padding: 8px 10px;
  overflow-y: auto;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  color: #c8c8d0;
  font: 400 11px/1.5 ui-monospace, monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

.log.error {
  color: #e05a5a;
}

/* 进度条：定态按百分比填充，不定态走来回滑动动画 */
.bar {
  height: 8px;
  margin: 0 0 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  overflow: hidden;
}

.fill {
  height: 100%;
  border-radius: 999px;
  background: #4fc08d;
  transition: width 0.3s ease;
}

.bar.indeterminate .fill {
  width: 30%;
  animation: slide 1.2s ease-in-out infinite;
}

@keyframes slide {
  from {
    transform: translateX(-110%);
  }

  to {
    transform: translateX(440%);
  }
}

.pct {
  margin: 0;
  color: #8a8a93;
  font: 500 12px/1.4 system-ui, sans-serif;
  text-align: right;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn {
  padding: 7px 14px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  color: #c8c8d0;
  font: 500 13px/1.4 system-ui, sans-serif;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #e8e8ee;
}

.btn.primary {
  border-color: #4fc08d;
  background: rgba(79, 192, 141, 0.12);
  color: #4fc08d;
}

.btn.primary:hover {
  background: rgba(79, 192, 141, 0.22);
}

.btn.primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
