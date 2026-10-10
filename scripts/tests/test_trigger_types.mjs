// 触发类型 1/5/12 冒烟测试（node scripts/tests/test_trigger_types.mjs，仓库根目录跑）
//
// 合成 ship_l2d 条目驱动 TRIGGER_HANDLERS 新增的三型：
// - type 1 按压计时：num 邻域累计 triggerActionTime，到点触发，触发后不清零
// - type 5 idle 常量跟随：变体匹配贴 target，无按压要求
// - type 12 扩展门：参数区间裁决 ignore 拦截 / enable 直通（越按压锁），'idle' 恒放行
import { DragOrchestrator } from '../../src/utils/dragmachine/index.js'
import { machinesById } from './helpers/machines.mjs'
import { stubLocalStorage } from './helpers/fakes.mjs'
import { suite } from './helpers/suite.mjs'

stubLocalStorage()

const played = []
const orch = new DragOrchestrator(
  { internalModel: { coreModel: { getParameterIndex: () => -1 } } },
  {
    skin_id: 'tt',
    idle_index: { 0: 'idle' },
    entries: [
      // type 1：num=1（邻域 ±0.25），time=0.5s；start_value=1 让参数现值
      // 驻留邻域（step 平滑会把值拉向 target，不驻留则邻域判定恒假）
      { id: 1, draw_able_name: 'T1', parameter: 'q1', start_value: 1, action_trigger: { type: 1, num: 1, time: 0.5, action: 't1a' }, limit_time: 0.3 },
      // type 1 连发型：action_list 两项，非回绕推进不触发 slot11，按住连发
      { id: 6, draw_able_name: 'T1L', parameter: 'q6', start_value: 1, action_trigger: { type: 1, num: 1, action_list: [{ action: 'l1', time: 0.2 }, { action: 'l2', time: 0.2 }] }, limit_time: 0.05 },
      // type 5：变体 2 → target 0.7
      { id: 2, draw_able_name: 'T5', parameter: 'q2', range: [0, 1], action_trigger: { type: 5, const_fit: [{ idle: 2, target: 0.7 }] } },
      // type 12：q3 ∈ (0.01,1] 时屏蔽 sys_a（shengluyisi_5 形态复刻）
      { id: 3, draw_able_name: 'T12a', parameter: 'q3', action_trigger: { type: 12, parameter: 'q3', num: [0.01, 1] }, action_trigger_active: { enable: {}, ignore: ['sys_a'] } },
      // type 12 变体：enable 直通（越按压锁）；与 m12a 同读 q3（多扩展门
      // 各持名单是 shengluyisi_5 形态）
      { id: 4, draw_able_name: 'T12b', parameter: 'q4', action_trigger: { type: 12, parameter: 'q3', num: [0.01, 1] }, action_trigger_active: { enable: ['punch'] } },
      // 参数机：为 type 12 供值
      { id: 5, draw_able_name: 'P', parameter: 'q3', action_trigger: '' },
    ],
  },
  (clip) => {
    played.push(clip)
    return true
  },
)
orch.debugHook = () => {}
// 按条目 id 取机器（machines 序 = entries 序非 id 序，位置解构曾整体错位）
const { 1: m1, 6: m1L, 2: m5, 3: m12a, 4: m12b, 5: mP } = machinesById(orch)

let fail = 0
const { check, finish } = suite('trigger types 1/5/12')
let fakeNow = performance.now() / 1000
const drive = (frames) => {
  for (let i = 0; i < frames; i++) {
    fakeNow += 1 / 60
    for (const m of orch.machines) m.step(1 / 60, fakeNow, orch.isPlaying, orch.playActionName)
  }
}

// --- type 1：按压 + 邻域累计 ---
m1.onDown({ x: 0, y: 0 }, false) // 现值=start_value=1，邻域内（|1-1|=0 < 0.25）
fakeNow = performance.now() / 1000
drive(33) // ~0.55s → 触发（30 帧的浮点和略小于 0.5，留余量）
check('type1 按住 0.5s 触发', played.at(-1) === 't1a')
check('type1 触发后计时不清零', m1.triggerActionTime > 0.5)
// slot11（DD:443-444）：单 action 触发即松开，按住不再重复
check('type1 单 action 触发即松开', m1._active === false)
const t1count = played.filter((c) => c === 't1a').length
drive(30)
check('type1 松开后按住不再触发', played.filter((c) => c === 't1a').length === t1count)
m1.onUp({ x: 0, y: 0 })

