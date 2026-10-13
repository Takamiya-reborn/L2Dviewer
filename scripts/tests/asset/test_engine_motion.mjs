// 引擎链一致性回归（node scripts/tests/asset/test_engine_motion.mjs，仓库根目录跑）。
// 真 CubismMotion 引擎（Framework 求值 + 渐变混合，helpers/engine.mjs 构造）与本仓库自写 motion3
// 求值器（helpers/motion3.mjs 的 sampleMotionAt）在稳态区（fadeIn 结束后、动作收尾前）对动作曲线
// 驱动的参数必须一致——浏览器真引擎路径与 sim 管线仿真的求值差异在此钉死成绿/红。
// 对照窗口避开两处引擎合法区：物理输出参数被物理求值在动作之后覆写（按 physics3.json 的
// Destination.Id 排除）；fade 混合期 v=source+(curve-source)*w（w=easingSine 阻尼）里 w<1 的
// 区段与裸曲线不可比——引擎 fadeOut 已按生产语义归零（见 helpers/engine.mjs），只剩 fadeIn 前段，
// 采样点取 fadeIn 数倍之后即避开。
// 已知且正常的两处分歧在对照前消化：物理输出参数会被物理求值在动作之后覆写（排除）；曲线值
// 超出参数区间时引擎按区间钳制（对照值同样钳制，shengluyisi_5 的 14.7 超程曲线即此类）。
// 通用皮肤发现：models/ 下第一套带 idle 动作组的皮肤，不写皮肤名单；缺资产整支跳过。
import fs from 'fs'
import path from 'path'
import { suite } from '../helpers/suite.mjs'
import { cubismCoreAvailable } from '../helpers/cubism.mjs'
import { createEngineModel, physicsOutputIds } from '../helpers/engine.mjs'
import { sampleMotionAt } from '../helpers/motion3.mjs'

const { check, finish } = suite('真引擎 vs 自写求值器')

// models/ 下第一套带 idle 动作组的皮肤（不写皮肤名单）
function findSkin() {
  if (!fs.existsSync('models')) return null
  for (const role of fs.readdirSync('models', { withFileTypes: true })) {
    if (!role.isDirectory()) continue
    for (const skin of fs.readdirSync(path.join('models', role.name), { withFileTypes: true })) {
      if (!skin.isDirectory()) continue
      const dir = path.join('models', role.name, skin.name)
      const m3File = fs.readdirSync(dir).find((f) => f.endsWith('.model3.json'))
      if (!m3File) continue
      const json = JSON.parse(fs.readFileSync(path.join(dir, m3File), 'utf8'))
      const motions = json.FileReferences?.Motions ?? {}
      if (motions.idle?.length) return { dir, motions }
    }
  }
  return null
}

const flush = () => new Promise((r) => setTimeout(r, 0))

if (!cubismCoreAvailable()) {
  console.log('-- 缺 public/libs/live2dcubismcore.min.js，整支跳过')
  process.exit(0)
}
const skin = findSkin()
if (!skin) {
  console.log('-- 本机无带 idle 动作组的皮肤，整支跳过')
  process.exit(0)
}

console.log(`== ${skin.dir}`)
const { internal, coreModel } = await createEngineModel(skin.dir)
const skipIds = physicsOutputIds(skin.dir)

/** 起播一支动作，虚拟时钟按 60fps 步进，在稳态采样点记录引擎参数快照 */
async function playAndSample(group, index) {
  const def = internal.motionManager.definitions[group][index]
  const motionJson = JSON.parse(fs.readFileSync(path.join(skin.dir, def.File), 'utf8'))
  const fadeIn = motionJson.Meta.FadeInTime ?? def.FadeInTime ?? 1
  const duration = motionJson.Meta.Duration
  const loop = motionJson.Meta.Loop
  // 稳态采样点：fadeIn 的 1.5 倍起，隔 0.4s 一点；非循环动作顶到时长前 0.05s。
  // 采样点对齐到帧网格（f*dt 整数倍），否则与逐帧 now 的浮点比较永远差一个 ulp
  const dt = 1 / 60
  const snap = (t) => Math.round(t / dt) * dt
  const sampleTimes = [fadeIn * 1.5, fadeIn * 1.5 + 0.4, fadeIn * 1.5 + 0.8]
    .map((t) => snap(loop ? t : Math.min(t, duration - 0.05)))
    .filter((t, i, a) => a.indexOf(t) === i)

  const t0 = performance.now()
  await internal.motionManager.startMotion(group, index, 3)
  await flush()
  await flush()
  // 起播入列发生在 startMotion 之后的首次 update（动作计时从该帧 userTime 起算）：
  // 先在 t0 步进一帧让动作开表，之后第 f 帧的引擎动作时间恰为 f*dt，与曲线时刻对齐
  await internal.update(dt * 1000, t0)

  const samples = new Map()
  for (let f = 1; f * dt <= Math.max(...sampleTimes) + dt / 2; f++) {
    const now = f * dt
    await internal.update(dt * 1000, t0 + now * 1000)
    await flush()
    if (sampleTimes.includes(now)) {
      const P = coreModel.getModel().parameters
      const values = {}
      for (let i = 0; i < P.count; i++) values[P.ids[i]] = P.values[i]
      samples.set(now, values)
    }
  }
  return { motionJson, fadeIn, samples }
}

// 对照两组动作：idle 末支变体（变体比基础支信息量大）+ 首个非 idle 组的第一支
const picked = [['idle', skin.motions.idle.length - 1]]
for (const [group, defs] of Object.entries(skin.motions)) {
  if (group !== 'idle' && defs?.length) {
    picked.push([group, 0])
    break
  }
}

for (const [group, index] of picked) {
  const def = internal.motionManager.definitions[group][index]
  const label = `${group}[${index}]=${path.basename(def.File)}`
  const { motionJson, samples } = await playAndSample(group, index)

  for (const [t, values] of samples) {
    const expected = sampleMotionAt(motionJson, t)
    const diffs = []
    let compared = 0
    for (const [pid, want0] of Object.entries(expected)) {
      if (skipIds.has(pid)) continue
      const i = coreModel.getParameterIndex(pid)
      if (i < 0) continue
      const min = coreModel.getParameterMinimumValue(i)
      const max = coreModel.getParameterMaximumValue(i)
      const want = Math.min(max, Math.max(min, want0))
      compared++
      const got = values[pid]
      if (got === undefined || Math.abs(got - want) > 0.01) {
        diffs.push(`${pid}: engine=${got?.toFixed(3) ?? '无'} curve=${want.toFixed(3)}`)
      }
    }
    check(`${label}@${t.toFixed(2)}s 引擎值=曲线值（对照 ${compared} 个参数，排除物理输出 ${skipIds.size} 个）`,
      compared > 0 && diffs.length === 0, diffs.slice(0, 5).join('、'))
  }
}

finish()
