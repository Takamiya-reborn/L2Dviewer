// 冒烟测试：渲染参数层三件（node scripts/tests/unit/test_render.mjs，在仓库根目录跑）。
// - palette：调色板落笔豁免——在播动作曲线驱动的色轴不落笔（动作求值逐帧直写该参数，控制层复写会盖掉动作值——
//   忍者扫描 touch_drag13 与色轴同参），未驱动的轴照常覆写为选色（面板态选色保留语义）。合成 stub，不依赖真模型。
// - ambient：effect 组 motion3 曲线采样与参数直写，fetch 打桩供 loadAmbient 取 fixture；段类型全覆盖（线性/贝塞尔/阶跃/反阶跃）+ 范围钳制 + 时长取模循环。
// - motion_curves：曲线目标序归一——内核求值循环按 Model→Parameter→PartOpacity 顺序遍历、遇类型切换即停，
//   混排曲线会让其后同型曲线整体失去求值，加载层归一必须把任何混排修成分组序（需 Cubism Core，缺则该段跳过）。
import { suite } from '../helpers/suite.mjs'
import { makeCoreModel } from '../helpers/fakes.mjs'
import { cubismCoreAvailable } from '../helpers/cubism.mjs'

const { check, eq, section, finish } = suite('palette / ambient / motion_curves')

// ============ palette ============
section('调色板落笔豁免')
{
  const { installPalette } = await import('../../../src/l2d/palette.js')

  const IDS = ['touch_drag11', 'touch_drag12', 'touch_drag13', 'touch_drag14', 'BANZI']
  const idx = new Map(IDS.map((id, i) => [id, i]))
  const values = new Float32Array(IDS.length)

  const core = {
    getParameterIndex: (id) => idx.get(id) ?? -1,
    getParameterValueByIndex: (i) => values[i],
    setParameterValueByIndex: (i, v) => {
      values[i] = v
    },
    getParameterMaximumValue: () => 1,
    getParameterMinimumValue: () => -1,
  }
  let hook = null
  const model = {
    internalModel: {
      coreModel: core,
      on: (ev, fn) => {
        if (ev === 'afterMotionUpdate') hook = fn
      },
    },
  }

  // 在播 clip=idle9 驱动 touch_drag13（下标 2）；驱动表为合成映射
  const driven = new Set([2])
  const ctx = {
    orch: { playingClip: 'idle9' },
    runtime: { drivenIdxOf: (clip) => (clip === 'idle9' ? driven : null) },
  }
  installPalette(ctx, model)

  check('挂载后登记 palette 上下文与落笔钩子', !!ctx.palette && typeof hook === 'function')

  // 动作求值直写扫描值（模拟引擎曲线写 touch_drag13=6.5），随后调色板钩子落笔
  values[2] = 6.5
  ctx.palette.values.touch_drag12 = 1
  hook()

  eq('被驱动的轴不被覆写（扫描值得以保留）', values[2], 6.5)
  eq('未驱动的轴写回选色', values[1], 1)
  eq('未选色的轴写回默认 0', values[0], 0)

  // 面板态（idle8 不驱动色轴）：驱动表未命中 → 全量落笔
  ctx.orch.playingClip = 'idle8'
  hook()
  eq('面板态选色保留落笔', values[1], 1)
  eq('面板态扫描轴归选色值', values[2], 0)

  // 无编排器（ctx.orch 缺失）：按无豁免全量落笔，层不失效
  ctx.orch = null
  values[2] = 3
  hook()
  eq('无编排器时全量落笔', values[2], 0)

  // 面板参数（BANZI）不存在的皮肤：整层旁路，色轴同名参数各有所用不得误装（baifeng_2 的 touch_drag13 是扫描计数器）
  const core2 = {
    getParameterIndex: (id) => (IDS.includes(id) && id !== 'BANZI' ? IDS.indexOf(id) : -1),
    getParameterValueByIndex: () => 0,
    setParameterValueByIndex: () => {},
    getParameterMaximumValue: () => 1,
    getParameterMinimumValue: () => -1,
  }
  let hook2 = null
  const ctx2 = {
    orch: { playingClip: '' },
    runtime: { drivenIdxOf: () => null },
  }
  installPalette(ctx2, {
    internalModel: {
      coreModel: core2,
      on: (ev, fn) => {
        if (ev === 'afterMotionUpdate') hook2 = fn
      },
    },
  })
  check('无面板参数的皮肤整层旁路', ctx2.palette === null && hook2 === null)
}

