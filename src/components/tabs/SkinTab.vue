<script setup>
import { computed, ref } from 'vue'
import { ListFilter, PanelLeftClose, PanelLeftOpen, Search, X } from 'lucide-vue-next'
import ScrollBar from '../ScrollBar.vue'
import { CAMP_ORDER } from '../../utils/models'

const props = defineProps({
  /** [{ id, label, state, camp }]，state: baked=资源在盘 / cached=bundle 已拉 / remote=未拉取；camp 为阵营显示名 */
  tabs: { type: Array, required: true },
  /** v-model：当前选中项 id */
  modelValue: { type: String, default: '' },
  title: { type: String, default: '' },
})

defineEmits(['update:modelValue', 'pull-request'])

/** 侧栏默认收起，靠左缘圆钮拉开 */
const collapsed = ref(true)

/** 按显示名或皮肤代号（id）子串过滤（不区分大小写），叠加类型/状态/阵营档；全量目录下代号也能定位 */
const query = ref('')
const filtered = computed(() => {
  let list = props.tabs
  if (stateFilter.value !== 'all') {
    list = list.filter((tab) => (tab.state ?? 'baked') === stateFilter.value)
  }
  if (typeFilter.value !== null) {
    // 形态过滤：Live2D=有 l2d 版本可加载，Ani=有 spine 版本；两栖皮肤两个档都命中
    list = list.filter((tab) =>
      typeFilter.value === 'ani' ? (tab.ani ?? false) : (tab.l2d ?? true),
    )
  }
  if (campFilter.value) {
    list = list.filter((tab) => tab.camp === campFilter.value)
  }
  const q = query.value.trim().toLowerCase()
  if (q) {
    list = list.filter(
      (tab) =>
        String(tab.label ?? '').toLowerCase().includes(q) ||
        String(tab.id ?? '').toLowerCase().includes(q),
    )
  }
  return list
})

/** 状态筛选：chips 兼作圆点图例，计数为 0 的档位隐藏（全部恒显） */
const STATE_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'baked', label: '已烘焙' },
  { key: 'cached', label: '已缓存' },
  { key: 'remote', label: '未拉取' },
]
const stateFilter = ref('all')
const counts = computed(() => {
  const c = { all: props.tabs.length, baked: 0, cached: 0, remote: 0 }
  for (const tab of props.tabs) c[tab.state ?? 'baked']++
  return c
})

/** 阵营筛选：null=全阵营；chips 按游戏内阵营序排列，只渲染有条目的阵营 */
const campFilter = ref(null)
const campChips = computed(() => {
  const present = new Map()
  for (const tab of props.tabs) present.set(tab.camp ?? '其他', (present.get(tab.camp ?? '其他') ?? 0) + 1)
  const known = CAMP_ORDER.filter((label) => present.has(label))
  const extra = [...present.keys()].filter((label) => !CAMP_ORDER.includes(label))
  return [null, ...known, ...extra].map((key) => ({
    key,
    label: key ?? '全阵营',
    count: key === null ? props.tabs.length : present.get(key),
  }))
})

/** 状态到卡片 title 提示语的映射 */
const STATE_HINTS = {
  baked: '已烘焙 · 点击加载',
  cached: 'bundle 已缓存 · 点击解包烘焙',
  remote: '未拉取 · 点击从设备拉取',
}

/** 类型筛选：null=全类型；ani 标记来自目录条目（游戏模板 spine_use_live2d） */
const TYPE_FILTERS = [
  { key: null, label: '全类型' },
  { key: 'live2d', label: 'Live2D' },
  { key: 'ani', label: 'Ani' },
]
const typeFilter = ref(null)
const typeChips = computed(() =>
  TYPE_FILTERS.map((f) => ({
    ...f,
    count: f.key === null
      ? props.tabs.length
      : props.tabs.filter((tab) =>
        f.key === 'ani' ? (tab.ani ?? false) : (tab.l2d ?? true),
      ).length,
  })),
)

/** 筛选行（类型 + 状态 + 阵营 chips）默认收起，搜索栏右侧按钮展开；有档位生效时按钮保持高亮 */
const showFilters = ref(false)
const filterActive = computed(
  () => stateFilter.value !== 'all' || typeFilter.value !== null || campFilter.value !== null,
)
</script>

