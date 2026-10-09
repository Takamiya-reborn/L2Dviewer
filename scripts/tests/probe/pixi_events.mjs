/**
 * pixi 事件管线探针（L2dStage onMounted 期浏览器探针的归档版）。
 *
 * 背景：查看器的指针交互最初想走 pixi 事件，实测 pixi v6 的事件管线在本
 * 项目里不触发，遂改用原生 DOM 事件（语义与 Unity 端一致：按住跟随、松手
 * 判定）。此探针曾在 L2dStage 挂载时验证该结论，现抽出来归档——若日后
 * 升级 pixi-live2d-display/pixi 版本想迁回 pixi 事件管线，重新在浏览器里
 * 跑一遍本探针确认即可。
 *
 * 用法：npm run dev 起站后，把下面打印的代码粘进浏览器控制台执行；
 * 再点击/移动指针到模型上，看控制台输出。
 */

const probe = `// pixi 事件管线存活探针（结果对照见 scripts/tests/probe/pixi_events.mjs 头注释）
const stage = document.querySelector('.canvas-host')?.__pixiApp?.stage
  ?? Object.values(document.querySelector('.canvas-host canvas'))
    .find((v) => v?.stage)?.stage
if (!stage) {
  console.log('[diag] 未找到 pixi stage（改从 window.__l2d 或渲染器实例取）')
} else {
  stage.interactive = true
  stage.hitArea = stage.renderer?.screen ?? stage.hitArea
  stage.on('pointertap', () => console.log('[diag] pixi pointertap 触发了'))
  let moved = false
  stage.on('pointermove', () => {
    if (!moved) { moved = true; console.log('[diag] pixi pointermove 触发了（pixi 事件管线存活）') }
  })
  console.log('[diag] 探针已挂，点击/移动指针试试')
}`

console.log(probe)
console.log(`
== 历史结论（2026-10，pixi v6 + pixi-live2d-display/cubism4）==
挂 stage.interactive = true + hitArea = app.screen 后，pointertap/pointermove
均不触发——pixi v6 事件管线在本项目不存活（原因未深究：EventBoundary 与
registerTicker 补丁的时序嫌疑最大）。指针交互以 canvas 原生 DOM 事件为准
（pointerdown/move/up/cancel/leave），见 src/l2d/gestures.js。`)
