// 冒烟测试：拖拽参数机（node scripts/tests/test_dragmachine.mjs，在仓库根目录跑）
import { DragMachine, DragOrchestrator } from '../../src/utils/dragmachine/index.js'
import { machinesById, machineById } from './helpers/machines.mjs'
import { stubLocalStorage, makeCoreModel, makeModel } from './helpers/fakes.mjs'
import { suite } from './helpers/suite.mjs'

// node 无 localStorage，stub 一个内存版（saveValue/loadValue 依赖）
stubLocalStorage()

const fakeModel = makeModel(makeCoreModel())
const played = []
const orch = new DragOrchestrator(
  fakeModel,
  {
    skin_id: 'test',
    idle_index: { 0: 'idle', 1: 'idle1' },
    entries: [
      // type 2 常规点击机（active_idle=1）
      { id: 1, draw_able_name: 'TouchDrag1', parameter: 'p1', action_trigger: { type: 2, action: 'act1' }, action_trigger_active: { idle: 1 }, limit_time: 0, revert: -1, range: [0, 1] },
      // type 6 连点机：3 项列表
      { id: 2, draw_able_name: 'TouchDrag14', parameter: 'p2', action_trigger: { type: 6, action_list: [{ action: 'a1' }, { action: 'a2' }, { action: 'a3' }] }, action_trigger_active: '', limit_time: 0.5, revert: -1, range: [-1, 1] },
    ],
  },
  (clip) => {
    played.push(clip)
    return true
  },
)
// 按条目 id 取机器（machines 序 = entries 序非 id 序，位置解构会错位）
const { 1: m1, 2: m6 } = machinesById(orch)
const { check, near, finish } = suite('dragmachine 状态机')

// --- 1) 冷却塌缩：noteMotionStart 无条件覆写 min(limitTime, 0.2) ---
m1.triggerAction()
check('triggerAction 后冷却=4s(默认)', m1.nextTriggerTime === 4)
check('冷却中 interactable=false', m1.interactable() === false)
orch.noteMotionStart('act1', false)
check('动作播出后冷却塌缩到 0.2', m1.nextTriggerTime === 0.2)
orch.noteMotionStart('idle1', true)
check('idle 起播同样塌缩(仍 0.2，CT:288 对一切播出生效)', m1.nextTriggerTime === 0.2)

// --- 2) interactable 各状态 ---
m1.nextTriggerTime = 0
m1.isTriggerAtion = false
orch.isPlaying = false // noteMotionStart 会置位，这里手动复位
orch.idleIndex = 0
check('基础 idle 下目标 idle=1 未豁免 → 可交互', m1.interactable() === true)
orch.idleIndex = 1
check('已在变体1时重复 idle 豁免 → 不可交互', m1.interactable() === false)
orch.idleIndex = 0
orch.isPlaying = true
check('反应播放中(focus=0) → 不可交互', m1.interactable() === false)
orch.isPlaying = false

// --- 3) type 6 连点：取列表项、推进、回卷、持久化 ---
m6.actionListIndex = 1
orch.idleIndex = 0
const run = () => {
  m6.clickTriggerTime = null
  orch.setMachineAble(false)
  m6.applyTrigger()
}
run()
check('连点第1次播 a1', played.at(-1) === 'a1')
check('下标推进到 2', m6.actionListIndex === 2)
check('limit_time=0.5 生效', m6.nextTriggerTime === 0.5)
run()
check('连点第2次播 a2', played.at(-1) === 'a2')
run()
check('连点第3次播 a3', played.at(-1) === 'a3')
check('末位回卷到 1', m6.actionListIndex === 1)
m6.saveData() // 游戏在 stopDrag 落盘，这里手动对齐
check('连点下标已持久化', orch.loadValue('2__listIndex') === 1)

// --- 4) 未实现类型 → interactable()=null；纯拖拽机 → true ---
const mPure = new DragMachine({ id: 9, draw_able_name: 'Z', parameter: 'p9', action_trigger: '' }, orch)
check('无触发机 interactable=true', mPure.interactable() === true)
const mUnknown = new DragMachine({ id: 10, draw_able_name: 'W', parameter: 'p10', action_trigger: { type: 15 } }, orch)
check('type15 未实现 interactable=null', mUnknown.interactable() === null)

