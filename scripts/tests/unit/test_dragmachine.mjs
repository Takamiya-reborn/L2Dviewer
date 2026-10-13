// 冒烟测试：拖拽参数机控制层（node scripts/tests/unit/test_dragmachine.mjs，在仓库根目录跑）。
// 三段合成条目驱动，覆盖：
// - 状态机：type 1（按压邻域累计）/ 2（常规点击，含 down 配置）/ 3（长按播表 + slot11 回绕松开）/ 6（连点列表）/ 8（充能档位）/ 9（点参触发）/ 12（扩展动作规则过滤门）、relation 101/103、冷却塌缩、interactable、pressLock 门控矩阵、additive 两阶段还原、localStorage 持久化、'idle' 摆位机先切变体后播、起播清滞留播放中、resetAll 契约。
// - 联动层：kind1 相对累计 / kind2 绝对赋值 / range 钳制 / 连点下标复位 / apply 区间换挡 + idle_enable 名单 / type3 变体号匹配 / PLAY 通知 / DRAG_CLICK(2) 死路径无副作用（原文 EVENT_ACTION_APPLY 成功回调实参恒 nil，CT:269/305，不测且断言不再产生副作用）。
// - 触发类型：type 5 idle 常量跟随 / type 10 动作链闩锁 / type 11 点击区间 / type 12 扩展门区间裁决。
import { DragMachine, DragOrchestrator } from '../../../src/utils/dragmachine/index.js'
import { machinesById, machineById } from '../helpers/machines.mjs'
import { stubLocalStorage, makeCoreModel, makeModel } from '../helpers/fakes.mjs'
import { suite } from '../helpers/suite.mjs'

stubLocalStorage()
const { check, near, section, finish } = suite('dragmachine 状态机 / 联动层 / 触发类型')

