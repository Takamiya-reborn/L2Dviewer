// ---- 网格级命中检测（对齐游戏 Unity CubismRaycaster 的精确判定）----
//
// Web 端库的 model.hitTest 走 CubismModel.isHit，是顶点包围盒的矩形包含
// 测试；游戏端（Unity）用 CubismRaycaster 对网格做逐三角形射线检测，判定
// 范围是网格实际多边形——凹形、镂空网格的包围盒里大片空白区域游戏点不到。
// 这里复刻后者：全局坐标经 toModelPosition 转模型空间（与库的 hitTest 同一
// 转换），再对每个命中区 drawable 逐三角形做点包含测试。
//
// 多分区同时命中时的取舍：Unity raycast 按射线距离排序，而 L2D 各 drawable
// 近似共面、距离不可分；这里按渲染序降序取（视觉最上层优先），与"点到的是
// 看得见的那个部位"的直觉和游戏表现一致。
//
// 本模块为纯几何函数，零依赖（Node 侧可直接测试）。

/** 点是否在三角形内（含边界）；退化（零面积）三角形恒返回 false */
function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  if (area === 0) return false
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

/**
 * 网格级命中检测：返回指针位置上命中的分区名（HitAreas 的 Name），按渲染
 * 序降序（视觉最上层在前）。只按网格形状与渲染序判定，不过滤不透明度、
 * 不区分手势——这两步留给调用方（firstVisibleHit / pickMachineZone），
 * 与游戏 raycast（几何检测）和 Live2dChar（业务过滤）分层一致。
 *
 * @param model pixi-live2d-display 的 Live2DModel
 * @returns {string[]} 命中分区名，未命中为空数组
 */
export function meshHitTest(model, x, y) {
  const internal = model.internalModel
  const core = internal.coreModel
  const areas = internal.hitAreas ?? {}
  const point = { x, y }
  model.toModelPosition(point, point)
  const hits = []
  for (const [name, area] of Object.entries(areas)) {
    const index = area.index
    if (index === undefined || index < 0) continue
    const positions = internal.getDrawableVertices(index)
    const indices = core.getDrawableVertexIndices(index)
    if (!positions || !indices || !indices.length) continue
    let hit = false
    for (let t = 0; t < indices.length && !hit; t += 3) {
      const a = indices[t] * 2
      const b = indices[t + 1] * 2
      const c = indices[t + 2] * 2
      hit = pointInTriangle(
        point.x, point.y,
        positions[a], positions[a + 1],
        positions[b], positions[b + 1],
        positions[c], positions[c + 1],
      )
    }
    if (hit) hits.push({ name, order: core.getDrawableRenderOrders()[index] })
  }
  hits.sort((p, q) => q.order - p.order)
  return hits.map((h) => h.name)
}

/**
 * 计算 drawable 网格的边界环（只被一个三角形使用的边连成的闭合回路），
 * 用于把真实网格形状画出来。三角形索引布局不随帧变化，拓扑结果按
 * drawable 下标缓存。非流形网格（边界顶点挂 >2 条边界边，Cubism 网格里
 * 偶见）无法连成干净回路，返回 null 由调用方退化为逐边画线段。
 *
 * @returns {number[][] | null} 环 = 顶点下标序列（首尾相接）
 */
export function boundaryLoops(indices) {
  const edgeCount = new Map()
  const key = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`)
  for (let t = 0; t < indices.length; t += 3) {
    const v = [indices[t], indices[t + 1], indices[t + 2]]
    for (let e = 0; e < 3; e++) {
      const k = key(v[e], v[(e + 1) % 3])
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1)
    }
  }
  const adjacency = new Map()
  for (const k of edgeCount.keys()) {
    if (edgeCount.get(k) !== 1) continue
    const [a, b] = k.split('_').map(Number)
    if (!adjacency.has(a)) adjacency.set(a, [])
    if (!adjacency.has(b)) adjacency.set(b, [])
    adjacency.get(a).push(b)
    adjacency.get(b).push(a)
  }
  for (const neighbors of adjacency.values()) {
    if (neighbors.length > 2) return null
  }
  const used = new Set()
  const loops = []
  for (const [start] of adjacency) {
    if (used.has(start)) continue
    const loop = [start]
    used.add(start)
    let prev = start
    let cur = adjacency.get(start)[0]
    while (cur !== start) {
      loop.push(cur)
      used.add(cur)
      const next = adjacency.get(cur).find((n) => n !== prev && !used.has(n)) ??
        adjacency.get(cur).find((n) => n !== prev)
      if (next === undefined) break
      prev = cur
      cur = next
    }
    loops.push(loop)
  }
  return loops
}
