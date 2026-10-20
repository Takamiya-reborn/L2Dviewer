<script>
import { reactive, watch } from 'vue'

// 分组开合：模块级状态，组件重挂载（模型切换/HMR）不丢；localStorage 仅页面加载时恢复一次
const GROUP_KEY = 'l2d-hud-groups'
const DEFAULT_OPEN = {
  motion: true,
  diff: false,
  state: false,
  machine: true,
  tap: false,
  params: false,
  relations: false,
  gates: false,
  hints: false,
  palette: true,
  scale: true,
  inject: false,
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
import { ref } from 'vue'
import { ChevronRight } from 'lucide-vue-next'

// 强播下拉选中值（跨分组开合保持）
const playSel = ref('')

// 注入备选参数清单（hud.paramList）：正则分类（去尾数字得组名）+ 网格平铺，点格注入，初值取当前动作基值；
// 只看开关过滤掉仍在默认值的参数（排查"哪些在被驱动"）
const onlyOff = ref(false)
function filteredParams(hud) {
  const all = hud?.paramList ?? []
  return onlyOff.value ? all.filter((p) => Math.abs(p.value - p.def) > 1e-4) : all
}
function groupedParams(hud) {
  const groups = []
  const byName = new Map()
  for (const p of filteredParams(hud)) {
    const name = p.id.replace(/\d+$/, '') || p.id
    let g = byName.get(name)
    if (!g) {
      g = { name, items: [] }
      byName.set(name, g)
      groups.push(g)
    }
    g.items.push(p)
  }
  // 组内自然排序：数字段按数值比较，jjxt/jjxt2/.../jjxt10 顺下去而不是字典序 jjxt10 排 jjxt2 前
  for (const g of groups) g.items.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  return groups
}
function pickParam(hud, p) {
  if (!hud?.override) return
  if (!hud.override.list.some((e) => e.id === p.id)) hud.override.set(p.id, p.value)
}

// 状态分区读数（hud.zones）：开关参数非 0 即在亮，"只看亮着"过滤熄灭行（排查当前哪个分区在生效）
const onlyLit = ref(false)
function litZones(hud) {
  return (hud?.zones ?? []).filter(([, v]) => Math.abs(v) > 1e-4)
}

// 状态读数分组：去尾数字得组名（与注入清单同法），组内自然排序
function groupedPairs(pairs) {
  const groups = []
  const byName = new Map()
  for (const [id, value] of pairs) {
    const name = id.replace(/\d+$/, '') || id
    let g = byName.get(name)
    if (!g) {
      g = { name, items: [] }
      byName.set(name, g)
      groups.push(g)
    }
    g.items.push({ id, value })
  }
  for (const g of groups) g.items.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  return groups
}

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
  showDebug: { type: Boolean, default: false },
  /** 注入面板（参数覆盖层）独立开关：不随调试信息面板收起 */
  showInject: { type: Boolean, default: false },
  /** 触点涟漪（游戏"触点特效"复刻）开关 */
  showRipple: { type: Boolean, default: true },
  /** 锁帧开关：开启后 app.ticker 与 Ticker.shared 都锁 60fps（游戏参数机节拍） */
  lockFrame: { type: Boolean, default: false },
  /** 隐藏 dev 功能：收起其余工具按钮与调试/注入面板（给非开发者的测试员/用户留干净界面） */
  hideDev: { type: Boolean, default: false },
  /** FPS 读数（L2dStage 每 0.5s 采样 app.ticker.FPS） */
  fps: { type: Number, default: 0 },
})

const emit = defineEmits(['toggle-hints', 'toggle-debug', 'toggle-ripple', 'toggle-inject', 'toggle-lockframe', 'toggle-hidedev', 'reset'])
</script>

