/**
 * 命中区解析探针（L2dStage 挂载期 console 诊断的静态蒸馏版）。直读 moc3 + model3.json，还原 pixi-live2d-display 的 HitAreas 解析（internalModel.hitAreas：Name -> drawable 下标），打印：
 * - 各命中区的网格包围盒（画布 px，= getDrawableVertices 的本地空间；数值天然巨大是正常的——"画布"为 moc3 画布 px，wuzang_3 画布 8000×8000，背景板级判定区即 4374×4000 这个量级）；
 * - 与 <name>.l2d.json 的 draw_able_name 按查看器同规则归一化（toLowerCase + 剔除非字母数字）核对，标出两侧对不上的分区——"命中分区但机器没接管/机器配了但网格缺失"的静态判定依据。
 *
 * 与浏览器内诊断的差异：屏幕 px / 占视口高比例依赖实时取景（fitModel 后的换算），静态探针不可复算，只出画布 px；顶点坐标取 moc3 初始值（模型首次 update 前的核心输出），与取景无关。
 *
 * 用法（仓库根目录）：
 *   node scripts/tests/probe/hit_areas.mjs models/wuzang/wuzang_3
 */
import fs from 'fs'
import path from 'path'
import { loadMocModel } from '../helpers/cubism.mjs'
import { loadMotion, sampleMotionAt } from '../helpers/motion3.mjs'
import { drawableBounds, normalizeZone, readJson, resolveModelDir } from './model_probe.mjs'

const argv = process.argv.slice(2)
const flagAll = (n) => {
  const out = []
  for (let i = 1; i < argv.length; i++) if (argv[i] === n) out.push(argv[++i] ?? '')
  return out
}
const target = argv[0]
const poses = flagAll('--at') // clip[@t]：该动作曲线 @t 秒的姿态
const overrides = flagAll('--param') // pid=v：参数覆盖（与各姿态叠加）
if (!target) {
  console.error(
    '用法: node scripts/tests/probe/hit_areas.mjs <皮肤目录> [--at idle8@0 ...] [--param BANZI=1 ...]',
  )
  process.exit(1)
}

const dir = resolveModelDir(target)
const { model, model3, name } = await loadMocModel(dir)

const ci = model.canvasinfo
console.log(`${path.join(dir, name + '.moc3')} 画布 ${ci.CanvasWidth}x${ci.CanvasHeight}`)

const hitAreas = model3?.HitAreas ?? []
const drawableIds = model.drawables.ids
const areas = hitAreas.map((h) => {
  const index = drawableIds.indexOf(h.Id)
  return { name: h.Name, id: h.Id, index }
})

console.log(`\n== HitAreas（model3.json ${areas.length} 条）==`)
const boxes = new Map()
for (const a of areas) {
  if (a.index < 0) {
    console.log(`✗ ${a.name} (${a.id}): drawable 不存在（网格缺失或 Id 拼写不符）`)
    continue
  }
  const { minX, minY, maxX, maxY } = drawableBounds(model.drawables, a.index)
  boxes.set(normalizeZone(a.name), a.name)
  console.log(
    `${a.name.padEnd(20)} drawable=${String(a.index).padStart(3)}  ` +
    `判定框(画布px) ${Math.round(maxX - minX)}×${Math.round(maxY - minY)}  ` +
    `范围 x[${Math.round(minX)},${Math.round(maxX)}] y[${Math.round(minY)},${Math.round(maxY)}]`,
  )
}

const l2dFile = path.join(dir, `${name}.l2d.json`)
const l2d = fs.existsSync(l2dFile) ? readJson(l2dFile) : null
if (!l2d) {
  console.log('\n（目录下无 l2d.json，跳过机器分区核对）')
  process.exit(0)
}

console.log('\n== 机器分区（l2d.json draw_able_name）vs HitAreas ==')
let flagged = 0
for (const e of l2d.entries) {
  const zone = normalizeZone(e.draw_able_name)
  if (!boxes.has(zone)) {
    flagged++
    console.log(`✗ ${e.draw_able_name} (${e.parameter}): HitAreas 无同名分区，机器路由不会命中`)
  }
}
for (const a of areas) {
  const hasMachine = l2d.entries.some((e) => normalizeZone(e.draw_able_name) === normalizeZone(a.name))
  if (!hasMachine) {
    // touch_head/body 等 C# 路径分区本就无机器，走 interaction.json 门控，非异常
    const isDragFamily = /^touch_(drag|idle|special)/i.test(a.name)
    console.log(`${isDragFamily ? '△' : '·'} ${a.name}: 无机器接管${isDragFamily ? '（触摸系分区却走状态机路径？）' : '（C# 路径分区，正常）'}`)
  }
}
if (!flagged) console.log('（机器分区与 HitAreas 全部对上）')

// ---- 姿态/参数覆盖下的判定框位移复核 ----
// keyform 开关参数会整体拽动判定面网格（如背景板 BANZI 弹出时热点整体跳到板位布局），点击路由随姿态变化——静态初始值之外按动作曲线/参数覆盖重算
const P = model.parameters
const idxOfId = new Map(P.ids.map((id, i) => [id, i]))
function reevaluate(label, motionPairs) {
  for (let i = 0; i < P.count; i++) P.values[i] = P.defaultValues[i]
  for (const spec of overrides) {
    const [pid, v] = spec.split('=')
    const i = idxOfId.get(pid)
    if (i === undefined) {
      console.error(`✗ --param ${spec}: 参数不存在`)
      process.exit(1)
    }
    P.values[i] = Number(v)
  }
  for (const [pid, v] of Object.entries(motionPairs)) {
    const i = idxOfId.get(pid)
    if (i !== undefined) P.values[i] = v
  }
  model.update()
  console.log(`\n== 判定框 @ ${label} ==`)
  for (const a of areas) {
    if (a.index < 0) continue
    const { minX, minY, maxX, maxY } = drawableBounds(model.drawables, a.index)
    console.log(
      `${a.name.padEnd(20)} 范围 x[${Math.round(minX)},${Math.round(maxX)}] y[${Math.round(minY)},${Math.round(maxY)}]`,
    )
  }
}

if (overrides.length && !poses.length) reevaluate('default' + (overrides.length ? ` + ${overrides.join(' ')}` : ''), {})
for (const spec of poses) {
  const [clip, t] = spec.split('@')
  const pairs = sampleMotionAt(loadMotion(dir, clip), t ? Number(t) : 0)
  const suffix = overrides.length ? ` + ${overrides.join(' ')}` : ''
  reevaluate(`${spec}${suffix}`, pairs)
}