// ============ 状态机 ============
section('状态机')
{
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
        // 第二项 time 10：按住期不到回绕（一轮回绕会触发 slot11 松开，见 section 11 的专测），松手收尾断言才能走 last 分支
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
  // ableFlag 开窗监听：type 3 触发瞬间必须先 setMachineAble(false) 再恢复 true，否则按住屏蔽会把本机触发的动作整个拦下
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
  // 引擎 save/load 会把叠加滞留到下帧，须两阶段还原再叠加（游戏端"每帧还原参数再叠加"的等价实现），否则无动作覆盖的 additive 参数逐帧累积飞掉
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
  // 可交互判据须含档位：c1 与任一台的档位贴近才算绿（多台同名分区逐一判定）
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

  // --- 10) relation 103 开关下标对齐（shengluyisi_5 touch_drag20 同款配置）---
  // 游戏是 Lua 1-based 表 relation_value[actionListIndex]；JS 数组要 -1，否则初值取到第二档、开关整体反相
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
        // limit_time 0.05：triggerAction 拉满的冷却在游戏里靠 ON_ACTION_PLAY 塌缩回 0.2 解锁，测试不模拟播放，用小冷却等价驱动两连击
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

  // 锁是播放闸不是移动闸：锁开启时 onMove 仍路由到按压中的机器
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

  // --- 14) resetAll 契约一揽子（跨域残留全归位）---
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

  // --- 15) action='idle' 先切变体后播（wuzang_3 背景板摆位机 TouchDrag4/18）---
  // 游戏里 play("idle") 的 SetAction 与 applyActiveData 的 SetInteger("idle",8) 同帧落账，Animator 下帧统一切子状态 → 播出即新变体 clip，且游戏播放器无"重播同支循环 idle 被拒"这回事。
  // 移植端若按"先播后切"原序，playLuaAction 会因同支 clip 已在循环被引擎 reserve 拒绝而切不动变体，故 onActionApply 先 changeIdleIndex 再播，播放的是新变体 clip
  const playedBg = []
  // 播放调用时刻的变体号：先切后播的关键断言——playLuaAction 按"播放时的 idleIndex"解析变体 clip（playAction mock 收到的动作名恒为 'idle'，变体解析在其内部），变体已切 = 引擎拿到的是新变体 clip 而非在循环的同支
  const variantAtPlay = []
  const orchBg = new DragOrchestrator(
    makeModel(makeCoreModel({ bg1: { default: 0 } }), { motions: { idle: [{ File: 'motions/idle.motion3.json' }, { File: 'motions/idle8.motion3.json' }] } }),
    {
      skin_id: 'testbg',
      idle_index: { 0: 'idle', 8: 'idle8' },
      entries: [
        // 摆位机：action 恰为 "idle" 本身，active 带 idle=8（TouchDrag4 实配同款）
        { id: 31, draw_able_name: 'TouchDrag4', parameter: 'bg1', action_trigger: { type: 2, action: 'idle', target: 1 }, action_trigger_active: { idle: 8, idle_focus: 1, enable: {}, ignore: [] }, limit_time: 0, revert: -1, range: [0, 1] },
        // 孪生回程机：idle=0（TouchDrag18），idle=8 时点它切回
        { id: 32, draw_able_name: 'TouchDrag18', parameter: 'bg1', action_trigger: { type: 2, action: 'idle', target: 0 }, action_trigger_active: { idle: 0, idle_focus: 1, enable: {}, ignore: [] }, limit_time: 0, revert: -1, range: [0, 1] },
      ],
    },
    (clip) => {
      playedBg.push(clip)
      variantAtPlay.push(orchBg.idleIndex)
      return true
    },
  )
  const { 31: mBg4, 32: mBg18 } = machinesById(orchBg)
  mBg4.applyTrigger()
  check('摆位机先切后播：播放调用时变体已切到 8（playLuaAction 将解析 idle8）', variantAtPlay.at(-1) === 8, `实际 ${variantAtPlay.at(-1)}`)
  check('变体已落账 idleIndex=8', orchBg.idleIndex === 8)
  mBg18.applyTrigger()
  check('孪生回程机切回：播放调用时变体已回到 0', variantAtPlay.at(-1) === 0, `实际 ${variantAtPlay.at(-1)}`)
  check('变体回到 0', orchBg.idleIndex === 0)
  // 无 idle 组的模型（settings.motions 缺 idle）不做先切，维持原"先播后切"序
  const variantNoGroup = []
  const orchNoGroup = new DragOrchestrator(
    makeModel(makeCoreModel({ bg2: { default: 0 } }), { motions: {} }),
    {
      skin_id: 'testnogroup',
      idle_index: { 0: 'idle', 8: 'idle8' },
      entries: [
        { id: 33, draw_able_name: 'TouchDrag4', parameter: 'bg2', action_trigger: { type: 2, action: 'idle', target: 1 }, action_trigger_active: { idle: 8 }, limit_time: 0, revert: -1, range: [0, 1] },
      ],
    },
    (clip) => {
      variantNoGroup.push(orchNoGroup.idleIndex)
      return true
    },
  )
  // 无 idle 组时维持先播后切：applyActiveData 在 play 的 await 之后才入账，断言要等微任务排空（先切路径的落账是同步的，无需等）
  await machinesById(orchNoGroup)[33].applyTrigger()
  check('无 idle 组时维持先播后切（播放时变体仍 0，播后入账 8）', variantNoGroup.at(-1) === 0 && orchNoGroup.idleIndex === 8)

  // --- 16) 起播即清滞留播放中（被顶掉的反应动作不发 motionFinish 的回归）---
  // pixi 只在动作队列排空且 playing 仍真时发一次 motionFinish（index.es.js update()），被顶掉的动作不发。
  // noteMotionStart 须清旧播放态，否则 isPlaying 滞留真值 → 全机 ignore_action 拒按 + 触发处理器 l2dIsPlaying 早退
  orch.noteMotionStart('act1', false)
  check('反应动作起播置播放中', orch.isPlaying === true && orch.playActionName === 'act1')
  orch.noteMotionStart('idle1', true) // 收尾切 idle：FORCE 顶掉 act1
  check('idle 起播即清滞留播放中（松手后立即可再交互）',
    orch.isPlaying === false && orch.playActionName === '')
}

// ============ 联动层 ============
section('listener 联动层')
{
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
}

