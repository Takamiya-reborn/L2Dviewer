/** node 下构造 pixi-live2d-display 真 Cubism4InternalModel 引擎链（渲染不开，renderer 仅 initialize 不进 GL）。
 * 供 asset 测试与 probe/engine_motion_chain 共用：曲线走 Framework 的 CubismMotion 求值（含渐变混合），
 * 与 sim.mjs / motion3.mjs 的自写求值器构成对照。动作文件磁盘直读，绕开 fetch/XHR 中间件。 */
import fs from 'fs'
import path from 'path'
import { loadMocModel } from './cubism.mjs'

let frameworkReady = false

/** @returns {{ internal, coreModel, settings }} */
export async function createEngineModel(dir) {
  // 先把 Core 挂到 globalThis（dist 模块顶层检查 window.Live2DCubismCore），再加载 Framework
  await loadMocModel(dir)
  const { CubismFramework, CubismMoc, Cubism4ModelSettings, Cubism4InternalModel } =
    await import('pixi-live2d-display/cubism4')
  // 走应用的加载补丁（曲线目标序归一在 createMotion 内生效），与浏览器路径一致。
  // fades 给默认表：生产路径下 fades.json 恒存在且 fadeOut 被置 0（出场由下一支动作的 fadeIn 承担），
  // 缺表时内核 fadeOut 保持 300ms，短非循环动作结尾会进入淡出冻结区，与裸曲线不可比——测试引擎须同语义
  const { installMotionPatches } = await import('../../../src/l2d/motionPatches.js')
  installMotionPatches({ fades: { default: 0.3 } })

  if (!frameworkReady) {
    CubismFramework.startUp()
    CubismFramework.initialize()
    frameworkReady = true
  }

  const settingsJson = JSON.parse(
    fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.model3.json'))), 'utf8'),
  )
  settingsJson.url = dir + '/'
  const settings = new Cubism4ModelSettings(settingsJson)
  const mocBuf = fs.readFileSync(path.join(dir, settings.moc ?? settings.FileReferences.Moc))
  const ab = mocBuf.buffer.slice(mocBuf.byteOffset, mocBuf.byteOffset + mocBuf.byteLength)
  const coreModel = CubismMoc.create(ab).createModel()

  const internal = new Cubism4InternalModel(coreModel, settings)
  // 动作文件从磁盘直读并走 createMotion 产 CubismMotion，绕开 XHR/fetch 中间件
  internal.motionManager._loadMotion = (group, index) => {
    const def = internal.motionManager.definitions[group]?.[index]
    const data = JSON.parse(fs.readFileSync(path.join(dir, def.File), 'utf8'))
    return internal.motionManager.createMotion(data, group, def)
  }
  return { internal, coreModel, settings }
}

/** 模型 json3 的 Physics 输出参数名单：物理求值在动作之后覆写这些参数，真引擎值 ≠ 曲线值属正常，对照时须排除 */
export function physicsOutputIds(dir) {
  const m3 = JSON.parse(
    fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.model3.json'))), 'utf8'),
  )
  const physicsFile = m3.FileReferences?.Physics
  if (!physicsFile) return new Set()
  const physics = JSON.parse(fs.readFileSync(path.join(dir, physicsFile), 'utf8'))
  return new Set((physics.PhysicsSettings ?? []).flatMap((s) => (s.Output ?? []).map((o) => o.Destination?.Id)))
}