<template>
  <aside class="side-tabs" :class="{ collapsed }">
    <!-- 面板：蒙板式浮层，收起时整体滑出左缘；标题/搜索/筛选固定，滚动条只管列表区 -->
    <div class="panel">
      <h2 v-if="title" class="title">{{ title }}</h2>
      <div class="search-row">
        <div class="search">
          <Search class="search-icon" :size="15" />
          <input v-model="query" type="text" placeholder="搜索皮肤…" spellcheck="false" />
          <button v-if="query" class="clear" type="button" title="清空搜索" @click="query = ''">
            <X :size="14" />
          </button>
        </div>
        <button class="filter-toggle" :class="{ on: showFilters || filterActive }" type="button" title="状态与阵营筛选"
          @click="showFilters = !showFilters">
          <ListFilter :size="15" />
        </button>
      </div>
      <div class="filters-wrap" :class="{ open: showFilters }">
        <div class="filters-inner">
          <div class="filter-group">
            <span class="group-label">类型</span>
            <div class="chips">
              <button v-for="f in typeChips" :key="f.key ?? 'all-types'" class="chip"
                :class="{ on: typeFilter === f.key }" type="button" @click="typeFilter = f.key">
                {{ f.label }} <span class="count">{{ f.count }}</span>
              </button>
            </div>
          </div>
          <div class="filter-group">
            <span class="group-label">状态</span>
            <div class="chips">
              <button v-for="f in STATE_FILTERS" v-show="f.key === 'all' || counts[f.key]" :key="f.key" class="chip"
                :class="{ on: stateFilter === f.key }" type="button" @click="stateFilter = f.key">
                <i v-if="f.key !== 'all'" class="dot" :class="f.key" />{{ f.label }}
                <span class="count">{{ counts[f.key] }}</span>
              </button>
            </div>
          </div>
          <div class="filter-group">
            <span class="group-label">阵营</span>
            <div class="chips">
              <button v-for="c in campChips" :key="c.key ?? 'all-camps'" class="chip"
                :class="{ on: c.key === null ? campFilter === null : campFilter === c.key }" type="button"
                @click="campFilter = campFilter === c.key ? null : c.key">
                {{ c.label }} <span class="count">{{ c.count }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      <ScrollBar :inset="24">
        <ul v-if="filtered.length" class="list">
          <li v-for="tab in filtered" :key="tab.id">
            <slot name="item" :tab="tab" :active="tab.id === modelValue">
              <button class="card" :class="{ active: tab.id === modelValue, baked: (tab.state ?? 'baked') === 'baked' }"
                type="button" :title="`${tab.label ?? tab.id}（${tab.id}）· ${STATE_HINTS[tab.state ?? 'baked']}`"
                @click="(tab.state ?? 'baked') === 'baked' ? $emit('update:modelValue', tab.id) : $emit('pull-request', tab)">
                <span class="label">{{ tab.label ?? tab.id }}</span>
                <i v-if="tab.state" class="dot" :class="tab.state" />
              </button>
            </slot>
          </li>
        </ul>
        <p v-else class="empty">无匹配皮肤</p>
      </ScrollBar>
    </div>
    <!-- 把手：垂直居中骑在左缘，收起后仍留在屏幕内供拉开 -->
    <button class="toggle" type="button" :title="collapsed ? '展开侧栏' : '收起侧栏'" @click="collapsed = !collapsed">
      <PanelLeftClose v-if="!collapsed" :size="36" />
      <PanelLeftOpen v-else :size="36" />
    </button>
  </aside>
</template>

<style scoped>
.side-tabs {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 10;
  width: 60%;
  transform: translateX(0);
  transition: transform 0.25s ease;
  user-select: none;
}

.side-tabs.collapsed {
  transform: translateX(-100%);
}

.panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(16, 16, 20, 0.72);
  backdrop-filter: blur(12px);
}

/* 把手骑在面板右缘（即侧栏与舞台的分界线），随面板一起滑动；圆角矩形，向内伸 24px 不与滚动条重叠 */
.toggle {
  position: absolute;
  top: 50%;
  right: -24px;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: rgba(16, 16, 20, 0.72);
  backdrop-filter: blur(12px);
  color: #8a8a93;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.toggle:hover {
  background: rgba(35, 35, 44, 0.9);
  color: #e8e8ee;
}

/* 标题：居中 + 灰底横带分区 */
.title {
  margin: 0 0 14px;
  padding: 10px 16px;
  background: #202028;
  color: #8a8a93;
  font: 600 14px/1.4 system-ui, sans-serif;
  text-align: center;
  letter-spacing: 0.08em;
}

/* 搜索行：输入条 + 筛选胶囊并排 */
.search-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 20px 18px;
}

/* 搜索框：对齐卡片主题的圆角输入条，实底不透出模型画面 */
.search {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  background: #1c1c23;
  transition: border-color 0.15s;
}