<template>
  <div class="stage-toolbar">
    <button v-if="!hideDev" class="hint-toggle" type="button" :class="{ on: showDebug }" @click="emit('toggle-debug')">
      调试信息
    </button>
    <button v-if="!hideDev" class="hint-toggle" type="button" :class="{ on: showInject }" @click="emit('toggle-inject')">
      注入
    </button>
    <button v-if="!hideDev" class="hint-toggle" type="button" :class="{ on: showRipple }" @click="emit('toggle-ripple')">
      触点涟漪
    </button>
    <button v-if="!hideDev" class="hint-toggle" type="button" :class="{ on: lockFrame }" @click="emit('toggle-lockframe')">
      锁帧 60
    </button>
    <button class="hint-toggle" type="button" @click="emit('toggle-hidedev')">
      {{ hideDev ? '显示dev功能' : '隐藏dev功能' }}
    </button>
    <!-- 交互点：测试者也要用，不随 dev 隐藏收起 -->
    <button class="hint-toggle" type="button" :class="{ on: showHints }" @click="emit('toggle-hints')">
      交互点
    </button>
    <button class="hint-toggle" type="button" @click="emit('reset')">
      重置交互
    </button>
  </div>

  <div v-if="!hideDev && (showDebug || showInject) && hud" class="debug-stack">
    <!-- 注入面板：独立开关，调试面板收起时仍可用 -->
    <div v-if="showInject && hud.override" class="debug-panel">
      <!-- 注入：参数覆盖层（beforeModelUpdate 钉值，赢过动作/物理/机器/视线全部层）。
           注意 moc3 v5 分支吸附：参数值变一次，绑定网格可能永久切入另一关键形态分支，复位不解吸 -->
      <div class="group open-last" :class="{ open: open.inject }">
        <div class="inject-head">
          <button class="group-head" type="button" @click="toggleGroup('inject')">
            <ChevronRight class="tri" :class="{ open: open.inject }" :size="12" />注入
            <span v-if="!open.inject" class="dim">{{ hud.override.list.length }} 项</span>
          </button>
          <label class="debug-pair inject-only"><input v-model="onlyOff" type="checkbox">只看变化中</label>
          <span class="debug-pair dim">{{ filteredParams(hud).length }}/{{ (hud.paramList ?? []).length }}</span>
        </div>
        <div class="group-body">
          <div v-for="e in hud.override.list" :key="'i' + e.id" class="inject-item">
            <span class="debug-pair" :class="{ dim: !e.on }">{{ e.id }}</span>
            <input class="inject-range" type="range" :min="e.min ?? 0" :max="e.max ?? 1" :step="0.01"
              :value="e.value" :disabled="!e.on" @input="hud.override.set(e.id, +$event.target.value)">
            <span class="debug-pair" :class="{ warn: e.missing }">{{ e.missing ? '无此参数' : e.value.toFixed(2) }}</span>
            <span v-if="!e.missing" class="debug-pair dim">实{{ e.live.toFixed(2) }}</span>
            <input class="inject-check" type="checkbox" :checked="e.on" @change="hud.override.toggle(e.id, $event.target.checked)">
            <span class="debug-pair clickable" title="移除覆盖" @click="hud.override.remove(e.id)">×</span>
          </div>
          <!-- 备选清单：模型真实存在的参数，按去尾数字的正则分组、组内网格平铺，点格注入省去手敲 ID。
               格内常显实值（离默认值即暖色），变化一目了然；量程收进悬浮提示 -->
          <div class="param-list">
            <template v-for="g in groupedParams(hud)" :key="'g' + g.name">
              <span class="param-group-head">{{ g.name }} ×{{ g.items.length }}</span>
              <div class="param-grid">
                <span v-for="p in g.items" :key="'p' + p.id" class="param-cell"
                  :class="{ picked: hud.override.list.some((e) => e.id === p.id), off: Math.abs(p.value - p.def) > 1e-4 }"
                  :title="`${p.id}\n实值 ${p.value.toFixed(2)} 量程 [${p.min}, ${p.max}] 默认 ${p.def}\n点击注入`"
                  @click="pickParam(hud, p)">
                  <span class="cell-id">{{ p.id }}</span><span class="cell-val">{{ p.value.toFixed(2) }}</span>
                </span>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
    <div v-if="showDebug" class="debug-panel">
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
        <!-- 强播（诊断）：任意变体/特殊动作直接起播，用于跨变体姿态对照 -->
        <div v-if="hud.play" class="debug-row">
          <select v-model="playSel" class="debug-select">
            <option value="" disabled>选动作</option>
            <option v-for="c in hud.play.clips" :key="c" :value="c">{{ c }}</option>
          </select>
          <button class="hint-toggle" type="button" @click="playSel && hud.play.run(playSel)">强播</button>
        </div>
      </div>
    </div>

    <!-- 差分：在播动作曲线应值 vs 模型实值（参数被哪一层压低在此现形；混合期权重<1 时偏差属预期） -->
    <div v-if="hud.motionDiff" class="group" :class="{ open: open.diff }">
      <button class="group-head" type="button" @click="toggleGroup('diff')">
        <ChevronRight class="tri" :class="{ open: open.diff }" :size="12" />差分
        <span v-if="!open.diff" class="dim">
          {{ hud.motionDiff.count ? hud.motionDiff.count + ' 条' : '吻合' }}
        </span>
      </button>
      <div class="group-body">
        <span class="debug-pair dim">
          {{ hud.motionDiff.clip }} t={{ hud.motionDiff.t.toFixed(2) }}/{{ hud.motionDiff.duration.toFixed(2) }}s
          权重{{ hud.motionDiff.weight.toFixed(2) }}
        </span>
        <span v-for="r in hud.motionDiff.rows" :key="r.id" class="debug-pair">
          {{ r.id }} {{ r.want.toFixed(1) }}→{{ r.got.toFixed(1) }}
        </span>
        <span v-if="!hud.motionDiff.count" class="debug-pair dim">全部吻合</span>
      </div>
    </div>

    <!-- 状态：状态分区参数 + 摆位残留，按注入清单的分组网格平铺；
         分区亮着才有排查价值（暖色值），残留必离默认值（恒暖色），收起时头部留残留计数 -->
    <div v-if="hud.zones.length || hud.carried.length" class="group" :class="{ open: open.state }">
      <div class="inject-head">
        <button class="group-head" type="button" @click="toggleGroup('state')">
          <ChevronRight class="tri" :class="{ open: open.state }" :size="12" />状态
          <span v-if="!open.state" class="dim">{{ hud.carried.length }} 残留</span>
        </button>
        <label class="debug-pair inject-only"><input v-model="onlyLit" type="checkbox">只看亮着</label>
        <span class="debug-pair dim">{{ litZones(hud).length }}/{{ hud.zones.length }}</span>
      </div>
      <div class="group-body">
        <div class="param-list">
          <template v-for="g in groupedPairs(onlyLit ? litZones(hud) : hud.zones)" :key="'sz' + g.name">
            <span class="param-group-head">{{ g.name }} ×{{ g.items.length }}</span>
            <div class="param-grid">
              <span v-for="p in g.items" :key="'sp' + p.id" class="param-cell"
                :class="{ off: Math.abs(p.value) > 1e-4 }">
                <span class="cell-id">{{ p.id }}</span><span class="cell-val">{{ p.value.toFixed(2) }}</span>
              </span>
            </div>
          </template>
          <template v-if="hud.carried.length">
            <span class="param-group-head">残留 ×{{ hud.carried.length }}</span>
            <div class="param-grid">
              <span v-for="([id, value], i) in hud.carried" :key="'sc' + i" class="param-cell off">
                <span class="cell-id">{{ id }}</span><span class="cell-val">{{ value.toFixed(2) }}</span>
              </span>
            </div>
          </template>
        </div>
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

    <!-- 交互点：提示层逐分区读数（点 / 框无点 + 原因 / 被挡 / 出画 / 网格隐藏），bad = 入画却没点/被挡，门控排查重点 -->
    <div v-if="hud.dots?.length" class="group" :class="{ open: open.hints }">
      <button class="group-head" type="button" @click="toggleGroup('hints')">
        <ChevronRight class="tri" :class="{ open: open.hints }" :size="12" />交互点
        <span v-if="!open.hints" class="dim">
          {{ hud.dots.filter((d) => d.status === '点' || d.status === '点:质心').length }}点<template
            v-if="hud.dots.some((d) => d.bad)">·{{ hud.dots.filter((d) => d.bad).length }}异常</template>
        </span>
      </button>
      <div class="group-body">
        <span v-for="(d, i) in hud.dots" :key="'d' + i" class="debug-pair"
          :class="{ warn: d.bad, dim: !d.bad && (d.status === '网格隐藏' || d.status === '挡:出画' || d.status === '无点:出画') }">
          {{ d.name }}:{{ d.status }}
        </span>
      </div>
    </div>

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
   高度钳在视口内，超出出滚动条（参数/状态组长列表撑开时收在屏内）；滚动需接管鼠标，
   面板区域内点击不再穿透到模型 */
