/**
 * pixi 事件管线存活探针（浏览器模块，外挂于主代码）：给 pixi stage 挂 pointertap/pointermove 监听，验证 pixi 事件管线在本项目是否触发。指针交互现走 canvas 原生 DOM 事件（语义与 Unity 端一致：按住跟随、松手判定）；升级 pixi-live2d-display/pixi 版本想迁回 pixi 事件管线前，重跑本探针确认。
 *
 * 用法：dev server 起站后，在浏览器控制台执行 import('/probes/pixi_events.mjs')（重复执行追加 ?t=Date.now() 绕开模块缓存），再点击/移动指针到模型上，看控制台输出。
 *
 * 取舞台实例只走主代码暴露的调试句柄 canvasHost.__pixiApp（契约见 src/components/L2dStage.vue）；句柄取不到即契约断裂，直接报错——探针不做兜底猜测。
 *
 * 历史结论（2026-10，pixi v6 + pixi-live2d-display/cubism4）：挂 stage.interactive = true + hitArea = app.screen 后，pointertap/pointermove 均不触发——pixi v6 事件管线在本项目不存活（原因未深究：EventBoundary 与 registerTicker 补丁的时序嫌疑最大）。指针交互以 canvas 原生 DOM 事件为准（pointerdown/move/up/cancel/leave），见 src/l2d/gestures.js。
 */

// import 即执行；模块缓存使重复 import 不再进这里，用 ?t= 绕开
const stage = document.querySelector('.canvas-host')?.__pixiApp?.stage
if (!stage) {
  console.log('[diag] canvasHost.__pixiApp 句柄缺失——调试句柄契约断裂，见 src/components/L2dStage.vue')
} else {
  stage.interactive = true
  stage.hitArea = stage.renderer?.screen ?? stage.hitArea
  stage.on('pointertap', () => console.log('[diag] pixi pointertap 触发了'))
  let moved = false
  stage.on('pointermove', () => {
    if (!moved) { moved = true; console.log('[diag] pixi pointermove 触发了（pixi 事件管线存活）') }
  })
  console.log('[diag] 探针已挂，点击/移动指针试试')
}
