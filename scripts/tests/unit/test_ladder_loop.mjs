// 回归测试：梯子两圈链路（node scripts/tests/unit/test_ladder_loop.mjs，仓库根目录跑）。
// 合成配置复刻游戏梯子结构（shengluyisi_5 实测定案）：type 2 点击机链条，每步 active
// 白名单放行下 1-2 步的动作，末台 active 与首台同构 = 数据上环闭合。断言每击都播出
// 动作、白名单外的死点拒播、第二圈环回起点不断链。
// 触发链时序与真机装配同款驱动：onUp 的点击确认窗用真实钟、动作播出冷却塌缩、
// 播完 force 重播 'idle'。
import { DragOrchestrator } from '../../../src/utils/dragmachine/index.js'
import { machinesById } from '../helpers/machines.mjs'
import { stubLocalStorage, makeCoreModel, makeModel } from '../helpers/fakes.mjs'
import { suite } from '../helpers/suite.mjs'

stubLocalStorage()

// 梯子各步：条目 id / 动作 / active.idle 变体号
const STEPS = [
  [1, 'touch_idle1', 1],
  [4, 'touch_idle4', 3],
  [7, 'touch_idle7', 5],
  [10, 'touch_idle10', 7],
  [13, 'touch_idle13', 9],
  [16, 'touch_idle16', 11],
]
const LOOP = [19, 'touch_idle19', 1]
// 每步白名单放行下 1-2 步的动作，链尾放行环台
const enablesOf = (i) => STEPS.slice(i + 1, i + 3).map(([, a]) => a).concat(STEPS[i + 2] ? [] : [LOOP[1]])
const entry = (id, action, active) => ({
  id,
  draw_able_name: `TouchDrag${id}`,
  parameter: `p${id}`,
  action_trigger: { type: 2, action },
  action_trigger_active: active,
  limit_time: 0,
  revert: -1,
  range: [0, 1],
})
const entries = [
  ...STEPS.map(([id, action, idle], i) => entry(id, action, { idle, enable: enablesOf(i) })),
  // 环台：active 与首台完全同构（idle=1 + 放行其后两步）= 数据上环闭合
  entry(LOOP[0], LOOP[1], { idle: LOOP[2], enable: enablesOf(0) }),
  // 环外死点：动作不在任何名单里，白名单生效期间拒播
  entry(99, 'touch_idle99', null),
]

const played = []
const orch = new DragOrchestrator(
  makeModel(makeCoreModel()),
  { skin_id: 'ladder_test', entries },
  (clip) => {
    // 白名单前置检查与舞台侧 playLuaAction 同款（游戏 checkEnablePlay 对一切播放生效）
    if (!orch.checkEnablePlay(clip)) return false
    played.push(clip)
    return true
  },
)
orch.debugHook = () => {}

const byId = machinesById(orch)
// 两圈链路：第一圈全链，第二圈只验环回起点（自环台起前进路径与首台相同）
const LAP = [1, 4, 7, 10, 13, 16, 19]

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
  const m = byId[id]
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

const { check, finish } = suite('梯子两圈环回（合成配置）')

check(await click(1), `点击 ${byId[1].drawAbleName} 触发动作`)
// 死点探针：首步白名单只放行 touch_idle4/7，环外动作拒播（失败不塌缩，游戏同款语义）
const beforeProbe = played.filter((c) => c !== 'idle').length
check(!(await click(99)), '白名单外死点拒播')
check(played.filter((c) => c !== 'idle').length === beforeProbe, '死点未播出动作')
for (const id of LAP.slice(1)) {
  check(await click(id), `点击 ${byId[id].drawAbleName} 触发动作`)
}

console.log('played 序列:', played.join(' → '))
check(await click(4), '第二圈环回起点复播动作')
check(played.filter((c) => c === 'touch_idle4').length === 2, '第二圈复播 touch_idle4（环回成功）')

finish()