// ============ wuzang_3 引入的类型：3 长按播表 / 4 双轴邻域 / 8 充能 / 9 点参 / relation ============
const params2 = { c1: 0, relx: 0 }
const fakeModel2 = {
  internalModel: {
    coreModel: {
      getParameterIndex: (p) => Object.keys(params2).indexOf(p),
      getParameterValueByIndex: (i) => Object.values(params2)[i],
      setParameterValueByIndex: (i, v) => {
        params2[Object.keys(params2)[i]] = v
      },
    },
  },
}
const played2 = []
const orch2 = new DragOrchestrator(
  fakeModel2,
  {
    skin_id: 'test2',
    idle_index: { 0: 'idle' },
    entries: [
      // type 8 充能机：delta 5 秒/单位，parts type 2 升序档位，revert_idle_index [0]
      { id: 21, draw_able_name: 'TouchDrag2', parameter: 'c1', mode: 1, action_trigger: { type: 8, delta: 5 }, parts_data: { type: 2, parts: [0, 0.21, 0.41, 0.61, 0.81, 1] }, range: [0, 1], revert: -1, revert_idle_index: [0], limit_time: 4 },
      // relation 联动机：101 跟随拖动量，mode 2 additive，offset_x 14，smooth 0.1s
      { id: 22, draw_able_name: 'TouchDrag2', parameter: '', relation_parameter: { list: [{ type: 101, name: 'relx' }] }, range: [-30, 30], offset_x: 14, mode: 2, smooth: 100 },
      // type 3 长按机：按住 0.1s 播 h1（time 取 action_list 项），last 松手收尾。
      // 第二项 time 10：按住期不到回绕（一轮回绕会触发 slot11 松开，见
      // section 11 的专测），松手收尾断言才能走 last 分支
      { id: 23, draw_able_name: 'TouchDrag2', parameter: '', action_trigger: { type: 3, last: 1, action_list: [{ action: 'h1', time: 0.1 }, { action: 'h2', time: 10 }] }, limit_time: 10 },
      // type 9 点参机：他参 c1 贴近 num（±0.05）才触发
      { id: 24, draw_able_name: 'TouchDrag3', parameter: '', action_trigger: { type: 9, parameter: 'c1', num: 0, action: 'stage0' } },
      { id: 25, draw_able_name: 'TouchDrag3', parameter: '', action_trigger: { type: 9, parameter: 'c1', num: 0.5, action: 'stage2' } },
    ],
  },
  (clip) => {
    played2.push(clip)
    return true
  },
)
const { 21: m8, 22: mRel, 23: m3, 24: m9a, 25: m9b } = machinesById(orch2)
// 机器步进用假时钟驱动（orch.step 走真实钟，同步循环里时间不走）
let fakeNow = performance.now() / 1000
const drive = (frames) => {
  for (let i = 0; i < frames; i++) {
    fakeNow += 1 / 60
    for (const m of orch2.machines) m.step(1 / 60, fakeNow, orch2.isPlaying, orch2.playActionName)
  }
}

// --- 5) 同名分区广播按下 + type 8 充能 + type 3 长按 ---
check('分区按下广播到全部同名机器', orch2.onDown('touch_drag2', { x: 0, y: 0 }) === true && orch2.machines.filter((m) => m._active).length === 3)
fakeNow = performance.now() / 1000 // 对齐机器 onDown 落下的按下时刻
// ableFlag 开窗监听：type 3 触发瞬间必须先 setMachineAble(false) 再恢复 true，
// 否则按住屏蔽会把本机触发的动作整个拦下（wuzang_3 充能姿势播不出的根因）
const ableLog = []
const origSetAble = orch2.setMachineAble.bind(orch2)
orch2.setMachineAble = (v) => {
  ableLog.push(v)
  origSetAble(v)
}
drive(7) // ~0.117s（6 帧浮点和略小于 0.1，第 7 帧过阈值）
check('type3 按住 0.1s 播 h1', played2.at(-1) === 'h1' && m3.actionListIndex === 2)
check('type3 触发瞬间 ableFlag 开窗(出现 false)', ableLog.includes(false))
check('type3 触发后 ableFlag 复位(true，按住屏蔽保持)', orch2.machineAble === true)
orch2.setMachineAble = origSetAble
check('type3 触发后清单触发标记', m3.isTriggerAtion === false)
drive(54) // 共 61 帧 ≈ 1.017s
near('type8 充能 1s ≈ 0.2 单位', m8.parameterValue, 61 / 300, 1e-6)
orch2.noteMotionStart('h1', false) // 模拟游戏 ON_ACTION_PLAY：全部机器冷却塌缩 0.2s
check('播出后冷却塌缩', m3.nextTriggerTime === 0.2)
orch2.noteMotionFinish() // 播完收尾，isPlaying 复位（否则点参机的播放中拦截会误红）

