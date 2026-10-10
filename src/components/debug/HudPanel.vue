<script setup>
defineProps({
  /** 结构化 HUD 读数（l2d/hud.js 组装）：状态参数、非默认残留、机器读数、标定 */
  hud: { type: Object, default: null },
  showHints: { type: Boolean, default: true },
  showDebug: { type: Boolean, default: true },
  /** 当前皮肤是否配了拖拽参数机（决定"重置交互"按钮显隐） */
  hasOrch: { type: Boolean, default: false },
})

const emit = defineEmits(['toggle-hints', 'toggle-debug', 'reset'])
</script>

<template>
  <div class="stage-toolbar">
    <button class="hint-toggle" type="button" @click="emit('toggle-hints')">
      {{ showHints ? '隐藏交互点' : '显示交互点' }}
    </button>
    <button class="hint-toggle" type="button" @click="emit('toggle-debug')">
      {{ showDebug ? '隐藏调试信息' : '显示调试信息' }}
    </button>
    <button v-if="hasOrch" class="hint-toggle" type="button" @click="emit('reset')">
      重置交互
    </button>
  </div>
  <div v-if="showDebug && hud" class="debug-panel">
    <div v-if="hud.motion" class="debug-row">
      <span class="debug-key">动作</span>
      <span class="debug-pair">{{ hud.motion.name ?? '（无挂起）' }}</span>
      <span v-if="hud.motion.idle" class="debug-pair dim">idle循环</span>
      <span v-if="hud.motion.fallback" class="debug-pair dim">
        {{ hud.motion.fallback.source }}:{{ hud.motion.fallback.clip }}[{{ hud.motion.fallback.index }}]<template v-if="hud.motion.fallback.degraded">退化</template>
      </span>
    </div>
    <template v-if="hud.zones.length || hud.carried.length">
      <div class="debug-row">
        <span class="debug-key">状态</span>
        <span v-for="([k, v], i) in hud.zones" :key="'z' + i" class="debug-pair">{{ k }}={{ v }}</span>
        <span v-for="([k, v], i) in hud.carried" :key="'c' + i" class="debug-pair dim">{{ k }}={{ v }}</span>
      </div>
    </template>
    <template v-if="hud.machine">
      <div class="debug-row">
        <span class="debug-key">机器</span>
        <span class="debug-pair">idle={{ hud.machine.idle }}</span>
        <span class="debug-pair">白名单={{ hud.machine.whitelist }}</span>
        <span v-if="hud.machine.able" class="debug-pair">按压锁</span>
        <span v-if="hud.machine.active" class="debug-pair">按住:{{ hud.machine.active }}</span>
      </div>
      <div v-if="hud.machine.machines.length" class="debug-row">
        <span class="debug-key">参数</span>
        <span v-for="([k, v], i) in hud.machine.machines" :key="'m' + i" class="debug-pair">{{ k }}={{ v }}</span>
      </div>
      <div v-if="hud.machine.relations.length" class="debug-row">
        <span class="debug-key">联动</span>
        <span v-for="([k, v], i) in hud.machine.relations" :key="'r' + i" class="debug-pair">{{ k }}={{ v }}</span>
      </div>
    </template>
    <div class="debug-row">
      <span class="debug-key">标定</span>
      <span class="debug-pair">×{{ hud.scale.toFixed(2) }}</span>
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

/* 调试面板（测试用）：状态机读数收进一个分组面板，底色与右下角工具栏
   一致，向上生长不遮模型重心 */
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

.debug-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 12px;
}

/* 每行行首分组名 */
.debug-key {
  color: #6b6b76;
}

.debug-pair {
  white-space: nowrap;
}

/* 非默认残留读数弱化（连续摆位的遗留值，非门控参数） */
.debug-pair.dim {
  color: #6f9f88;
}
</style>
