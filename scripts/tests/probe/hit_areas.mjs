/**
 * 命中区解析探针（L2dStage 挂载期 console 诊断的静态蒸馏版）。
 *
 * 直读 moc3 + model3.json，还原 pixi-live2d-display 的 HitAreas 解析
 * （internalModel.hitAreas：Name -> drawable 下标），打印：
 * - 各命中区的网格包围盒（画布 px，= getDrawableVertices 的本地空间；数值
 *   天然巨大是正常的——"画布"为 moc3 画布 px，wuzang_3 画布 8000×8000，
 *   背景板级判定区即 4374×4000 这个量级）；
 * - 与 <name>.l2d.json 的 draw_able_name 按查看器同规则归一化
 *   （toLowerCase + 剔除非字母数字）核对，标出两侧对不上的分区——"命中
 *   分区但机器没接管/机器配了但网格缺失"的静态判定依据。
 *
 * 与浏览器内诊断的差异：屏幕 px / 占视口高比例依赖实时取景（fitModel 后的
 * 换算），静态探针不可复算，已随临时诊断脚手架移除；本探针只出画布 px。
 * 顶点坐标取 moc3 初始值（模型首次 update 前的核心输出），与取景无关。
 *
 * 用法（仓库根目录）：
 *   node scripts/tests/probe/hit_areas.mjs models/wuzang/wuzang_3
 */
import fs from 'fs'
import path from 'path'
import { loadMocModel } from '../helpers/cubism.mjs'
import { drawableBounds, normalizeZone, readJson, resolveModelDir } from './model_probe.mjs'

const target = process.argv[2]
if (!target) {
  console.error('用法: node scripts/tests/probe/hit_areas.mjs <皮肤目录>')
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
