/**
 * 参数覆盖层（HUD 注入测试用）：beforeModelUpdate 阶段把指定参数钉到手动值，
 * 压过动作/物理/机器/视线全部层。泛化工具，不内置任何模型专属参数表。
 * 注意 moc3 v5 + Core 5.1 的分支吸附：参数值发生一次变化后，绑定网格可能永久切入
 * 另一关键形态分支，把值复位也不解吸——对照两分支姿态需重挂模型。
 */

/** @returns {{entries: Map<string, {value: number, on: boolean}>, set, toggle, remove, apply}} */
export function createParamOverride() {
  const entries = new Map()
  return {
    entries,
    set(id, value) {
      const e = entries.get(id) ?? { value: 0, on: true }
      e.value = value
      entries.set(id, e)
    },
    toggle(id, on) {
      const e = entries.get(id)
      if (e) e.on = on
    },
    remove(id) {
      entries.delete(id)
    },
    apply(coreModel) {
      for (const [id, e] of entries) {
        if (e.on) coreModel.setParameterValueById(id, e.value)
      }
    },
  }
}
