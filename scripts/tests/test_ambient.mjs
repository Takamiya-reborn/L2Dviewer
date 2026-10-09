// 冒烟测试：ambient.js 的 motion3 曲线采样与参数直写（node scripts/tests/test_ambient.mjs，
// 在仓库根目录跑）。fetch 打桩供 loadAmbient 取 fixture；段类型全覆盖
// （线性/贝塞尔/阶跃/反阶跃）+ 范围钳制 + 时长取模循环。
import { suite } from './helpers/suite.mjs'
import { makeCoreModel } from './helpers/fakes.mjs'

const { check, finish } = suite('ambient 曲线采样')
const { loadAmbient } = await import('../../src/utils/ambient.js')

globalThis.window = { location: { href: 'http://localhost/' } }

const motion3 = {
  Meta: { Duration: 2 },
  Curves: [
    { Target: 'Parameter', Id: 'AmbLin', Segments: [0, 0, 0, 1, 1] },
    // 控制点全在对角线上 → 曲线恒等于 y=x（贝塞尔求值/二分的闭式对照）
    { Target: 'Parameter', Id: 'AmbBez', Segments: [0, 0, 1, 1 / 3, 1 / 3, 2 / 3, 2 / 3, 1, 1] },
    { Target: 'Parameter', Id: 'AmbStep', Segments: [0, 0, 2, 1, 1] },
    { Target: 'Parameter', Id: 'AmbInv', Segments: [0, 0, 3, 0.5, 1, 0, 1.5, 0.5] },
    // 超程曲线（对照 shengluyisi_5 Param90/92 达 14.7 的实况）
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

finish()
