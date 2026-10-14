<script setup>
import { computed, ref } from 'vue'
import { PanelLeftClose, PanelLeftOpen, Search, X } from 'lucide-vue-next'

const props = defineProps({
  /** [{ id, label }] */
  tabs: { type: Array, required: true },
  /** v-model：当前选中项 id */
  modelValue: { type: String, default: '' },
  title: { type: String, default: '' },
})

defineEmits(['update:modelValue'])

/** 侧栏默认收起，靠左缘圆钮拉开 */
const collapsed = ref(true)

/** 按显示名子串过滤（不区分大小写），皮肤条目多时用于定位；id 是内部目录名不参与匹配 */
const query = ref('')
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return props.tabs
  return props.tabs.filter((tab) => String(tab.label ?? '').toLowerCase().includes(q))
})
</script>

<template>
  <aside class="side-tabs" :class="{ collapsed }">
    <!-- 面板：蒙板式浮层，收起时整体滑出左缘 -->
    <div class="panel">
      <h2 v-if="title" class="title">{{ title }}</h2>
      <div class="search">
        <Search class="search-icon" :size="15" />
        <input v-model="query" type="text" placeholder="搜索皮肤…" spellcheck="false" />
        <button v-if="query" class="clear" type="button" title="清空搜索" @click="query = ''">
          <X :size="14" />
        </button>
      </div>
      <ul v-if="filtered.length" class="list">
        <li v-for="tab in filtered" :key="tab.id">
          <slot name="item" :tab="tab" :active="tab.id === modelValue">
            <button class="card" :class="{ active: tab.id === modelValue }" type="button" :title="tab.label ?? tab.id"
              @click="$emit('update:modelValue', tab.id)">
              <span class="label">{{ tab.label ?? tab.id }}</span>
            </button>
          </slot>
        </li>
      </ul>
      <p v-else class="empty">无匹配皮肤</p>
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
  width: 100%;
  height: 100%;
  overflow-y: auto;
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(16, 16, 20, 0.72);
  backdrop-filter: blur(12px);
}

/* 把手骑在面板右缘（即侧栏与舞台的分界线），随面板一起滑动 */
.toggle {
  position: absolute;
  top: 50%;
  right: -32px;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 50%;
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

.title {
  padding: 14px 16px 10px;
  color: #8a8a93;
  font: 600 12px/1.4 system-ui, sans-serif;
  letter-spacing: 0.08em;
}

/* 搜索框：对齐卡片主题的圆角输入条 */
.search {
  position: relative;
  display: flex;
  align-items: center;
  margin: 0 20px 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
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

.label {
  overflow: hidden;
  font: 600 15px/1.3 system-ui, sans-serif;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
