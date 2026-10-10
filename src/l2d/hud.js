/**
 * 每帧回调：拖拽参数机步进 + 交互点提示更新 + HUD 结构化读数组装（写入
 * ctx.hud.value，展示层按组分节排版）。读 ctx.orch / ctx.hintsCtl /
 * ctx.dragScale。
 */

/**
 * @param ctx 舞台上下文（见 L2dStage.vue）
 * @returns {(deltaMS: number) => void} 挂到 pixi ticker 的回调
 */
export function createTickerCallback(ctx) {
  return () => {
    // 拖拽参数机每帧步进（平滑趋近/回弹倒计时/点击确认窗口/触发调度）
    ctx.orch?.step(ctx.app.ticker.deltaMS / 1000)
    const live = ctx.hintsCtl.update()
    const rt = ctx.runtime
    ctx.hud.value = {
      zones: live?.state ?? [],
      carried: live?.carried ?? [],
      machine: ctx.orch?.hudInfo() ?? null,
      scale: ctx.dragScale,
      // 挂起/播放中的动作（有向图 pending）：对照特效开关读数与动作的对应关系；
      // idleFallback = 最近一次 idle 起播的路由依据（显式路由/引擎回落/来源）
      motion: rt
        ? { name: rt.pending, idle: rt.pendingIdle, fallback: ctx.idleFallback ?? null }
        : null,
    }
  }
}