// --- 6) relation 101 跟随拖动量（additive 写模型）---
orch2.onMove({ x: 140, y: 0 }) // offsetDragX = 140/14 = 10
drive(40) // SmoothDamp 收敛
near('relation 平滑收敛到拖动量', mRel.relations[0].value, 10, 0.05)
params2.relx = 0
orch2.applyLayer(fakeModel2.internalModel.coreModel)
near('relation additive 写模型', params2.relx, 10, 0.05)
// 引擎 save/load 会把叠加滞留到下帧，须两阶段还原再叠加，否则无动作覆盖的
// additive 参数逐帧累积飞掉（游戏端"每帧还原参数再叠加"的等价实现）
const core2 = fakeModel2.internalModel.coreModel
for (let i = 0; i < 120; i++) {
  orch2.restoreLayer(core2)
  orch2.applyLayer(core2)
}
near('additive 两阶段不累积(120帧后仍=底+拖动量)', params2.relx, 10, 0.05)

// --- 7) type 3 松手收尾（last）+ 充能吸附 ---
// 松手时充能值 = (6+54+40)/300 ≈ 0.333，type 2 档位吸附到 ≤ 值的最近档 0.21
orch2.onUp('touch_drag2', { x: 0, y: 0 })
check('type3 last 松手清冷却', m3.nextTriggerTime === 0)
drive(2)
check('type3 松手收尾播末项 h2 并回卷', played2.at(-1) === 'h2' && m3.actionListIndex === 1)
near('充能机松手吸附 type2 档位(0.333 → 0.21)', m8.parameterTargetValue, 0.21)

// --- 8) type 9 点参：他参贴近才触发 ---
// 旧判据漏了档位：充能残留 c1≈0.21 时两档都不贴近，分区却画绿（绿但白点，
// 会把排查引向"点击没路由"的歧路）。修正后任一台档位贴近才绿
params2.c1 = 0.21
check('type9 两档都不贴近 → 分区红', orch2.zoneInteractable('touch_drag3') === false)
params2.c1 = 0
check('type9 分区可交互（任一台可响应即绿）', orch2.zoneInteractable('touch_drag3') === true)
params2.c1 = 0.5
check('type9 档位不贴近的机器不画绿(单机)', m9a.interactable() === false)
check('type9 档位贴近的另一台仍绿(单机)', m9b.interactable() === true)
params2.c1 = 0
m9a.applyClickTrigger() // num=0 贴合 → 触发
check('type9 num=0 贴合触发', played2.at(-1) === 'stage0')
m9b.applyClickTrigger() // num=0.5 远离 → 不触发
check('type9 num=0.5 远离不触发', played2.at(-1) === 'stage0')
params2.c1 = 0.5
m9b.applyClickTrigger()
check('type9 贴合后触发', played2.at(-1) === 'stage2')

// --- 9) 充能档位保持 + revert_idle_index 复位（回干净态再充）---
orch2.resetAll()
orch2.onDown('touch_drag2', { x: 0, y: 0 })
fakeNow = performance.now() / 1000
drive(80) // ~1.33s → 0.267
orch2.onUp('touch_drag2', { x: 0, y: 0 })
near('充过 0.21 后吸附到 0.21', m8.parameterTargetValue, 0.21)
orch2.idleIndex = 1
orch2.changeIdleIndex(0)
check('revert_idle_index [0] 变体回 0 时复位', m8.parameterTargetValue === 0 && m8.offsetDragTargetX === 0)

