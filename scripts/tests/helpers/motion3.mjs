/**
 * motion3 曲线采样与 interaction.json clip 取值（node 侧探针通用）。
 * motion3 线段布局：0 直线 / 1 贝塞尔 / 2 贝塞尔退化(阶梯) / 3 恒值。
 */
import fs from 'fs'

export function bezier(a, b, c, d, s) {
  const u = 1 - s
  return u * u * u * a + 3 * u * u * s * b + 3 * u * s * s * c + s * s * s * d
}

export function evalBezierSegment(x0, y0, x1, y1, x2, y2, x3, y3, x) {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const s = (lo + hi) / 2
    if (bezier(x0, x1, x2, x3, s) < x) lo = s
    else hi = s
  }
  return bezier(y0, y1, y2, y3, (lo + hi) / 2)
}

/** 采样一条 motion3 Segments 曲线在 t 秒处的值 */
export function sampleCurve(segments, t) {
  let time = segments[0]
  let value = segments[1]
  for (let i = 2; i < segments.length;) {
    const type = segments[i]
    if (type === 1) {
      const t1 = segments[i + 5]
      const v1 = segments[i + 6]
      if (t <= t1) {
        return evalBezierSegment(time, value, segments[i + 1], segments[i + 2], segments[i + 3], segments[i + 4], t1, v1, t)
      }
      time = t1
      value = v1
      i += 7
    } else {
      const t1 = segments[i + 1]
      const v1 = segments[i + 2]
      if (type === 2 ? t <= t1 : type === 3 ? t < t1 : t <= t1) {
        if (type === 0 && t1 !== time) return value + ((v1 - value) * (t - time)) / (t1 - time)
        if (type === 3) return v1
        return value
      }
      time = t1
      value = v1
      i += 3
    }
  }
  return value
}

const motionCache = new Map()

/** 读 <dir>/motions/<clip>.motion3.json（带缓存） */
export function loadMotion(dir, clip) {
  const key = `${dir}/${clip}`
  if (!motionCache.has(key)) {
    motionCache.set(key, JSON.parse(fs.readFileSync(`${dir}/motions/${clip}.motion3.json`, 'utf8')))
  }
  return motionCache.get(key)
}

/** motion 在 t 时刻的 {参数id: 值}（只取 Parameter 曲线） */
export function sampleMotionAt(motion, t) {
  const out = {}
  for (const c of motion.Curves) {
    if (c.Target !== 'Parameter') continue
    out[c.Id] = sampleCurve(c.Segments, t)
  }
  return out
}

/**
 * interaction clip 的节点尾值：state/carry 的 [start, end] 取 end。
 * carry 后合并（同名参数以 carry 为准，与机器尾态一致）。
 */
export function clipNodeEnd(interaction, clipName, { state = true, carry = true } = {}) {
  const clip = interaction.clips?.[clipName]
  const out = {}
  if (!clip) return out
  if (state) for (const [pid, [, end]] of Object.entries(clip.state ?? {})) out[pid] = end
  if (carry) for (const [pid, [, end]] of Object.entries(clip.carry ?? {})) out[pid] = end
  return out
}

/** interaction clip 的衔接首值：carry 首值 + state 首值兜底（下一拍姿态用） */
export function clipCarryStart(interaction, clipName) {
  const clip = interaction.clips?.[clipName]
  const out = {}
  if (!clip) return out
  for (const [pid, [start]] of Object.entries(clip.carry ?? {})) out[pid] = start
  for (const [pid, [start]] of Object.entries(clip.state ?? {})) out[pid] ??= start
  return out
}

/**
 * 游戏应然态参数对：节点尾值(state+carry) + 变体 motion 曲线@t。
 * viewer 正确路径在特殊待机期应落在这一参数态上。
 */
export function gamePosePairs(interaction, dir, clipName, motionClip, t = 0) {
  return {
    ...clipNodeEnd(interaction, clipName),
    ...sampleMotionAt(loadMotion(dir, motionClip), t),
  }
}
