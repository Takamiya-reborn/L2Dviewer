/** 探针：pixi-live2d-display 真 CubismMotion 引擎链（Framework 侧求值，非 sim 自写求值器）。
 * 在 Node 里完整构造 Cubism4InternalModel（core wasm + Framework motion 队列 + 渐变混合），
 * 按动作序列起播并采样指定参数值/指定 drawable 不透明度，用于核对"浏览器真引擎路径"与
 * 管线仿真在曲线效果上的差异。稳态一致性断言见 asset/test_engine_motion.mjs。
 * 用法: node scripts/tests/probe/engine_motion_chain.mjs <皮肤目录> <组:下标[,...]> --param <Id> --mesh <ArtMeshId>
 *   组:下标 序列示例: idle:2,touch_drag:1 —— 依次起播，每支播完自动接下支，全程按 60fps 步进采样。
 */
import fs from 'fs'
import path from 'path'
import { createEngineModel } from '../helpers/engine.mjs'

const args = process.argv.slice(2)
const dir = args[0]
const sequence = args[1].split(',').map((s) => s.split(':'))
const pick = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const paramId = pick('--param')
const meshId = pick('--mesh')

const { internal, coreModel } = await createEngineModel(dir)

const paramIndex = coreModel.getParameterIndex(paramId)
const meshIndex = coreModel.getDrawableIndex(meshId)

const t0 = performance.now()
let seqAt = 0
let current = null
const startNext = async () => {
  if (seqAt >= sequence.length) return
  const [group, index] = sequence[seqAt++]
  const file = internal.motionManager.definitions[group]?.[index]?.File ?? '?'
  current = `${group}[${index}]=${file.split('/').pop()}`
  const ok = await internal.motionManager.startMotion(group, Number(index), 3)
  console.log(`[start] t=${((performance.now() - t0) / 1000).toFixed(2)} ${current} ok=${ok}`)
}
await startNext()

const samples = []
let lastPrint = -1
// 播完整条序列（末支 isFinished）或到 20s 硬顶
for (; ;) {
  const now = performance.now() - t0
  if (now > 20000) break
  await internal.update(16.6, t0 + now)
  const c5 = coreModel.getParameterValueByIndex(paramIndex)
  const op = coreModel.getDrawableOpacity(meshIndex)
  const t = now / 1000
  samples.push([t, c5, op])
  if (t - lastPrint >= 0.1) {
    lastPrint = t
    console.log(`t=${t.toFixed(2)} ${paramId}=${c5.toFixed(3)}${meshId ? ` ${meshId}.op=${op.toFixed(3)}` : ''} motion=${current}`)
  }
  if (internal.motionManager.isFinished() && samples.length > 1) {
    if (seqAt >= sequence.length) break
    await startNext()
  }
  await new Promise((r) => setTimeout(r, 5))
}
console.log('采样总数:', samples.length)