// --- 10) relation 103 开关下标对齐（shengluyisi_5 touch_drag20 实况复刻）---
// 游戏是 Lua 1-based 表 relation_value[actionListIndex]；JS 数组要 -1，否则
// 初值取到第二档、开关整体反相（初值显示交互一次后的图层）
const params3 = { tg20: 1 } // 1 = moc3 默认（图层默认摊开），机器初值须压回 0
const core3 = {
  getParameterIndex: (p) => (p === 'tg20' ? 0 : -1),
  getParameterValueByIndex: (i) => params3.tg20,
  setParameterValueByIndex: (i, v) => {
    params3.tg20 = v
  },
}
const orch3 = new DragOrchestrator(
  { internalModel: { coreModel: core3 } },
  {
    skin_id: 'test3',
    entries: [
      // shengluyisi_5 machine 10213441 原样：type 6 连点两项 + 103 开关自身
      { id: 31, draw_able_name: 'TouchDrag20', parameter: 'tg20', mode: 1, range: [0, 1], action_trigger: { type: 6, action_list: [{ action: 'touch_drag1' }, { action: 'touch_drag1' }] }, relation_parameter: { list: [{ name: 'tg20', mode: 1, type: 103, relation_value: [0, 1], range: [0, 1] }] } },
    ],
  },
  () => true,
)
const m31 = machineById(orch3, 31)
let now3 = performance.now() / 1000
const drive3 = (frames) => {
  for (let i = 0; i < frames; i++) {
    now3 += 1 / 60
    for (const m of orch3.machines) m.step(1 / 60, now3, false, '')
    orch3.applyLayer(core3)
  }
}
drive3(10)
check('relation103 初值 = relation_value[0]（图层收起）', params3.tg20 === 0)
m31.onDown({ x: 0, y: 0 }, now3)
m31.onUp({ x: 0, y: 0 }, now3 + 0.1)
drive3(30) // 松手 0.1s 过确认窗 + SmoothDamp 收敛
check('relation103 点一次后 = relation_value[1]（图层摊开）', params3.tg20 === 1 && m31.actionListIndex === 2)

// --- 11) slot11：type3 按住一轮回绕即松开（apply 块 wrap 分支 DD:461-467）---
const played4 = []
const orch4 = new DragOrchestrator(
  { internalModel: { coreModel: { getParameterIndex: () => -1 } } },
  {
    skin_id: 'test4',
    entries: [
      // 两项各 0.1s：按住 0.2s 走完一轮，回绕瞬间 slot11 松开拖拽。
      // limit_time 0.05：triggerAction 拉满的冷却在游戏里靠 ON_ACTION_PLAY
      // 塌缩回 0.2 解锁，测试不模拟播放，用小冷却等价驱动两连击
      { id: 41, draw_able_name: 'TW', parameter: '', action_trigger: { type: 3, last: 1, action_list: [{ action: 'w1', time: 0.1 }, { action: 'w2', time: 0.1 }] }, limit_time: 0.05 },
    ],
  },
  (clip) => {
    played4.push(clip)
    return true
  },
)
const m41 = machineById(orch4, 41)
m41.onDown({ x: 0, y: 0 }, false)
let now4 = performance.now() / 1000
for (let i = 0; i < 20; i++) {
  now4 += 1 / 60
  m41.step(1 / 60, now4, false, '')
}
check('type3 一轮播完 w1,w2 并回绕', played4.join() === 'w1,w2' && m41.actionListIndex === 1)
check('type3 回绕即松开（slot11）', m41._active === false)
const played4Len = played4.length
for (let i = 0; i < 20; i++) {
  now4 += 1 / 60
  m41.step(1 / 60, now4, false, '')
}
check('type3 松开后继续按住不再触发', played4.length === played4Len)
m41.onUp({ x: 0, y: 0 }, now4) // 已松开的机器 onUp 是 no-op，不抛异常不重复收尾
check('type3 松手不重复收尾', played4.length === played4Len && m41.actionListIndex === 1)

// --- 12) pressLock 门控矩阵（DD:1402-1411 定案）：谁按下上锁、谁不上锁 ---
const played5 = []
const orch5 = new DragOrchestrator(
  fakeModel,
  {
    skin_id: 'test5',
    idle_index: { 0: 'idle' },
    entries: [
      { id: 51, draw_able_name: 'TouchL2', parameter: 'p51', action_trigger: { type: 2, action: 'a51' } },
      // down 配置型：按下即触发，原文不上锁（checkClickAction firstActive 之外）
      { id: 52, draw_able_name: 'TouchL2d', parameter: 'p52', action_trigger: { type: 2, action: 'a52', down: 1 } },
      { id: 53, draw_able_name: 'TouchL3', parameter: '', action_trigger: { type: 3, last: 1, action_list: [{ action: 'a53', time: 10 }] } },
      { id: 54, draw_able_name: 'TouchL8', parameter: 'c54', mode: 1, action_trigger: { type: 8, delta: 5 }, range: [0, 1] },
      { id: 55, draw_able_name: 'TouchL12', parameter: '', action_trigger: { type: 12, parameter: 'q9', num: [0.01, 1] } },
      // 纯拖拽机（无触发型）：断言"锁是播放闸不是移动闸"用
      { id: 56, draw_able_name: 'TouchLm', parameter: 'pm', mode: 1, range: [0, 5], offset_x: 14 },
    ],
  },
  (clip) => {
    played5.push(clip)
    return true
  },
)
const { 51: mL2, 52: mL2d, 53: mL3, 54: mL8, 55: mL12, 56: mLm } = machinesById(orch5)
// pressLock 是按压锁唯一写入口，reason 经 debug 管线落 tapLog + debugHook
const lockLog = []
orch5.debugHook = (line) => {
  if (line.includes('按压锁')) lockLog.push(line)
}

