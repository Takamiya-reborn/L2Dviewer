// 联动层冒烟测试（node scripts/tests/test_listener.mjs，仓库根目录跑）
//
// 用合成 ship_l2d 条目驱动 machine.onListenerEvent / orchestrator.notice，
// 断言：kind1 相对累计 / kind2 绝对赋值 / range 钳制 / 连点下标复位 /
// apply 区间换挡 + idle_enable 名单 / type3 变体号匹配 / PLAY 通知经
// onActionApply 发射 / 真实点击链路的 PLAY 发射。DRAG_CLICK(2) 在原文是
// 死路径（EVENT_ACTION_APPLY 成功回调实参恒 nil，CT:269/305），不测且
// 断言它不再产生任何副作用。
import { DragOrchestrator } from '../../src/utils/dragmachine/index.js'
import { machinesById } from './helpers/machines.mjs'
import { stubLocalStorage } from './helpers/fakes.mjs'
import { suite } from './helpers/suite.mjs'

stubLocalStorage()

const entries = [
  { id: 1, draw_able_name: 'TouchDragA', parameter: 'p1', range: [0, 9], start_value: 0,
    listener_data: { type: 1, change: [[1, ['TouchDrag1'], 1], [2, ['TouchDrag2'], 5]] } },
  { id: 2, draw_able_name: 'TouchDragB', parameter: 'p2', range: [0, 1], start_value: 1,
    listener_data: { type: 1, change: [[1, ['TouchDrag1'], 1]] } },
  { id: 3, draw_able_name: 'TouchDragC', parameter: 'p3', range: [0, 9], start_value: 0,
    action_trigger: { type: 6, action_list: [{ action: 'a1' }, { action: 'a2' }, { action: 'a3' }] },
    listener_data: { type: 1, change: [[2, ['TouchDrag2'], 0]] } },
  { id: 4, draw_able_name: 'TouchDragD', parameter: 'p4', range: [-1, 1], start_value: 0,
    action_trigger_active: {
      idle_enable: [[0, ['act0']], [8, ['act8']], [9, ['act9']]],
      idle_ignore: [[8, ['ig8']]],
    },
    listener_data: { type: 1, change: [[1, ['TouchDrag2'], 1], [1, ['TouchDrag3'], -1]],
      apply: [1, [[-1, 0, 8], [0, 1, 0], [1, 2, 9]]] } },
  { id: 5, draw_able_name: 'TouchDragE', parameter: 'p5', range: [0, 9], start_value: 4,
    listener_data: { type: 3, change: [[2, [0], 0]] } },
  { id: 6, draw_able_name: 'TouchDragF', parameter: 'p6', range: [0, 9], start_value: 0,
    listener_data: { type: 1, change: [[1, ['touch_drag1'], 2]] } },
  { id: 7, draw_able_name: 'TouchDragG', parameter: 'p7', range: [0, 9], start_value: 0,
    action_trigger: { type: 2, action: 'touch_g' } },
  { id: 8, draw_able_name: 'TouchDrag1', parameter: 'p8', range: [0, 9], start_value: 0,
    action_trigger: { type: 2, action: 'touch_drag1' } },
]
const config = { skin_id: 0, entries, idle_index: {} }
const played = []
const orch = new DragOrchestrator(
  { internalModel: { coreModel: { getParameterIndex: () => -1 } } },
  config,
  async (clip) => {
    played.push(clip)
    return true
  },
)
orch.debugHook = () => {}

// 按条目 id 取机器（machines 序 = entries 序非 id 序，位置解构会错位）
const { 1: m1, 2: m2, 3: m3, 4: m4, 5: m5, 6: m6, 7: m7, 8: m8 } = machinesById(orch)
const { check, near, finish } = suite('listener 联动层')

// ① kind1 相对累计：+1 两次 → 2；kind2 绝对：=5（不累计）
orch.notice(1, { action: 'TouchDrag1' })
near('kind1 相对 +1 → 1', m1.parameterTargetValue, 1)
orch.notice(1, { action: 'TouchDrag1' })
near('kind1 再 +1 → 2（累计）', m1.parameterTargetValue, 2)
orch.notice(1, { action: 'TouchDrag2' })
near('kind2 绝对 =5（覆盖非累计）', m1.parameterTargetValue, 5)

// ② 钳制：m2 已在 1，再 +1 仍 1
orch.notice(1, { action: 'TouchDrag1' })
near('kind1 超上限钳回 1', m2.parameterTargetValue, 1)

