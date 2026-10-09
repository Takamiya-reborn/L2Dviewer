/**
 * 常驻氛围层：effect 组是游戏内永远循环播放的叠加动画（垂发、扶手布等微风
 * 摆动），只驱动其他动作与物理都不触碰的参数，因此可在任意动作之上直写参数。
 * pixi-live2d-display 的动作队列一次只能播一支动作，无法天然叠加两支，
 * 这里按 motion3.json 曲线逐帧采样后直写参数，与游戏内观感一致。
 * 注意：若某套皮肤的其他动作也驱动这些参数，会与本层互相覆盖——目前各套
 * 皮肤的 effect 参数均为独占参数，不冲突。
 */

/** 三次贝塞尔 B(s)，用于 motion3 贝塞尔段求值 */
function bezier(a, b, c, d, s) {
  const u = 1 - s
  return u * u * u * a + 3 * u * u * s * b + 3 * u * s * s * c + s * s * s * d
}

/**
 * 贝塞尔段在时间 x 处的值：段曲线是 (时间, 值) 平面的三次贝塞尔，二分求
 * x(s)=x 的 s 再取 y(s)（段内时间单调，二分恒收敛；24 次达 float 精度）。
 */
function evalBezierSegment(x0, y0, x1, y1, x2, y2, x3, y3, x) {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const s = (lo + hi) / 2
    if (bezier(x0, x1, x2, x3, s) < x) lo = s
    else hi = s
  }
  return bezier(y0, y1, y2, y3, (lo + hi) / 2)
}

/**
 * 按_segments_（motion3 单条曲线的 Segments 数组）求 t 时刻的值。
 * 段类型：0 线性 / 1 贝塞尔 / 2 阶跃 / 3 反阶跃。
 */
function sampleCurve(segments, t) {
  let time = segments[0]
  let value = segments[1]
  for (let i = 2; i < segments.length;) {
    const type = segments[i]
    if (type === 1) {
      const t1 = segments[i + 5]
      const v1 = segments[i + 6]
      if (t <= t1) {
        return evalBezierSegment(
          time, value,
          segments[i + 1], segments[i + 2],
          segments[i + 3], segments[i + 4],
          t1, v1, t,
        )
      }
      time = t1
      value = v1
      i += 7
    } else {
      const t1 = segments[i + 1]
      const v1 = segments[i + 2]
      if (type === 2 ? t <= t1 : type === 3 ? t < t1 : t <= t1) {
        // 线性段按段内比例插值（现有三套皮肤的 effect 曲线只用贝塞尔/阶跃段，
        // 此分支暂无实况覆盖）；阶跃保持旧值；反阶跃取段末值
        if (type === 0) return t1 === time ? v1 : value + ((v1 - value) * (t - time)) / (t1 - time)
        return type === 3 ? v1 : value
      }
      time = t1
      value = v1
      i += 3
    }
  }
  return value
}

/**
 * 从模型加载 effect 组（取 model3.json 中该组的第一个动作）。
 * Meta.Loop 为 false 但游戏内靠外部循环连播，这里同样由 apply 的时间取模循环。
 * 模型没有 effect 组时返回 null（调用方跳过）。
 */
export async function loadAmbient(modelUrl, settings) {
  const file = settings.motions?.effect?.[0]?.File
  if (!file) return null
  // modelUrl 可能是站内绝对路径（"/models/..."），需先经 location 解析为绝对 URL
  const data = await (await fetch(new URL(file, new URL(modelUrl, window.location.href)))).json()
  const duration = data.Meta?.Duration
  const curves = (data.Curves ?? []).filter((c) => c.Target === 'Parameter')
  if (!duration || !curves.length) return null
  // 参数绑定（惰性，首次 apply 时解析）：下标 + moc 的 [min, max] 范围
  let bindings = null
  return {
    /** seconds 取任意单调时钟；取模后每帧写入，效果与游戏内连播一致。
     *  写入前按 moc 的 [min, max] 收敛：游戏端 Unity/Cubism Framework 会把
     *  参数写入钳制到参数范围，核心层直写不会——部分皮肤的 effect 曲线超程
     *  （shengluyisi_5 的 Param90/92 曲线达 14.7，参数范围 [0,2]），超程值
     *  放大形变，且幅度随加载时刻的采样相位（performance.now 取模）变化，
     *  把 fitModel 的场景测量甩出逐次不同的偏差——自由摆位皮肤表现为
     *  "每次刷新位置/大小随机"。 */
    apply(coreModel, seconds) {
      if (!bindings) {
        bindings = curves
          .map((curve) => {
            const index = coreModel.getParameterIndex(curve.Id)
            if (index < 0 || index >= coreModel.getParameterCount()) return null
            return {
              index,
              segments: curve.Segments,
              min: coreModel.getParameterMinimumValue(index),
              max: coreModel.getParameterMaximumValue(index),
            }
          })
          .filter(Boolean)
      }
      const t = seconds % duration
      for (const b of bindings) {
        let value = sampleCurve(b.segments, t)
        if (value < b.min) value = b.min
        else if (value > b.max) value = b.max
        coreModel.setParameterValueByIndex(b.index, value)
      }
    },
  }
}
