/**
 * 逐帧 trace 记录与差异定位。trace 是测试产物，不依赖浏览器或测试框架，
 * 可直接 JSON.stringify 保存为 Unity/Web 对照样本。
 */
export function createTrace({ parameterIds = [], maxFrames = 60000 } = {}) {
    const frames = []
    const events = []

    return {
        frames,
        events,
        event(type, data = {}) {
            events.push({ type, ...data })
        },
        frame({ time, dt, active, runtime, orch, values }) {
            if (frames.length >= maxFrames) return
            frames.push({
                frame: frames.length,
                time: Number(time.toFixed(6)),
                dt: Number(dt.toFixed(6)),
                motion: active
                    ? {
                        group: active.group,
                        index: active.index,
                        clip: active.clip,
                        t: Number(active.t.toFixed(6)),
                    }
                    : null,
                interaction: {
                    pending: runtime?.pending ?? null,
                    pendingIdle: runtime?.pendingIdle ?? false,
                    neutral: runtime?.isNeutral?.() ?? true,
                },
                machines: orch
                    ? {
                        idleIndex: orch.idleIndex,
                        playing: orch.isPlaying,
                        playingClip: orch.playingClip,
                        able: orch.machineAble,
                    }
                    : null,
                parameters: Object.fromEntries(
                    parameterIds.map((id, i) => [id, Number(values[i].toFixed(6))]),
                ),
            })
        },
        toJSON() {
            return { version: 1, frames, events }
        },
    }
}

export function diffTraces(actual, expected, { epsilon = 1e-5, maxDiffs = 20 } = {}) {
    const diffs = []
    const frameCount = Math.max(actual.frames.length, expected.frames.length)
    for (let i = 0; i < frameCount && diffs.length < maxDiffs; i++) {
        const a = actual.frames[i]
        const e = expected.frames[i]
        if (!a || !e) {
            diffs.push({ frame: i, field: 'frame', actual: a ?? null, expected: e ?? null })
            continue
        }
        if (a.motion?.clip !== e.motion?.clip) {
            diffs.push({ frame: i, field: 'motion.clip', actual: a.motion?.clip ?? null, expected: e.motion?.clip ?? null })
        }
        for (const id of new Set([...Object.keys(a.parameters), ...Object.keys(e.parameters)])) {
            const av = a.parameters[id]
            const ev = e.parameters[id]
            if (typeof av !== 'number' || typeof ev !== 'number' || Math.abs(av - ev) > epsilon) {
                diffs.push({ frame: i, field: `parameters.${id}`, actual: av, expected: ev })
                if (diffs.length >= maxDiffs) break
            }
        }
    }
    return diffs
}
