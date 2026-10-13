/**
 * 可控单调时钟：测试中的所有时间窗口都从同一时钟读取，避免
 * performance.now、场景 dt 和异步 flush 各自走不同时间轴。
 */
export function createTestClock(startSeconds = 0) {
    let seconds = startSeconds
    const previous = globalThis.performance
    const clock = {
        nowSeconds: () => seconds,
        nowMilliseconds: () => seconds * 1000,
        advance(dt) {
            if (!Number.isFinite(dt) || dt < 0) throw new Error(`非法时间步长: ${dt}`)
            seconds += dt
            return seconds
        },
        install() {
            globalThis.performance = { now: () => seconds * 1000 }
            return clock
        },
        restore() {
            if (previous === undefined) delete globalThis.performance
            else globalThis.performance = previous
        },
    }
    return clock
}