/* 面板叠放容器：调试面板 + 注入面板共用锚点，纵向排列互不遮挡 */
.debug-stack {
  position: absolute;
  /* 右缘 40px：避开状态触发收起后探进屏幕 32px 的圆钮把手 */
  right: 40px;
  bottom: 44px;
  /* 定宽：收缩适配链路里 auto-fill 网格在可用宽度不定时按"全格单行"取 max-content，
     面板会被一路顶到上限；定宽后状态/注入两块面板同宽稳定，网格按实际宽度分列 */
  width: min(660px, 46%);
  max-height: calc(100vh - 60px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  pointer-events: none;
}

.debug-stack > .debug-panel {
  max-width: 100%;
  pointer-events: auto;
}

.debug-panel {
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
  pointer-events: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(159, 217, 189, 0.35) transparent;
}

.debug-panel::-webkit-scrollbar {
  width: 6px;
}

.debug-panel::-webkit-scrollbar-thumb {
  border-radius: 3px;
  background: rgba(159, 217, 189, 0.35);
}

/* 每个分组：组头占 auto 行，内容体行 0fr（收起）/ 1fr（展开）过渡出高度动画；
   组间细分割线 + 组头留白，一眼可辨各分界 */
.group {
  display: grid;
  grid-template-rows: auto 0fr;
  padding: 3px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  transition: grid-template-rows 0.15s;
}

.group:last-of-type,
.group.open-last {
  padding-bottom: 0;
  border-bottom: none;
}

.group.open {
  grid-template-rows: auto 1fr;
}

/* 组头高亮底：与展开内容（面板原底）拉开底色差，title 一眼可辨；
   负外边距把底色拉到面板内边距上，文字落点不变 */
.group-head {
  display: flex;
  align-items: center;
  column-gap: 5px;
  margin: 0 -6px;
  padding: 2px 6px;
  border: none;
  border-radius: 5px;
  background: rgba(159, 217, 189, 0.1);
  color: #b6c9c0;
  font: inherit;
  letter-spacing: 0.05em;
  text-align: left;
  cursor: pointer;
  pointer-events: auto;
}

.group-head:hover {
  background: rgba(159, 217, 189, 0.18);
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

/* 强播/注入行：下拉与按钮同排同高（面板本体 pointer-events 穿透，行内控件显式接管） */
.debug-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  pointer-events: auto;
}

.debug-row .debug-select,
.debug-row .hint-toggle {
  box-sizing: border-box;
  height: 26px;
  padding: 0 10px;
}

.debug-select {
  max-width: 200px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(35, 35, 44, 0.9);
  color: #9fd9bd;
  font: inherit;
}

.debug-select:hover {
  background: rgba(50, 50, 62, 0.9);
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

/* 注入组：参数行（滑杆 + 值 + 开关 + 移除），面板本体穿透、行内控件显式接管 */
.inject-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  pointer-events: auto;
}

.inject-input {
  width: 130px;
}

.inject-range {
  flex: 1;
  min-width: 80px;
}

.inject-check {
  accent-color: #9fd9bd;
}

/* 注入组头行：开合按钮 + 只看变化中开关 + 统计同排（面板穿透，行内控件显式接管） */
.inject-head {
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: auto;
}

.inject-head .group-head {
  flex: 1;
}

.inject-only {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  cursor: pointer;
}

.inject-only input {
  accent-color: #9fd9bd;
  margin: 0;
}

/* 注入备选参数清单：分组网格平铺 + 超高滚动，点格注入；宽度占满面板（stack 已定宽，网格分列稳定） */
.param-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  max-height: 420px;
  overflow-y: auto;
  pointer-events: auto;
}

/* 分组标题行高亮：组名 ×数量一眼可辨，隔开上下两组网格 */
.param-group-head {
  margin-top: 4px;
  padding: 1px 6px;
  border-left: 2px solid #9fd9bd;
  background: rgba(159, 217, 189, 0.1);
  white-space: nowrap;
}

.param-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 1px;
}

/* 格子描边 + 细缝拼合成表：散排变整块，读数不再飘 */
.param-cell {
  display: flex;
  justify-content: space-between;
  gap: 4px;
  padding: 0 4px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.04);
  cursor: pointer;
  white-space: nowrap;
  line-height: 1.5;
}

.param-cell .cell-id {
  overflow: hidden;
  text-overflow: ellipsis;
}

.param-cell:hover .cell-id {
  color: #e8e8ee;
}

/* 离默认值的参数暖色：扫一眼即知哪些在被动作/物理驱动 */
.param-cell.off .cell-val {
  color: #e8b06f;
}

/* 已注入的格高亮：清单与覆盖层一一对应 */
.param-cell.picked .cell-id {
  color: #9fd9bd;
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