.search:focus-within {
  border-color: #4fc08d;
}

.search-icon {
  flex: none;
  margin-left: 10px;
  color: #8a8a93;
}

.search input {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border: none;
  outline: none;
  background: transparent;
  color: #e8e8ee;
  font: 500 14px/1.4 system-ui, sans-serif;
}

.search input::placeholder {
  color: #6a6a73;
}

/* 清空钮：仅在输入非空时出现 */
.search .clear {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin-right: 6px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: #8a8a93;
  cursor: pointer;
  transition: color 0.15s;
}

.search .clear:hover {
  color: #e8e8ee;
}

.empty {
  padding: 24px 20px;
  color: #6a6a73;
  font: 500 14px/1.4 system-ui, sans-serif;
  text-align: center;
}

/* 筛选行容器：grid 0fr->1fr 做展开/收起高度过渡（阵营 chips 换行高度不定） */
.filters-wrap {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows 0.25s ease, opacity 0.25s ease;
}

.filters-wrap.open {
  grid-template-rows: 1fr;
  opacity: 1;
}

.filters-inner {
  min-height: 0;
  overflow: hidden;
}

/* 筛选分组：小标题 + chips 行，组间留白拉开分区 */
.filter-group {
  margin: 0 20px 18px;
}

/* 分组标题：负边距通到面板两缘，做成居中灰底横带分隔 */
.group-label {
  display: block;
  margin: 0 -20px 10px;
  padding: 6px 20px;
  background: #202028;
  color: #8a8a93;
  font: 600 13px/1.2 system-ui, sans-serif;
  text-align: center;
  letter-spacing: 0.1em;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 状态筛选 chips：档位标签 + 计数徽章，实底不透出模型画面，圆点兼作卡片状态图例 */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 9px;
  background: #1c1c23;
  color: #a8a8b2;
  font: 600 13px/1.4 system-ui, sans-serif;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}

.chip:hover {
  border-color: rgba(255, 255, 255, 0.22);
  background: #26262e;
  color: #e8e8ee;
}

/* 选中档：主题色实底填充 + 深色文字，远看也一眼可辨 */
.chip.on {
  border-color: #4fc08d;
  background: #4fc08d;
  color: #0e2016;
}

.chip .count {
  padding: 0 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.09);
  color: inherit;
  font-weight: 700;
  font-size: 11.5px;
  line-height: 18px;
}

.chip.on .count {
  background: rgba(0, 0, 0, 0.22);
}

/* 选中档上状态圆点转深色，避免绿底上原色不可辨 */
.chip.on .dot.baked {
  background: rgba(0, 0, 0, 0.55);
}

.chip.on .dot.cached,
.chip.on .dot.remote {
  border-color: rgba(0, 0, 0, 0.55);
}

/* 筛选开关：与搜索框同圆角的方块，实底不透出模型画面；展开或生效时高亮主题色 */
.filter-toggle {
  flex: none;
  display: grid;
  place-items: center;
  width: 38px;
  height: 36px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  background: #1c1c23;
  color: #8a8a93;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}

.filter-toggle:hover {
  background: #26262e;
  border-color: rgba(255, 255, 255, 0.2);
  color: #e8e8ee;
}

.filter-toggle.on {
  border-color: #4fc08d;
  background: rgba(79, 192, 141, 0.08);
  color: #4fc08d;
}

/* 资源状态圆点：实心绿=在盘可加载，空心绿=bundle 已缓存，空心灰=未拉取 */
.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.dot.baked {
  background: #197a30;
}

.dot.cached {
  border: 1.5px solid #4fc08d;
}

.dot.remote {
  border: 1.5px solid #55555e;
}

/* 卡片网格：固定四列行式条目，样式对齐右侧 StateTab */
.list {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  padding: 4px 20px 24px;
  list-style: none;
}

.card {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 10px 14px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  color: #8a8a93;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}

.card:hover {
  border-color: rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.06);
  color: #c8c8d0;
}

.card.active {
  border-color: #4fc08d;
  background: rgba(79, 192, 141, 0.1);
  color: #e8e8ee;
}

/* 已烘焙资源在盘的条目标绿（写在 .card:hover 后使 hover 也保持绿、.card.active 后使选中态优先） */
.card.baked {
  color: #197a30;
}

/* 状态圆点贴卡片右缘，与名字之间留白 */
.card .dot {
  margin-left: auto;
}

.label {
  overflow: hidden;
  font: 600 15px/1.3 system-ui, sans-serif;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
