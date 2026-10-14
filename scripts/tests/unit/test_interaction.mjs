// 冒烟测试：InteractionRuntime 有向图状态机（node scripts/tests/unit/test_interaction.mjs，在仓库根目录跑）。
// fixture 复刻两条游戏内实况链路：touch_idle1（摊开菜单）→ touch_idle2（分支，起播 caidan=1）→ touch_idle3（收尾带回 0），
// 与 touch_head（持有道具 glove，默认即满足）→ touch_head2（消耗 1→0）→ touch_head3（产出 0→1）。
import { suite } from '../helpers/suite.mjs'
import { makeCoreModel, makeModel } from '../helpers/fakes.mjs'

const { check, finish } = suite('interaction 状态机')

// interaction.js 顶层 import pixi-live2d-display/cubism4，要求 Core 先在位
const { cubismCoreAvailable, loadCubismCore } = await import(
  '../helpers/cubism.mjs'
)
if (!cubismCoreAvailable()) {
  console.log('-- 缺 public/libs/live2dcubismcore.min.js，整支跳过')
  process.exit(0)
}
await loadCubismCore()
const { InteractionRuntime } = await import('../../../src/utils/interaction/index.js')

const clips = {
  // 摊开菜单：caidan 0→1，场景位移 All_X 0→2.34（连续摆位 carry）
  touch_idle1: { state: { caidan: [0, 1] }, carry: { All_X: [0, 2.34] } },
  // 菜单分支：以 caidan=1 起播——caidan 的 moc 默认是 0，干净态给不出该值，属动作曲线自驱动的姿态值而非前置，运行时不拦（门控归参数机层）
  touch_idle2: { state: { caidan: [1, 1] } },
  touch_idle2b: { state: { caidan: [1, 1] } },
  // 收尾分支：带回 0
  touch_idle3: { state: { caidan: [1, 0] }, carry: { All_X: [2.34, 0] } },
  // idle 变体：姿态预设跨循环持续
  idle1: { carry: { All_X: [0, 1] } },
  // 纯事件 clip（无 state/carry）
  touch_body: {},
  // moc 默认即满足的前置（glove 默认 1，fulici_2 Rmoxb 手感同款）：touch_head 要求持有，touch_head2 消耗（1→0），touch_head3 产出（0→1）
  touch_head: { state: { glove: [1, 1] } },
  touch_headx: {},
  touch_head2: { state: { glove: [1, 0] } },
  touch_head3: { state: { glove: [0, 1] } },
  // end-only 参数：起播恒 0（由常规复位管理，不进节点、不构成门控）
  touch_drag1: { state: { sdrtx: [0, 1] } },
  // 自指门控（wuzang_3 touch_special 同款）：以 qiu=1 起播、自身又是唯一 end=1 的动作——qiu 是连续量参数（moc 默认 0.7，氛围球），t0 打满亮只是硬设。
  // 前置不可产出（自要求自供给）→ 豁免门控，分支必须可达
  touch_special: { state: { qiu: [1, 1] } },
}
const motions = {
  idle: [{ File: 'm/idle.motion3.json' }, { File: 'm/idle1.motion3.json' }],
  touch_idle1: [{ File: 'm/touch_idle1.motion3.json' }],
  touch_idle3: [{ File: 'm/touch_idle3.motion3.json' }],
  touch_idle: [
    { File: 'm/touch_idle1.motion3.json' },
    { File: 'm/touch_idle2.motion3.json' },
  ],
  touch_body: [{ File: 'm/touch_body.motion3.json' }],
  // 组内选支用例：touch_head 要求 glove=1，touch_headx 无状态兜底
  touch_head: [
    { File: 'm/touch_head.motion3.json' },
    { File: 'm/touch_headx.motion3.json' },
  ],
  touch_head2: [{ File: 'm/touch_head2.motion3.json' }],
  touch_head3: [{ File: 'm/touch_head3.motion3.json' }],
}
// hitAreas 下标对应 opacities：0=TouchHead 可见 / 1=TouchBody 隐藏 / 2=TouchDrag3 可见
const hitAreas = { touch_head: { index: 0 }, touch_body: { index: 1 }, touch_drag3: { index: 2 } }
const opacities = [1, 0.001, 1]