// --- type 1 连发型：action_list 非回绕推进不松开，按住连发到回绕 ---
m1L.onDown({ x: 0, y: 0 }, false)
drive(90) // 1.5s：l1@0.2s → l2@~0.25s（冷却 0.05 解锁）→ 回绕松开
check('type1 连发走完 action_list 并回绕松开', played.includes('l1') && played.includes('l2') && m1L.actionListIndex === 1 && m1L._active === false)
m1L.onUp({ x: 0, y: 0 })
// 离开邻域：值与目标双置 5（step 会把现值拉向 target，只改现值会被拉回）
m1.setParameterValue(5)
m1.setTargetValue(5)
const t1time = m1.triggerActionTime
drive(30)
check('type1 离开邻域不累计不清零', Math.abs(m1.triggerActionTime - t1time) < 1e-9)
m1.onUp({ x: 0, y: 0 })

// --- type 1：播放中抑制 ---
m1.setParameterValue(1)
m1.setTargetValue(1)
m1.triggerActionTime = 0.49
m1.onDown({ x: 0, y: 0 }, false)
orch.isPlaying = true
const t1plays = played.filter((c) => c === 't1a').length
drive(3) // 过 0.5s 但 playing → 不触发
check('type1 播放中不触发', played.filter((c) => c === 't1a').length === t1plays)
orch.isPlaying = false
m1.onUp({ x: 0, y: 0 })

// --- type 5：变体匹配贴值，无按压要求 ---
orch.idleIndex = 1
drive(3)
check('type5 变体不匹配不动', m5.parameterTargetValue === 0)
orch.idleIndex = 2
drive(2)
check('type5 变体匹配 → target 贴 0.7', m5.parameterTargetValue === 0.7 && m5.parameterValue === 0.7)
orch.isPlaying = true
m5.setTargetValue(0)
drive(2)
check('type5 播放中不贴值', m5.parameterTargetValue === 0)
orch.isPlaying = false
orch.idleIndex = 0

// --- type 12：区间裁决（shengluyisi_5 形态）---
drive(1) // type 12 handler 置位 extendActionFlag
check('type12 置位 extendActionFlag', m12a.extendActionFlag === true && m12b.extendActionFlag === true)
mP.parameterValue = 0.5 // q3 ∈ (0.01,1]
check('type12 区间内 ignore 拦截', orch.checkEnablePlay('sys_a') === false)
check('type12 区间内非名单动作不表态', orch.checkEnablePlay('other_act') === true)
mP.parameterValue = 0 // q3 出区间
check('type12 区间外不拦截', orch.checkEnablePlay('sys_a') === true)
mP.parameterValue = 0.5
// readDragParameter 直测：按参数名读他机现值，多台同名时最后一台胜出，无台缺省 0
// （q3 只有 mP 一台带名 → 读它；q6 只在 m1L 上）
check('readDragParameter 按名读他机现值', orch.readDragParameter('q3') === 0.5 && orch.readDragParameter('q6') === 1)
check('readDragParameter 未知名缺省 0', orch.readDragParameter('nope') === 0)
// enable 直通越锁：m12b 的 enable ['punch'] 在按压锁开启时仍放行
orch.pressLock('测试上锁', true)
check('type12 enable 直通越按压锁', orch.checkEnablePlay('punch') === true)
check('type12 锁内非直通动作仍被拦', orch.checkEnablePlay('sys_a') === false && orch.checkEnablePlay('other_act') === false)
orch.pressLock('测试解锁', false)
check("type12 不拦 'idle'（门前置让位）", orch.checkEnablePlay('idle') === true)

// --- type 12：reset 清 extendsActionFlag ---
orch.resetAll()
check('resetAll 清 extendActionFlag', m12a.extendActionFlag === false && m12b.extendActionFlag === false)
check('resetAll 后拦截失效', orch.checkEnablePlay('sys_a') === true)

finish()