// ============ ambient ============
section('effect 氛围层曲线采样')
{
  const { loadAmbient } = await import('../../../src/utils/ambient.js')

  globalThis.window = { location: { href: 'http://localhost/' } }

  const motion3 = {
    Meta: { Duration: 2 },
    Curves: [
      { Target: 'Parameter', Id: 'AmbLin', Segments: [0, 0, 0, 1, 1] },
      // 控制点全在对角线上 → 曲线恒等于 y=x（贝塞尔求值/二分的闭式对照）
      { Target: 'Parameter', Id: 'AmbBez', Segments: [0, 0, 1, 1 / 3, 1 / 3, 2 / 3, 2 / 3, 1, 1] },
      { Target: 'Parameter', Id: 'AmbStep', Segments: [0, 0, 2, 1, 1] },
      { Target: 'Parameter', Id: 'AmbInv', Segments: [0, 0, 3, 0.5, 1, 0, 1.5, 0.5] },
      // 超程曲线（对照 shengluyisi_5 Param90/92 曲线里 14.7 这类超程取值）
      { Target: 'Parameter', Id: 'AmbOver', Segments: [0, 0, 0, 1, 14.7] },
      // 非 Parameter 曲线应被过滤，不落参
      { Target: 'Model', Id: 'PartOpacity', Segments: [0, 0, 0, 1, 1] },
    ],
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => motion3 })

  check('无 effect 组 → null', (await loadAmbient('/models/x/x.model3.json', {})) === null)
  check(
    'effect 组无动作 → null',
    (await loadAmbient('/models/x/x.model3.json', { motions: { effect: [] } })) === null,
  )

  const ambient = await loadAmbient('/models/x/x.model3.json', {
    motions: { effect: [{ File: 'm/effect.motion3.json' }] },
  })
  globalThis.fetch = realFetch
  check('加载返回逐帧采样器', typeof ambient?.apply === 'function')

  const core = makeCoreModel({
    AmbLin: { default: 0, min: 0, max: 1 },
    AmbBez: { default: 0, min: 0, max: 1 },
    AmbStep: { default: 0, min: 0, max: 1 },
    AmbInv: { default: 0, min: 0, max: 1 },
    AmbOver: { default: 0, min: 0, max: 2 },
    Unrelated: { default: 0.42, min: 0, max: 1 },
  })
  const v = (id) => core.getParameterValueById(id)

  ambient.apply(core, 0.5)
  check('线性段取中点插值', v('AmbLin') === 0.5)
  check('对角线贝塞尔恒等于 y=x', Math.abs(v('AmbBez') - 0.5) < 1e-6)
  check('阶跃段 t<t1 保持旧值', v('AmbStep') === 0)
  check('反阶跃段起播即跳到段末值', v('AmbInv') === 1)
  check('超程写入被钳制到参数 max（7.35→2）', v('AmbOver') === 2)
  check('非参数曲线不落参（Unrelated 未动）', v('Unrelated') === 0.42)

  ambient.apply(core, 0.999)
  check('线性段端点逼近', Math.abs(v('AmbLin') - 0.999) < 1e-9)
  ambient.apply(core, 1.001)
  check('阶跃段 t>t1 跳变', v('AmbStep') === 1)
  ambient.apply(core, 1.0)
  check('反阶跃后接线性回落取中点', Math.abs(v('AmbInv') - 0.75) < 1e-9)
  ambient.apply(core, 0.1)
  check('超程段前段未超程时原样写入（1.47）', Math.abs(v('AmbOver') - 1.47) < 1e-9)

  // 时长取模循环连播：Duration 2，t=2.5 ≡ 0.5
  ambient.apply(core, 2.5)
  check('时长取模循环连播', v('AmbLin') === 0.5 && Math.abs(v('AmbBez') - 0.5) < 1e-6)

  // 模型缺曲线参数（getParameterIndex=-1）时跳过绑定不炸
  const core2 = makeCoreModel({ AmbLin: { default: 0, min: 0, max: 1 } })
  ambient.apply(core2, 0.5)
  check('模型缺曲线参数时跳过绑定', core2.getParameterValueById('AmbLin') === 0.5)

  // 还原 window：本段的假 window 若滞留，后面 Cubism Core 的 wasm 全局会绑不进 globalThis
  globalThis.window = undefined
}

// ============ motion_curves ============
section('曲线目标序归一')
if (!cubismCoreAvailable()) {
  console.log('-- 缺 public/libs/live2dcubismcore.min.js，本段跳过')
} else {
  const { loadMocModel } = await import('../helpers/cubism.mjs')
  // motionPatches 顶层 import 依赖 Core 先就位（dist 模块顶层检查 window.Live2DCubismCore）
  await loadMocModel('models/fulici/fulici_2').catch(() => {})
  const { normalizeCurveTargetOrder } = await import('../../../src/l2d/motionPatches.js')

  const curve = (id, target) => ({ Id: id, Target: target, Segments: [0, 0, 2, 2, 0] })

  {
    // extract.py 产物在 Meta.Curves 里镜像一份曲线表，归一时须同步
    const curves = [curve('A', 'Parameter'), curve('B', 'Parameter'), curve('Op', 'Model'), curve('C', 'Parameter')]
    const data = { Curves: curves, Meta: { Curves: curves } }
    const out = normalizeCurveTargetOrder(data)
    eq('混排归一为分组序', out.Curves.map((c) => c.Id), ['Op', 'A', 'B', 'C'])
    eq('Meta 镜像同步', out.Meta.Curves.map((c) => c.Id), ['Op', 'A', 'B', 'C'])
  }

  {
    const data = { Curves: [curve('Op', 'Model'), curve('A', 'Parameter'), curve('P', 'PartOpacity')], Meta: {} }
    const out = normalizeCurveTargetOrder(data)
    check('已分组序原样返回', out.Curves === data.Curves)
  }

  {
    const data = { Curves: [curve('A', 'Parameter'), curve('B', 'Parameter')], Meta: {} }
    normalizeCurveTargetOrder(data)
    eq('同目标内相对次序不变', data.Curves.map((c) => c.Id), ['A', 'B'])
  }

  {
    const data = { Curves: [curve('A'), curve('Op', 'Model')], Meta: {} }
    const out = normalizeCurveTargetOrder(data)
    eq('缺 Target 按 Parameter 处理', out.Curves.map((c) => c.Id), ['Op', 'A'])
  }

  {
    const out = normalizeCurveTargetOrder(undefined)
    check('空数据不抛错', out === undefined)
  }
}

finish()
