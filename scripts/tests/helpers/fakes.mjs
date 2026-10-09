/**
 * 假模型工厂：node 下给 InteractionRuntime / loadAmbient 等当模型桩。
 * 只实现各运行时实际调用的 coreModel 接口；参数下标 = 声明顺序。
 */

/**
 * 假 Cubism coreModel。
 * @param params 参数表 { 参数id: { default, min, max, value? } }
 * @param opts.opacities drawable 不透明度表（给定时附加 getDrawableOpacity，
 *        InteractionRuntime.firstVisibleHit 的可见性过滤用）
 */
export function makeCoreModel(params = {}, { opacities = null } = {}) {
  const ids = Object.keys(params)
  const values = ids.map((id) => params[id].value ?? params[id].default)
  const core = {
    _ids: ids,
    _values: values,
    getParameterCount: () => ids.length,
    getParameterIndex: (id) => ids.indexOf(id),
    getParameterDefaultValue: (i) => params[ids[i]]?.default ?? 0,
    getParameterMinimumValue: (i) => params[ids[i]]?.min ?? 0,
    getParameterMaximumValue: (i) => params[ids[i]]?.max ?? 1,
    getParameterValueByIndex: (i) => values[i],
    getParameterValueById: (id) => {
      const i = ids.indexOf(id)
      return i < 0 ? 0 : values[i]
    },
    setParameterValueByIndex: (i, v) => {
      values[i] = v
    },
    setParameterValueById: (id, v) => {
      const i = ids.indexOf(id)
      if (i >= 0) values[i] = v
    },
  }
  if (opacities) core.getDrawableOpacity = (i) => opacities[i] ?? 0
  return core
}

/**
 * 假 pixi Live2DModel：internalModel 各字段 + motion 调用记录（_played，
 * { group, index, priority } 数组）。
 */
export function makeModel(
  core,
  { motions = {}, hitAreas = {}, idleGroup = 'idle' } = {},
) {
  return {
    _played: [],
    internalModel: {
      coreModel: core,
      settings: { motions },
      hitAreas,
      motionManager: { groups: { idle: idleGroup }, on() {} },
    },
    motion(group, index, priority) {
      this._played.push({ group, index, priority })
    },
  }
}
