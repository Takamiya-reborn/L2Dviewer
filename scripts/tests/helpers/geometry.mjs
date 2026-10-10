/**
 * drawable 几何快照与姿态对比（node 侧探针通用）。
 * 典型用法：不同参数假设下 model.update() 后对比顶点位移，定位扭曲/错位来源。
 */

/** model.update() 后的 drawable 顶点快照：{ pos: Float32Array[], op: Float32Array } */
export function poseSnapshot(model) {
  const D = model.drawables
  const pos = []
  for (let i = 0; i < D.count; i++) pos.push(Float32Array.from(D.vertexPositions[i]))
  return { pos, op: Float32Array.from(D.opacities) }
}

/** 快照包围盒；visibleOnly 时只统计不透明度 > 0.001 的 drawable */
export function poseBBox(snapshot, { visibleOnly = false } = {}) {
  const box = {
    minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
  }
  const n = snapshot.pos.length
  for (let i = 0; i < n; i++) {
    if (visibleOnly && snapshot.op[i] <= 0.001) continue
    const vp = snapshot.pos[i]
    for (let k = 0; k < vp.length; k += 2) {
      box.minX = Math.min(box.minX, vp[k])
      box.maxX = Math.max(box.maxX, vp[k])
      box.minY = Math.min(box.minY, vp[k + 1])
      box.maxY = Math.max(box.maxY, vp[k + 1])
    }
  }
  return box
}

const f0 = (v) => v.toFixed(0)

/** 打印包围盒（全网格 + 可见部分两行） */
export function printBBox(label, model, snapshot) {
  console.log(label)
  const all = poseBBox(snapshot)
  const vis = poseBBox(snapshot, { visibleOnly: true })
  console.log(`  全部网格  x[${f0(all.minX)}, ${f0(all.maxX)}] y[${f0(all.minY)}, ${f0(all.maxY)}]`)
  console.log(`  可见部分  x[${f0(vis.minX)}, ${f0(vis.maxX)}] y[${f0(vis.minY)}, ${f0(vis.maxY)}]`)
}

/**
 * 基准 vs 候选姿态：按 drawable 顶点最大位移降序打印前 top 名。
 * 双双不可见（不透明度均 <0.001）的 drawable 跳过。
 */
export function displacementRanking(model, label, base, cand, { top = 15 } = {}) {
  const D = model.drawables
  const rows = []
  for (let i = 0; i < D.count; i++) {
    if (base.op[i] < 0.001 && cand.op[i] < 0.001) continue
    const pa = base.pos[i]
    const pb = cand.pos[i]
    let maxd = 0
    for (let k = 0; k < pa.length; k += 2) {
      const d = Math.hypot(pa[k] - pb[k], pa[k + 1] - pb[k + 1])
      if (d > maxd) maxd = d
    }
    rows.push([maxd, D.ids[i], base.op[i].toFixed(2), cand.op[i].toFixed(2)])
  }
  rows.sort((a, b) => b[0] - a[0])
  console.log(`\n==== ${label} (按顶点最大位移降序, 前 ${top})`)
  for (const [d, id, oa, ob] of rows.slice(0, top)) {
    console.log(`${d.toFixed(1).padStart(8)}  ${id}  op ${oa}->${ob}`)
  }
}