mL2.onDown({ x: 0, y: 0 }, false)
check('type2 无 down 配置按下上锁', orch5.machineAble === true)
check('pressLock reason 留痕', lockLog.some((s) => s.includes('按下 TouchL2')), `实际 [${lockLog}]`)
const logLen = lockLog.length
orch5.pressLock('按下 TouchL2', true) // 幂等：同值早退
check('pressLock 同值幂等不重复留痕', lockLog.length === logLen)
mL2.onUp({ x: 100, y: 0 }) // 位移超 30px = 非点击松手 → 解锁
check('type2 非点击松手解锁', orch5.machineAble === false)

mL2d.onDown({ x: 0, y: 0 }, false)
check('type2 down 配置按下不上锁', orch5.machineAble === false)
check('down 配置按下即排程点击确认', mL2d.clickTriggerTime != null)
mL2d.onUp({ x: 100, y: 0 })

mL3.onDown({ x: 0, y: 0 }, false)
check('type3 按下不上锁（锁在 handler）', orch5.machineAble === false)
mL3.onUp({ x: 100, y: 0 })

mL8.onDown({ x: 0, y: 0 }, false)
check('type8 按下不上锁（锁在 handler）', orch5.machineAble === false)
mL8.onUp({ x: 100, y: 0 })

// 锁是播放闸不是移动闸：锁开启时 onMove 仍路由到按压中的机器（Step 5 删锁门的回归）
mLm.onDown({ x: 0, y: 0 }, false)
orch5.pressLock('测试上锁', true)
orch5.onMove({ x: 140, y: 0 })
near('锁开启时 onMove 仍路由（140px/14=10）', mLm.offsetDragX, 10, 0.01)
mLm.onUp({ x: 100, y: 0 })

// --- 13) 同值 changeIdleIndex 不复位机器（CT 广播无条件、DD:1355 复位有守卫）---
orch2.changeIdleIndex(1, false) // 真变化到 1：刷新机器侧记录（revert 机 1 不在名单，不复位）
m8.parameterTargetValue = 0.21 // 人为改走
orch2.changeIdleIndex(1, false) // 同值广播：复位不发生
check('同值 changeIdleIndex 不复位 revert 机', m8.parameterTargetValue === 0.21, `实际 ${m8.parameterTargetValue}`)
orch2.changeIdleIndex(0, false) // 真变化回 0：revert_idle_index [0] 复位
near('真变化回 0 才复位（第 9 节只测了这侧）', m8.parameterTargetValue, 0)

// --- 14) resetAll 契约一揽子（machine.reset 补漏的回归：跨域残留全归位）---
mL12.extendActionFlag = true
mL2.parameterTargetValue = 0.7
mL2.parameterSmoothTime = 99 // 松手路径会把平滑时间留在 smoothRevert，人为拉爆
mL2.parameterSmooth = 99
mL2.actionListIndex = 3
mL2.nextTriggerTime = 4
mL2.isTriggerAtion = true
mL2.triggerActionTime = 2
orch5.pressLock('测试上锁', true)
orch5.resetAll()
check('resetAll 清按压锁', orch5.machineAble === false)
check('resetAll 清 extendActionFlag', mL12.extendActionFlag === false)
check('resetAll 归位平滑状态（跨域残留防回归点）', mL2.parameterSmoothTime === mL2.smooth && mL2.parameterSmooth === 0)
check('resetAll 归位下标/冷却/触发标记/累计',
  mL2.actionListIndex === 1 && mL2.nextTriggerTime === 0 && mL2.isTriggerAtion === false && mL2.triggerActionTime === 0)
near('resetAll 参数回 startValue', mL2.parameterTargetValue, mL2.startValue)

finish()
