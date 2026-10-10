/**
 * 按条目 id 查机器。orch.machines 的顺序 = entries 数组顺序，**不是 id 序**——
 * entries 中部插条目后按位置解构会整体错位（test_trigger_types 曾因此 6 项假失败），
 * 一律用这里按 id 取，杜绝这类坑。
 */

/** { [entries.id]: machine } 映射；重复 id 直接抛（配置错误早暴露） */
export function machinesById(orch) {
  const byId = {}
  for (const m of orch.machines) {
    if (m.id in byId) throw new Error(`machine id=${m.id} 重复`)
    byId[m.id] = m
  }
  return byId
}

/** 单台机器，缺失直接 throw（比拿到 undefined 更早暴露） */
export function machineById(orch, id) {
  const m = orch.machines.find((x) => x.id === id)
  if (!m) throw new Error(`machine id=${id} 不存在（entries 里没配？）`)
  return m
}
