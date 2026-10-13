// 逐帧 trace 回归：同一资产、同一场景重复运行必须得到确定性结果。
// 这是后续接入 Unity 录制数据的基础：先保证 Web 侧自身没有时钟漂移。
import fs from 'fs'
import { suite } from '../helpers/suite.mjs'
import { createPipelineSim } from '../helpers/sim.mjs'
import { diffTraces } from '../helpers/trace.mjs'

const { check, eq, finish } = suite('逐帧 trace 基础设施')
const dir = 'models/fulici/fulici_2'

if (!fs.existsSync(`${dir}/fulici_2.moc3`)) {
  console.log(`-- 缺 ${dir} 真实资产，整支跳过`)
  process.exit(0)
}

async function runScene() {
  const sim = await createPipelineSim(dir, { dt: 1 / 30 })
  await sim.playSeconds(0.5)
  const json = sim.trace.toJSON()
  sim.clock.restore()
  return json
}

const first = await runScene()
const second = await runScene()
const diffs = diffTraces(first, second, { epsilon: 0, maxDiffs: 3 })

check('trace 有逐帧参数快照', first.frames.length > 0 && Object.keys(first.frames[0].parameters).length > 0)
check('trace 记录动作边界事件', first.events.some((e) => e.type === 'motionStart'))
eq('同场景重复运行无差异', diffs, [])
eq('trace 版本稳定', first.version, 1)

finish()