// ③ 连点下标复位：type 6 机推到第 2 击后被联动命中 → 回 1
m3.actionListIndex = 2
orch.notice(1, { action: 'TouchDrag2' })
check('联动命中复位连点下标 → 1', m3.actionListIndex === 1, `实际 ${m3.actionListIndex}`)

// ④ apply 区间换挡 + idle_enable：m4 0→1 落 [1,2) → idle 9 + 名单 act9
orch.notice(1, { action: 'TouchDrag2' })
check('apply 区间 [1,2) → idle 9', orch.idleIndex === 9, `实际 idleIndex=${orch.idleIndex}`)
check('idle_enable[9] → 名单 act9', orch.enablePlayActions.join() === 'act9', `实际 [${orch.enablePlayActions}]`)
// 回 0：touchDrag2 的 kind2 已把 m1 定成 5，这里用 m4 自己的 kind1 路径
orch.notice(1, { action: 'TouchDrag3' })
near('kind1 -1 → 0 落 [0,1) → idle 0（target）', m4.parameterTargetValue, 0)
check('kind1 -1 → 0 落 [0,1) → idle 0（变体）', orch.idleIndex === 0, `实际 idleIndex=${orch.idleIndex}`)
check('idle_enable[0] → 名单 act0', orch.enablePlayActions.join() === 'act0', `实际 [${orch.enablePlayActions}]`)
// 再 -1 → -1 落 [-1,0) → idle 8 + act8 + ig8
orch.notice(1, { action: 'TouchDrag3' })
near('kind1 -1 → -1 落 [-1,0)（target）', m4.parameterTargetValue, -1)
check('kind1 -1 → -1 落 [-1,0) → idle 8', orch.idleIndex === 8, `实际 idleIndex=${orch.idleIndex}`)
check('idle_enable[8]/idle_ignore[8] 名单',
  orch.enablePlayActions.join() === 'act8' && orch.ignorePlayActions.join() === 'ig8',
  `实际 enable=[${orch.enablePlayActions}] ignore=[${orch.ignorePlayActions}]`)

// ⑤ type3 变体号匹配：idle 回 0 时 m5 清零；同值 changeIdleIndex 广播照发
orch.changeIdleIndex(0, false)
near('type3 匹配 idle 0 → target 清零', m5.parameterTargetValue, 0)
check('type3 校验名=变体号', m5.listenerData.type === 3)
m5.setTargetValue(4) // 人为改走，再用同值 changeIdleIndex 验证广播无条件发
orch.changeIdleIndex(0, false)
near('同值 changeIdleIndex 也广播（CT:1206-1224）', m5.parameterTargetValue, 0)

// ⑥ PLAY 通知经 onActionApply：type 1 监听机 +2
await orch.onActionApply(m8, 'touch_drag1', null)
near('PLAY 通知 type1 监听 +2', m6.parameterTargetValue, 2)

// ⑦ DRAG_CLICK 死路径回归：notice(2) 不产生任何副作用（冷却/联动全无）
m7.nextTriggerTime = 0
const m1Before = m1.parameterTargetValue
orch.notice(2, { draw_able_name: 'TouchDrag1' })
check('notice(2) 不再封 click_cd 冷却（原文死路径）', m7.nextTriggerTime === 0)
near('notice(2) 不再驱动 type1 联动', m1.parameterTargetValue, m1Before)

// ⑧ 真实点击链路发 PLAY：点 TouchDrag1（type 2 机）→ m6 联动 +2、
//    其他机器不被"被点分区"封冷却
let fakeNow = performance.now() / 1000
const drive = (frames) => {
  for (let i = 0; i < frames; i++) {
    fakeNow += 1 / 60
    for (const x of orch.machines) x.step(1 / 60, fakeNow, orch.isPlaying, orch.playActionName)
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0))
const m6Before = m6.parameterTargetValue
m8.onDown({ x: 0, y: 0 }, false)
m8.onUp({ x: 0, y: 0 })
drive(9)
await flush()
await flush()
near('点击链路 PLAY → type1 监听 +2', m6.parameterTargetValue, m6Before + 2)
check('点击机动作播出', played.includes('touch_drag1'), `实际 played=[${played}]`)
check('点击链路不给其他机器封 limitTime 冷却', m7.nextTriggerTime === 0)

finish()