const fixture = () => {
  const core = makeCoreModel(
    {
      caidan: { default: 0, min: 0, max: 1 },
      All_X: { default: 0, min: -10, max: 10 },
      sdrtx: { default: 0, min: 0, max: 1 },
      qiu: { default: 0.7, min: 0, max: 1 },
      eye: { default: 1, min: 0, max: 1 },
      glove: { default: 1, min: 0, max: 1 },
    },
    { opacities },
  )
  const model = makeModel(core, { motions, hitAreas })
  return { core, model, runtime: new InteractionRuntime(model, { clips }) }
}

// --- 1) 派生集：statePids / carryPids / gatedPids ---
{
  const { runtime } = fixture()
  check('statePids 收录 caidan（有动作以 1 起播）', runtime.statePids.has('caidan'))
  check('statePids 排除起播恒 0 的 sdrtx（end-only 走常规复位）', !runtime.statePids.has('sdrtx'))
  check('carryPids 收录 All_X', runtime.carryPids.has('All_X'))
  check(
    'preservePids = 开关 + 连续摆位，不含 end-only',
    runtime.preservePids.has('caidan') &&
    runtime.preservePids.has('All_X') &&
    !runtime.preservePids.has('sdrtx'),
  )
  check(
    'gatedPids 排除 moc 默认给不出的前置（caidan 默认 0，菜单分支门控归参数机层）',
    !runtime.gatedPids.has('caidan'),
  )
  check('gatedPids 收录默认即满足的前置（glove 默认 1，有产出方）', runtime.gatedPids.has('glove'))
  check(
    'gatedPids 排除自指产出（touch_special 要求 qiu=1 又是唯一 end=1）',
    !runtime.gatedPids.has('qiu'),
  )
  check('节点初值 = moc 默认 → isNeutral', runtime.isNeutral())
}

// --- 2) 节点跟踪：pending / 结算 / idle 立即落账 ---
{
  const { runtime } = fixture()
  runtime.trackMotionStart('touch_idle1', 0)
  check('起播先挂起、转移未落实', runtime.pending === 'touch_idle1' && runtime.node.get('caidan') === 0)
  runtime.trackMotionFinish()
  check(
    '播完落实转移（caidan=1, All_X=2.34）',
    runtime.node.get('caidan') === 1 && runtime.node.get('All_X') === 2.34,
  )
  check('转移后非中性节点', !runtime.isNeutral())

  // 被顶掉的挂起动作按"已播完"先行结算（结束值为绝对值，幂等）
  runtime.trackMotionStart('touch_idle1', 0)
  runtime.trackMotionStart('touch_body', 0)
  check('被顶掉的挂起动作先行结算（touch_idle1 的转移已落实）', runtime.pending === 'touch_body' && runtime.node.get('caidan') === 1)

  // 收尾分支带回 0
  runtime.trackMotionStart('touch_idle3', 0)
  check('收尾分支挂起', runtime.pending === 'touch_idle3')
  runtime.trackMotionFinish()
  check('收尾分支带回 0 → 节点回中性', runtime.node.get('caidan') === 0 && runtime.node.get('All_X') === 0 && runtime.isNeutral())

  // idle 变体是循环动作、永不 motionFinish，起播瞬间即落账
  runtime.trackMotionStart('idle', 1)
  check('idle 变体起播立即落账（All_X=1）', runtime.node.get('All_X') === 1 && runtime.pendingIdle === true)
}

