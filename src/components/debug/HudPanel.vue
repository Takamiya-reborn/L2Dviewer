<script>
import { reactive, watch } from 'vue'

// 分组开合：模块级状态，组件重挂载（模型切换/HMR）不丢；localStorage 仅页面加载时恢复一次
const GROUP_KEY = 'l2d-hud-groups'
const DEFAULT_OPEN = {
  motion: true,
  state: false,
  machine: true,
  tap: false,
  params: false,
  relations: false,
  gates: false,
  palette: true,
  scale: true,
}

function readSavedGroups() {
  try {
    return JSON.parse(localStorage.getItem(GROUP_KEY) ?? '{}') ?? {}
  } catch {
    return {} // 存档损坏即回默认
  }
}

const open = reactive({ ...DEFAULT_OPEN })
for (const [k, v] of Object.entries(readSavedGroups())) {
  if (k in DEFAULT_OPEN) open[k] = !!v
}
watch(open, (v) => {
  try {
    localStorage.setItem(GROUP_KEY, JSON.stringify(v))
  } catch {
    // 隐私模式下写入失败不影响使用
  }
})
</script>

<script setup>
import { ChevronRight } from 'lucide-vue-next'

// 判定门刻度：区间端点映射到 [lo,hi] 全程的百分比
function spanPct(gate, v) {
  const span = gate.hi - gate.lo
  return span > 0 ? ((v - gate.lo) / span) * 100 : 0
}

// 判定门实时值（模型实时读数，可能为 0）
function fmtValue(v) {
  return typeof v === 'number' ? v.toFixed(2) : '—'
}

// 判定引导环逐门读数（hints.js ringReads）：在画 = α 与锚点坐标，未画 = 原因
function ringText(gate, rings) {
  const r = (rings ?? []).find((e) => e.zone === gate.zone)
  if (!r) return '环:无读数'
  if (r.why) return '环:' + r.why
  return `环:画 a=${r.a.toFixed(2)} @(${Math.round(r.x)},${Math.round(r.y)})`
}

// 分组开合状态与持久化在文件顶部普通 <script> 的模块级作用域
function toggleGroup(key) {
  open[key] = !open[key]
}

defineProps({
  /** 结构化 HUD 读数（l2d/hud.js 组装）：状态参数、非默认残留、机器读数、标定 */
  hud: { type: Object, default: null },
  showHints: { type: Boolean, default: true },
  showDebug: { type: Boolean, default: true },
  /** 触点涟漪（游戏"触点特效"复刻）开关 */
  showRipple: { type: Boolean, default: true },
  /** 锁帧开关：开启后 app.ticker 与 Ticker.shared 都锁 60fps（游戏参数机节拍） */
  lockFrame: { type: Boolean, default: false },
  /** FPS 读数（L2dStage 每 0.5s 采样 app.ticker.FPS） */
  fps: { type: Number, default: 0 },
})

const emit = defineEmits(['toggle-hints', 'toggle-debug', 'toggle-ripple', 'toggle-lockframe', 'reset'])
</script>

