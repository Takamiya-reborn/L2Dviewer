// 回归测试：shengluyisi_5 梯子两圈链路（node scripts/tests/test_ladder_loop.mjs，仓库根目录跑）
//
// 游戏内链路：drag1 → drag3:4 → … → drag13:19 →(环回)→ drag3:4。
// 用真实 l2d.json + 真机器代码驱动两圈，断言每次点击都触发动作、
// 第二圈起点（drag13:19 → drag3:4）不断链。
import { readFileSync } from 'node:fs'
import { DragOrchestrator } from '../../src/utils/dragmachine/index.js'
import { stubLocalStorage } from './helpers/fakes.mjs'
import { suite } from './helpers/suite.mjs'

stubLocalStorage()

const config = JSON.parse(
  readFileSync(new URL('../../models/shengluyisi/shengluyisi_5/shengluyisi_5.l2d.json', import.meta.url), 'utf8'),
)
const fakeModel = { internalModel: { coreModel: { getParameterIndex: () => -1 } } }
const played = []
const orch = new DragOrchestrator(
  fakeModel,
  config,
  (clip) => {
    played.push(clip)
    return true
  },
)
orch.debugHook = () => {}

const byId = new Map(orch.machines.map((m) => [m.id, m]))
// 用户链路（标签 -> 机器）：drag1=#01, drag3:4=#04, drag5:7=#07, drag7:10=#10,
// drag9:13=#13, drag11:16=#16, drag13:19=#19
const LAP = [10213401, 10213404, 10213407, 10213410, 10213413, 10213416, 10213419]

let fakeNow = performance.now() / 1000
const drive = (frames) => {
  for (let i = 0; i < frames; i++) {
    fakeNow += 1 / 60
    for (const m of orch.machines) m.step(1 / 60, fakeNow, orch.isPlaying, orch.playActionName)
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

// 每次点击后应播出一个非 idle 动作；返回是否触发
async function click(id) {
  const m = byId.get(id)
  fakeNow = performance.now() / 1000 // onUp 的确认窗用真实钟，假钟须对齐
  const before = played.filter((c) => c !== 'idle').length
  m.onDown({ x: 0, y: 0 }, false)
  m.onUp({ x: 0, y: 0 })
  drive(9) // 过 0.1s 确认窗（0.15s 处于窗内）
  await flush()
  await flush()
  if (played.filter((c) => c !== 'idle').length === before) return false
  // 模拟挂载层：动作真播 -> ON_ACTION_PLAY（冷却塌缩）-> 播完 finish
  orch.noteMotionStart(played.at(-1), false)
  drive(3)
  orch.noteMotionFinish() // 内部会 force 重播 'idle'（记进 played）
  drive(20) // 0.33s：清 0.2 冷却、清单触发标记
  await flush()
  return true
}

const { check, finish } = suite('shengluyisi_5 梯子两圈')

for (const lap of [1, 2]) {
  const ids = lap === 1 ? LAP : [10213404] // 第二圈只需验证环回起点 drag13:19 → drag3:4
  for (const id of ids) {
    const ok = await click(id)
    check(ok, `第${lap}圈 点击 ${byId.get(id).drawAbleName} 触发动作`)
  }
}

console.log('played 序列:', played.join(' → '))
check(
  played.filter((c) => c === 'touch_idle4').length === 2,
  '第二圈 drag3:4 复播 touch_idle4（环回成功）',
)

finish()
