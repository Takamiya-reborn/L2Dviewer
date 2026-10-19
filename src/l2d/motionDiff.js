/**
 * 动作参数差分：对当前在播动作，按循环本地时间采样曲线应值，与模型实值逐条对比。
 * 用途：排查"动作在播但姿态没到位"——参数被哪一层压低（混合残留/机器叠加/视线层/物理覆盖）在 HUD 直接现形。
 * 曲线段布局与 motion3 规范一致：0 直线 / 1 贝塞尔 / 2 阶梯 / 3 逆阶梯（extract.py 产物只有 0/1/2 三种）。
 */

/** 单条曲线在 t 秒处的值（t 超出末段按末点值钳制） */
export function sampleCurve(segments, t) {
  let time = segments[0]
  let value = segments[1]
  for (let i = 2; i < segments.length;) {
    const type = segments[i]
    if (type === 1) {
      const t1 = segments[i + 5]
      const v1 = segments[i + 6]
      if (t <= t1) {
        if (t <= time) return value
        // 贝塞尔按 x 三分搜索反解 s（与 scripts/tests/helpers/motion3.mjs 同法，24 次二分到 float 精度）
        let lo = 0
        let hi = 1
        const x0 = time
        const x1 = segments[i + 1]
        const x2 = segments[i + 3]
        for (let k = 0; k < 24; k++) {
          const s = (lo + hi) / 2
          const u = 1 - s
          if (u * u * u * x0 + 3 * u * u * s * x1 + 3 * u * s * s * x2 + s * s * s * t1 < t) lo = s
          else hi = s
        }
        const s = (lo + hi) / 2
        const u = 1 - s
        const y0 = value
        const y1 = segments[i + 2]
        const y2 = segments[i + 4]
        return u * u * u * y0 + 3 * u * u * s * y1 + 3 * u * s * s * y2 + s * s * s * v1
      }
      time = t1
      value = v1
      i += 7
    } else {
      const t1 = segments[i + 1]
      const v1 = segments[i + 2]
      if (t <= t1) {
        if (type === 0 && t1 !== time) return value + ((v1 - value) * (t - time)) / (t1 - time)
        return value
      }
      time = t1
      value = v1
      i += 3
    }
  }
  return value
}

/**
 * 在 t 秒处采样整支动作的全部曲线。
 * @returns {Map<string, {target: string, v: number}>} id -> 应值（Parameter/PartOpacity）
 */
export function sampleMotionCurves(curves, t) {
  const out = new Map()
  for (const c of curves) {
    if (c.Target !== 'Parameter' && c.Target !== 'PartOpacity') continue
    out.set(c.Id, { target: c.Target, v: sampleCurve(c.Segments, t) })
  }
  return out
}

/**
 * 组装当前动作的差分行（hud.js 每帧调用）。
 * @param model pixi-live2d-display 的 Live2DModel
 * @param motionJson 在播动作的 motion3 JSON（缓存层负责取回）
 * @param t 循环本地时间（秒）
 * @param tolDev 参数差分阈值（模型参数量程 ±30 级别，1 以内视为混合/舍入噪声）
 * @returns {{rows: Array, count: number}} rows 按 |差| 降序截断，count 为全量差条数
 */
export function diffMotion(model, motionJson, t, tolDev = 1) {
  const core = model.internalModel.coreModel
  const expected = sampleMotionCurves(motionJson.Curves, t)
  // 原值直比（不钳量程）：落笔去钳位补丁后曲线原值直达内核，越界值是合法姿态（游戏同款），
  // 双侧钳制会把越界差分假性抹平
  const n = core.getParameterCount()
  const rows = []
  for (const [id, e] of expected) {
    let got
    const want = e.v
    if (e.target === 'PartOpacity') {
      got = core.getPartOpacityById(id)
    } else {
      const idx = core.getParameterIndex(id)
      got = idx >= 0 && idx < n ? core.getParameterValueByIndex(idx) : core.getParameterValueById(id)
    }
    if (got == null) continue
    const d = got - want
    if (Math.abs(d) <= (e.target === 'PartOpacity' ? 0.02 : tolDev)) continue
    rows.push({ id, target: e.target, want, got, d })
  }
  rows.sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
  return { rows, count: rows.length }
}