// ============ 触发类型 5/10/11/12（1 已在状态机段覆盖）============
section('触发类型 1/5/10/11/12')
{
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
  // 按条目 id 取机器（machines 序 = entries 序非 id 序，位置解构会整体错位）
  const { 1: m1, 6: m1L, 2: m5, 3: m12a, 4: m12b, 5: mP } = machinesById(orch)

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

  // --- type 1：提示判据（interactable 纯查询，供交互点提示着色）---
  // 按住型判据：干净态可响应（曾误落"未实现"null 分支导致提示层对 type 1 分区永不亮点）
  check('type1 干净态 interactable=true', m1.interactable() === true)
  m1.nextTriggerTime = 1
  check('type1 冷却中 interactable=false', m1.interactable() === false)
  m1.nextTriggerTime = 0

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

  // --- type 10/11：动作链与点击区间（独立编排器，避免与上面的冷却/闩锁状态串场）---
  // type 11 读模型实时值（EVENT_GET_PARAMETER 走 coreModel），供值直接写 core stub 的 q3
  const core2Vals = [0]
  const played2 = []
  const orch2 = new DragOrchestrator(
    {
      internalModel: {
        coreModel: {
          getParameterIndex: (pid) => (pid === 'q3' ? 0 : -1),
          getParameterValueByIndex: (i) => core2Vals[i],
        },
      },
    },
    {
      skin_id: 'tt2',
      idle_index: { 0: 'idle' },
      entries: [
        // type 10：state 名 idle9 + 变体 9，播进 95%（clip 时长 2s → 1.9s 过点）触发；limit_time 调短让闩锁语义可测（缺省 4s 冷却会把 handler 整个挡住）
        { id: 10, draw_able_name: 'T10', parameter: 'q10', limit_time: 0.1, action_trigger: { type: 10, trigger_index: 9, trigger_name: 'idle', trigger_rate: 0.95, action: 'chain_out' } },
        // type 11：点击时模型 q3 现值 ∈ [0,5) 才触发
        { id: 11, draw_able_name: 'T11', parameter: 'q11', action_trigger: { type: 11, parameter: 'q3', num: [0, 5], action: 'range_out' } },
      ],
    },
    (clip) => {
      played2.push(clip)
      return true
    },
  )
  orch2.debugHook = () => {}
  const { 10: m10, 11: m11 } = machinesById(orch2)
  let fakeNow2 = performance.now() / 1000
  const drive2 = (frames) => {
    for (let i = 0; i < frames; i++) {
      fakeNow2 += 1 / 60
      for (const m of orch2.machines) m.step(1 / 60, fakeNow2, orch2.isPlaying, orch2.playActionName)
    }
  }

  // --- type 10：state 名 + 变体号匹配，播进过 rate 触发，animationPlayApply 闩锁 ---
  orch2.playingClip = 'idle9'
  orch2.idleIndex = 9
  orch2.playStartAt = fakeNow2
  orch2.clipDurationOf = (clip) => (clip === 'idle9' ? 2 : undefined)
  drive2(115) // ~1.92s ≥ 2×0.95 过点
  check('type10 idle9 播进 95% 触发链动作', played2.includes('chain_out'))
  const chainOuts = played2.filter((c) => c === 'chain_out').length
  drive2(30)
  check('type10 命中期间闩锁不重触发', played2.filter((c) => c === 'chain_out').length === chainOuts)
  orch2.playingClip = 'idle1' // state 离开清闩锁（游戏 IsName 不匹配分支）
  drive2(2)
  check('type10 state 离开复位闩锁', m10.animationPlayApply === false)
  check('type10 纯自动触发 interactable=false（提示层不当可点计）', m10.interactable() === false)
  orch2.playingClip = 'idle9'
  orch2.playStartAt = fakeNow2
  drive2(116)
  check('type10 回到 idle9 再次过点重触发', played2.filter((c) => c === 'chain_out').length === chainOuts + 1)
  orch2.playingClip = 'idle1' // state 名不匹配（idle1 ≠ idle9）
  orch2.playStartAt = fakeNow2
  drive2(120)
  check('type10 state 不匹配不触发', played2.filter((c) => c === 'chain_out').length === chainOuts + 1)
  orch2.playingClip = 'idle9' // clip 时长查不到时跳过（不闩锁不触发）
  orch2.playStartAt = fakeNow2
  orch2.clipDurationOf = () => undefined
  drive2(120)
  check('type10 clip 时长缺失不触发', played2.filter((c) => c === 'chain_out').length === chainOuts + 1)
  orch2.clipDurationOf = (clip) => (clip === 'idle9' ? 2 : undefined)

  // --- type 11：点击时模型 q3 现值落 [0,5) 才触发，白点不滞留按压锁 ---
  // 点击窗口用的是真实钟（onDown/onUp 内 performance.now），先对齐假时钟再点击，否则确认窗按"过窗"作废
  core2Vals[0] = 6 // 区间外
  fakeNow2 = performance.now() / 1000
  m11.onDown({ x: 0, y: 0 }, false)
  drive2(2)
  m11.onUp({ x: 0, y: 0 })
  drive2(7) // 过 0.1s 确认窗
  check('type11 他参出区间不触发', !played2.includes('range_out'))
  check('type11 白点解锁按压锁', orch2.machineAble === false)
  core2Vals[0] = 3 // 区间内
  fakeNow2 = performance.now() / 1000
  m11.onDown({ x: 0, y: 0 }, false)
  drive2(2)
  m11.onUp({ x: 0, y: 0 })
  drive2(7)
  check('type11 他参入区间触发', played2.includes('range_out'))
}

finish()