// --- 3) canPlay 门控（查节点而非实时参数）---
{
  const { runtime } = fixture()
  check('干净态给不出的前置（caidan 默认 0）不拦分支——门控由参数机层负责', runtime.canPlay('touch_idle2') === true)
  check('end-only 参数（sdrtx 起播 0）不构成门控', runtime.canPlay('touch_drag1') === true)
  check('自指前置豁免：连续量参数 t0 硬设 1 不拦分支', runtime.canPlay('touch_special') === true)
  check('默认即满足的前置在干净态放行', runtime.canPlay('touch_head') === true)
  check('无状态 clip：无挂起时放行', runtime.canPlay('touch_body') === true)
  runtime.trackMotionStart('touch_idle1', 0)
  check('非 idle 挂起（播放中）拦下无状态 clip', runtime.canPlay('touch_body') === false)
  runtime.trackMotionStart('idle', 1)
  check('idle 挂起算等待态，无状态 clip 放行', runtime.canPlay('touch_body') === true)
  // 前置消耗/产出闭环：glove 被消耗后依赖分支拦下，产出方把节点带回后恢复可达
  runtime.trackMotionStart('touch_head2', 0)
  runtime.trackMotionFinish()
  check('前置被消耗（glove=0）→ 依赖分支不可触发', runtime.canPlay('touch_head') === false)
  runtime.trackMotionStart('touch_head3', 0)
  runtime.trackMotionFinish()
  check('前置由产出方恢复（glove=1）→ 分支恢复可达', runtime.canPlay('touch_head') === true)
}

// --- 4) firstVisibleHit：手势路由（纯几何，不过滤透明度）---
{
  const { runtime } = fixture()
  check(
    'tap 取首个非 drag 分区（隐藏网格也响应，纯几何射线）',
    runtime.firstVisibleHit(['touch_drag3', 'touch_body', 'touch_head'], 'tap') === 'touch_body',
  )
  check('drag 只取 drag 分区', runtime.firstVisibleHit(['touch_drag3', 'touch_head'], 'drag') === 'touch_drag3')
  check('隐藏网格（不透明度≈0）照样路由（游戏同款）', runtime.firstVisibleHit(['touch_body'], 'tap') === 'touch_body')
}

// --- 5) resetParameters / resetState ---
{
  const { core, runtime } = fixture()
  // 上一支动作留的残值：姿态参数 eye、end-only 参数 sdrtx
  core.setParameterValueById('eye', 0.3)
  core.setParameterValueById('sdrtx', 1)
  runtime.node.set('caidan', 1)
  runtime.node.set('All_X', 2.34)
  runtime.resetParameters()
  check('非状态机参数回 moc 默认', Math.abs(core.getParameterValueById('eye') - 1) < 1e-9)
  check('end-only 参数回 moc 默认（不留残值）', core.getParameterValueById('sdrtx') === 0)
  check('状态机参数对齐节点（caidan=1）', core.getParameterValueById('caidan') === 1)
  check('连续摆位参数对齐节点（All_X=2.34）', Math.abs(core.getParameterValueById('All_X') - 2.34) < 1e-9)

  runtime.trackMotionStart('touch_idle1', 0)
  runtime.resetState()
  check('resetState 清挂起、节点整体回默认', runtime.pending === null && runtime.isNeutral())
}

// --- 6) playHitMotion：精确命中 / 组内选支 / 全不可达 ---
{
  const { model, runtime } = fixture()
  let r = runtime.playHitMotion('touch_idle2')
  check(
    '精确命中放行 → 播 touch_idle2（干净态给不出的前置不拦）',
    r?.group === 'touch_idle' && model._played.at(-1).index === 1,
  )
  runtime.trackMotionStart('touch_idle1', 0)
  check('非 idle 挂起时无状态组不可达 → null', runtime.playHitMotion('touch_body') === null)
  // 组内选支：精确命中被前置（glove）拦下时挑组内可达分支
  runtime.trackMotionStart('touch_head2', 0)
  runtime.trackMotionFinish()
  r = runtime.playHitMotion('touch_head')
  check(
    '精确命中被前置拦下 → 组内挑可达分支（touch_headx）',
    r?.group === 'touch_head' && model._played.at(-1).index === 1,
  )
  runtime.trackMotionStart('touch_head3', 0)
  runtime.trackMotionFinish()
  r = runtime.playHitMotion('touch_head')
  check('前置恢复 → 精确命中 touch_head', r?.group === 'touch_head' && model._played.at(-1).index === 0)
  check('未收录分区 → null', runtime.playHitMotion('nonexistent') === null)
}

finish()
