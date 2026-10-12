/**
 * 调色板控制层（皮肤「配色方案」机制的查看器侧）。
 *
 * 游戏链路：touch_drag8 完结 → 路由 idle8 → state 覆写 BANZI=1 → moc3 关键帧点亮 8 个 texture_01 补丁件 = 调色板面板。
 * touch_drag11/12（染一组件）与 touch_drag13/14（染另一组）是 ±1 双向色轴，Core 关键帧色经 colorPatches 落到渲染。
 * 常规动作把这 4 个色轴钉在 0（默认方案），只有 idle8 不带这些曲线——游戏在面板打开期间由控制层直写参数。
 * 查看器同样在 afterMotionUpdate（主动作求值后、coreModel.update 前）落笔，选色跨动作保留。
 */

const AXIS_IDS = ['touch_drag11', 'touch_drag12', 'touch_drag13', 'touch_drag14']
const PANEL_PARAM = 'BANZI'

/**
 * @param ctx 舞台上下文（见 L2dStage.vue）：写入 ctx.palette
 * @param model 已挂载的 Live2DModel
 */
export function installPalette(ctx, model) {
  const values = {}
  for (const id of AXIS_IDS) values[id] = 0

  // coreModel 是框架包装层（CubismModel）：走 setParameter*ByIndex API，
  // 与 ambient/runtime 各层同族
  const core = model.internalModel.coreModel
  // 模型参数下标查表（皮肤没有这些参数时整层旁路）
  const axes = []
  for (const id of AXIS_IDS) {
    const i = core.getParameterIndex(id)
    if (i >= 0) axes.push([id, i, core.getParameterMaximumValue(i), core.getParameterMinimumValue(i)])
  }
  if (!axes.length) {
    ctx.palette = null
    return
  }
  const panelIdx = core.getParameterIndex(PANEL_PARAM)

  ctx.palette = {
    values,
    /** HUD 读数：面板开合 + 各轴当前值（Core 侧实时值） */
    read() {
      return {
        open: panelIdx >= 0 && core.getParameterValueByIndex(panelIdx) > 0.5,
        axes: axes.map(([id, i]) => [id, core.getParameterValueByIndex(i)]),
      }
    },
    /** HUD 点击循环一档：0 → max(1) → min(-1) → 0（对应游戏里双向色轴的三态） */
    cycle(id) {
      const axis = axes.find(([aid]) => aid === id)
      if (!axis) return
      const [, i, max, min] = axis
      const cur = values[id]
      values[id] = cur === 0 ? max : cur === max ? min : 0
      // 立即落笔一次，不等下一帧
      core.setParameterValueByIndex(i, values[id])
    },
    reset() {
      for (const [id, i] of axes) {
        values[id] = 0
        core.setParameterValueByIndex(i, 0)
      }
    },
  }

  // 常规动作把色轴钉回 0——每帧在动作求值后覆写为用户选色（与 ambient 层同一时序钩子）
  model.internalModel.on('afterMotionUpdate', () => {
    for (const [id, i] of axes) core.setParameterValueByIndex(i, values[id])
  })
}