<template>
  <div class="stage-toolbar">
    <button class="hint-toggle" type="button" :class="{ on: showHints }" @click="emit('toggle-hints')">
      交互点
    </button>
    <button class="hint-toggle" type="button" :class="{ on: showDebug }" @click="emit('toggle-debug')">
      调试信息
    </button>
    <button class="hint-toggle" type="button" :class="{ on: showRipple }" @click="emit('toggle-ripple')">
      触点涟漪
    </button>
    <button class="hint-toggle" type="button" :class="{ on: lockFrame }" @click="emit('toggle-lockframe')">
      锁帧 60
    </button>
    <button class="hint-toggle" type="button" @click="emit('reset')">
      重置交互
    </button>
  </div>

  <div v-if="showDebug && hud" class="debug-panel">
    <!-- 首行常显：FPS 实时读数（0.5s 窗口计数），不随分组折叠 -->
    <span class="debug-pair">{{ fps }} FPS</span>
    <!-- 动作：挂起动作 / idle循环 / fallback 路由 -->
    <div v-if="hud.motion" class="group" :class="{ open: open.motion }">
      <button class="group-head" type="button" @click="toggleGroup('motion')">
        <ChevronRight class="tri" :class="{ open: open.motion }" :size="12" />动作
        <span v-if="!open.motion" class="dim">{{ hud.motion.name ?? '（无挂起）' }}</span>
      </button>
      <div class="group-body">
        <span class="debug-pair">{{ hud.motion.name ?? '（无挂起）' }}</span>
        <span v-if="hud.motion.idle" class="debug-pair dim">idle循环</span>
        <span v-if="hud.motion.fallback" class="debug-pair dim">
          {{ hud.motion.fallback.source }}:{{ hud.motion.fallback.clip }}[{{ hud.motion.fallback.index }}]<template
            v-if="hud.motion.fallback.degraded">退化</template>
        </span>
      </div>
    </div>

    <!-- 状态：状态参数 + 非默认残留 -->
    <div v-if="hud.zones.length || hud.carried.length" class="group" :class="{ open: open.state }">
      <button class="group-head" type="button" @click="toggleGroup('state')">
        <ChevronRight class="tri" :class="{ open: open.state }" :size="12" />状态
        <span v-if="!open.state" class="dim">{{ hud.zones.length + hud.carried.length }} 项</span>
      </button>
      <div class="group-body">
        <span v-for="([k, v], i) in hud.zones" :key="'z' + i" class="debug-pair">{{ k }}={{ v }}</span>
        <span v-for="([k, v], i) in hud.carried" :key="'c' + i" class="debug-pair dim">{{ k }}={{ v }}</span>
      </div>
    </div>

    <template v-if="hud.machine">
      <!-- 机器：idle 变体 / 白名单 / 落账 / 按压锁 / 播放中滞留（收起时头部仍保 Warn） -->
      <div class="group" :class="{ open: open.machine }">
        <button class="group-head" type="button" @click="toggleGroup('machine')">
          <ChevronRight class="tri" :class="{ open: open.machine }" :size="12" />机器
          <span v-if="!open.machine" class="dim">idle={{ hud.machine.idle }}</span>
          <span v-if="!open.machine && hud.machine.playing" class="warn">
            播放中:{{ hud.machine.playName }}
          </span>
        </button>
        <div class="group-body">
          <span class="debug-pair">idle={{ hud.machine.idle }}</span>
          <span class="debug-pair">白名单={{ hud.machine.whitelist }}<template v-if="hud.machine.wlIdle">(t{{
            hud.machine.wlIdle }})</template></span>
          <span v-if="hud.machine.actor" class="debug-pair">落账=#{{ String(hud.machine.actor).slice(-2) }}</span>
          <span v-if="hud.machine.able" class="debug-pair">按压锁</span>
          <span v-if="hud.machine.active" class="debug-pair">按住:{{ hud.machine.active }}</span>
          <!-- 播放中滞留是"交互一次就锁死"的头号嫌疑：反应动作播完仍显示即中招 -->
          <span v-if="hud.machine.playing" class="debug-pair warn">
            播放中:{{ hud.machine.playName }}
          </span>
        </div>
      </div>

      <!-- 触发链：最近调度日志 -->
      <div v-if="hud.machine.tap?.length" class="group" :class="{ open: open.tap }">
        <button class="group-head" type="button" @click="toggleGroup('tap')">
          <ChevronRight class="tri" :class="{ open: open.tap }" :size="12" />触发链
          <span v-if="!open.tap" class="dim">{{ hud.machine.tap.length }} 条</span>
        </button>
        <div class="group-body">
          <span v-for="(e, i) in hud.machine.tap" :key="'t' + i" class="debug-pair dim">
            {{ e.t.toFixed(1) }} {{ e.line }}
          </span>
        </div>
      </div>

      <!-- 参数：各机器参数实时值 -->
      <div v-if="hud.machine.machines.length" class="group" :class="{ open: open.params }">
        <button class="group-head" type="button" @click="toggleGroup('params')">
          <ChevronRight class="tri" :class="{ open: open.params }" :size="12" />参数
          <span v-if="!open.params" class="dim">{{ hud.machine.machines.length }} 项</span>
        </button>
        <div class="group-body">
          <span v-for="([k, v], i) in hud.machine.machines" :key="'m' + i" class="debug-pair">{{ k }}={{ v }}</span>
        </div>
      </div>

      <!-- 联动：relation 参数实时值 -->
      <div v-if="hud.machine.relations.length" class="group" :class="{ open: open.relations }">
        <button class="group-head" type="button" @click="toggleGroup('relations')">
          <ChevronRight class="tri" :class="{ open: open.relations }" :size="12" />联动
          <span v-if="!open.relations" class="dim">{{ hud.machine.relations.length }} 项</span>
        </button>
        <div class="group-body">
          <span v-for="([k, v], i) in hud.machine.relations" :key="'r' + i" class="debug-pair">{{ k }}={{ v }}</span>
        </div>
      </div>

      <!-- 判定：type 11 区间机的门刻度条 -->
      <div v-if="hud.machine.gates.length" class="group" :class="{ open: open.gates }">
        <button class="group-head" type="button" @click="toggleGroup('gates')">
          <ChevronRight class="tri" :class="{ open: open.gates }" :size="12" />判定
          <span v-if="!open.gates" class="dim">{{ hud.machine.gates.length }} 门</span>
        </button>
        <div class="group-body gates-body">
          <div v-for="g in hud.machine.gates" :key="'g' + g.zone + g.param" class="gate">
            <span class="gate-head">{{ g.zone }} {{ g.param }}={{ fmtValue(g.value) }}（{{ ringText(g, hud.rings)
              }}）</span>
            <span class="gate-track">
              <span v-for="(b, i) in g.bands" :key="i" class="gate-band"
                :class="{ hit: g.value >= b.lo && g.value < b.hi }"
                :style="{ left: spanPct(g, b.lo) + '%', width: spanPct(g, b.hi) - spanPct(g, b.lo) + '%' }">
                {{ b.action }}
              </span>
            </span>
          </div>
        </div>
      </div>
    </template>

    <!-- 调色板：面板开合（BANZI）+ 色轴实时值，可点击循环/复位 -->
    <div v-if="hud.palette" class="group" :class="{ open: open.palette }">
      <button class="group-head" type="button" @click="toggleGroup('palette')">
        <ChevronRight class="tri" :class="{ open: open.palette }" :size="12" />调色板
        <span v-if="!open.palette" class="dim">{{ hud.palette.axes.length }} 轴</span>
      </button>
      <div class="group-body">
        <span v-if="hud.palette.open" class="debug-pair dim">面板开</span>
        <span v-for="([id, v], i) in hud.palette.axes" :key="'p' + i" class="debug-pair clickable"
          title="点击循环 0 → 1 → -1" @click="hud.palette.cycle(id)">
          {{ id }}={{ v }}
        </span>
        <span class="debug-pair dim clickable" title="全部色轴归零（默认方案）" @click="hud.palette.reset()">复位</span>
      </div>
    </div>

    <!-- 标定：全局缩放 -->
    <div class="group" :class="{ open: open.scale }">
      <button class="group-head" type="button" @click="toggleGroup('scale')">
        <ChevronRight class="tri" :class="{ open: open.scale }" :size="12" />标定
        <span v-if="!open.scale" class="dim">×{{ hud.scale.toFixed(2) }}</span>
      </button>
      <div class="group-body">
        <span class="debug-pair">×{{ hud.scale.toFixed(2) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
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

/* 开启态：浅底深字，与关闭态的深底亮字一眼可辨 */
.hint-toggle.on {
  border-color: rgba(159, 217, 189, 0.4);
  background: rgba(159, 217, 189, 0.9);
  color: #10221a;
}

/* 调试面板（测试用）：分组折叠，组头收起时带单值摘要；整体向上生长不遮模型重心。
   面板本体 pointer-events 穿透，只有组头和可点击读数接管鼠标，不挡模型交互 */
.debug-panel {
  position: absolute;
  right: 12px;
  bottom: 44px;
  max-width: 46%;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  background: rgba(12, 12, 16, 0.72);
  backdrop-filter: blur(12px);
  color: #9fd9bd;
  font: 500 11px/1.6 ui-monospace, monospace;
  user-select: none;
  pointer-events: none;
}

/* 每个分组：组头占 auto 行，内容体行 0fr（收起）/ 1fr（展开）过渡出高度动画 */
.group {
  display: grid;
  grid-template-rows: auto 0fr;
  transition: grid-template-rows 0.15s;
}

.group.open {
  grid-template-rows: auto 1fr;
}

.group-head {
  display: flex;
  align-items: center;
  column-gap: 5px;
  padding: 0;
  border: none;
  background: none;
  color: #6b6b76;
  font: inherit;
  text-align: left;
  cursor: pointer;
  pointer-events: auto;
}

.group-head:hover {
  color: #e8e8ee;
}

/* 分组箭头：展开时右转 90° 朝下 */
.tri {
  flex-shrink: 0;
  transition: transform 0.15s;
}

.tri.open {
  transform: rotate(90deg);
}

.group-body {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 12px;
  padding-left: 13px;
  /* 网格项默认 min-height:auto 不许缩，需显式归零才能被 0fr 行压没 */
  min-height: 0;
  overflow: hidden;
  opacity: 0;
  transition: opacity 0.15s;
}

.group.open .group-body {
  opacity: 1;
}

.gates-body {
  flex-direction: column;
}

.debug-pair {
  white-space: nowrap;
}

/* 非默认残留读数弱化（连续摆位的遗留值，非门控参数） */
.debug-pair.dim,
.dim {
  color: #6f9f88;
}

/* 异常态读数（播放中滞留等）：暖色提示一眼可辨 */
.debug-pair.warn,
.warn {
  color: #e8b06f;
}

/* 可点击读数（调色板色轴循环/复位）：与提示开关同族的悬停反馈 */
.debug-pair.clickable {
  cursor: pointer;
  pointer-events: auto;
}

.debug-pair.clickable:hover {
  color: #e8e8ee;
}

/* 判定门刻度条（type 11 区间机）：轨道 + 各区间段，实时值所在段点亮 */
.gate {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  min-width: 220px;
}

.gate-head {
  white-space: nowrap;
}

.gate-track {
  position: relative;
  height: 15px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 4px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.04);
}

.gate-band {
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
  border-left: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.06);
  color: #6f9f88;
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
}

/* 实时值落在的区间段：点亮 */
.gate-band.hit {
  background: rgba(159, 217, 189, 0.28);
  color: #dff5ea;
}
</style>
