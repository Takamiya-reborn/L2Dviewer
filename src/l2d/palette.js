/**
 * 调色板控制层（皮肤「配色方案」机制的查看器侧）。
 *
 * 游戏链路：touch_drag8 完结 → 路由 idle8 → state 覆写 BANZI=1 → moc3 关键帧点亮 8 个 texture_01 补丁件 = 调色板面板。
 * touch_drag11/12（染一组件）与 touch_drag13/14（染另一组）是 ±1 双向色轴，Core 关键帧色经 colorPatches 落到渲染。
 * 常规动作把这 4 个色轴钉在 0（默认方案），只有 idle8 不带这些曲线——游戏在面板打开期间由控制层直写参数。
 * 查看器同样在 afterMotionUpdate（主动作求值后、coreModel.update 前）落笔，仅限在播动作曲线不驱动的轴：
 * 曲线驱动的参数由动作求值逐帧直写（忍者扫描 touch_drag13 与色轴同参），控制层复写会盖掉动作值；
 * 面板态 idle8 不驱动色轴，选色在该期间保留。
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
  const panelIdx = core.getParameterIndex(PANEL_PARAM)
  if (!axes.length || panelIdx < 0) {
    // 面板参数不存在的皮肤没有调色板功能：AXIS_IDS 是按皮肤命名的色轴参数名，其他皮肤的同名参数各有所用，不能按参数名存在就误装
    ctx.palette = null
    return
  }

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

  // 落笔跳过在播动作曲线驱动的轴：动作求值逐帧直写这些参数，控制层复写会盖掉动作值。
  // 驱动表按在播 clip 解析（attachMotions 全量预热），未预热（drivenIdxOf 返回 null）按无豁免全量落笔
  model.internalModel.on('afterMotionUpdate', () => {
    const exempt = ctx.orch ? ctx.runtime?.drivenIdxOf(ctx.orch.playingClip) : null
    for (const [id, i] of axes) {
      if (exempt?.has(i)) continue
      core.setParameterValueByIndex(i, values[id])
    }
  })
}
