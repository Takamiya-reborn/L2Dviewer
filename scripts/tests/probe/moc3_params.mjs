/**
 * moc3 参数表探针（通用 CLI，可对任意皮肤目录使用）。
 *
 * 用 Cubism Core 直读 moc3，打印参数表（id / min / max / default / 类型），
 * 并可选与 <name>.l2d.json 的拖拽参数机配置交叉核对——机器写入值会被模型
 * 参数区间二次钳制（Cubism 参数落在 [min,max] 之外取边界），machine.range
 * 或 action_trigger.num 超出模型区间的配置在游戏里同样到不了位，是"按档位
 * /按位置的事件不出现"这类问题的判定依据。
 *
 * 用法（仓库根目录）：
 *   node scripts/tests/probe/moc3_params.mjs models/wuzang/wuzang_3
 *   node scripts/tests/probe/moc3_params.mjs models/wuzang/wuzang_3 --param Zhunxing
 *   node scripts/tests/probe/moc3_params.mjs models/wuzang/wuzang_3 --check
 *
 *   <dir>  皮肤目录（含 <name>.moc3），也可直接给 moc3 文件路径
 *   --param <子串>   只打印 id 含子串的参数（大小写不敏感）
 *   --check          与同目录 l2d.json 交叉核对（缺 l2d.json 时跳过）
 *   --all            默认隐藏与默认值相同的 min/max 行（省屏），--all 全打印
 */
import fs from 'fs'
import path from 'path'
import { loadMocModel } from '../helpers/cubism.mjs'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : null
}
const showAll = args.includes('--all')
const check = args.includes('--check')
const paramFilter = flag('--param')?.toLowerCase() ?? null
const target = args[0]

if (!target) {
  console.error('用法: node scripts/tests/probe/moc3_params.mjs <皮肤目录|moc3> [--param 子串] [--check] [--all]')
  process.exit(1)
}

const dir = fs.existsSync(target) && fs.statSync(target).isDirectory()
  ? target
  : path.dirname(target)
const loaded = await loadMocModel(dir)
const model = loaded.model
const l2dFile = path.join(dir, `${loaded.name}.l2d.json`)
const l2d = fs.existsSync(l2dFile) ? JSON.parse(fs.readFileSync(l2dFile, 'utf8')) : null

const P = model.parameters
const rows = P.ids.map((id, i) => ({
  id,
  min: P.minimumValues[i],
  max: P.maximumValues[i],
  def: P.defaultValues[i],
  type: P.types?.[i],
}))

console.log(`${path.join(dir, loaded.name + '.moc3')} 参数 ${rows.length} 条`)
const ci = model.canvasinfo
console.log(`canvas ${ci.CanvasWidth}x${ci.CanvasHeight} (origin ${ci.CanvasOriginX},${ci.CanvasOriginY}) PPU=${ci.PixelsPerUnit}`)

let shown = 0
if (!check || paramFilter) {
  for (const r of rows) {
    if (paramFilter && !r.id.toLowerCase().includes(paramFilter)) continue
    if (!showAll && !paramFilter && r.min === r.def && r.max === r.def) continue
    console.log(
      `${r.id.padEnd(28)} min=${String(r.min).padStart(8)}  max=${String(r.max).padStart(8)}  def=${String(r.def).padStart(8)}`,
    )
    shown++
  }
  if (!paramFilter && !showAll) {
    console.log(`（其余 ${rows.length - shown} 条 min=max=def 已省略，--all 全打印）`)
  }
}

if (!check) process.exit(0)
if (!l2d) {
  console.log('--check：目录下无 l2d.json，跳过交叉核对')
  process.exit(0)
}

console.log('\n== l2d.json 机器区间 vs moc3 参数区间 ==')
let flagged = 0
for (const e of l2d.entries) {
  const pid = e.parameter
  const i = pid ? P.ids.indexOf(pid) : -1
  const [lo, hi] = i >= 0 && P.minimumValues[i] < P.maximumValues[i]
    ? [P.minimumValues[i], P.maximumValues[i]]
    : [null, null]
  const mr = Array.isArray(e.range) ? e.range : null
  const issues = []
  if (pid && i < 0) {
    issues.push(`参数 ${pid} 不在模型里（机器只记账不写值）`)
  } else if (mr && lo != null && (mr[0] < lo - 1e-6 || mr[1] > hi + 1e-6)) {
    issues.push(`machine.range [${mr}] 超出模型 [${lo},${hi}]，越界段被钳掉`)
  }
  const at = e.action_trigger
  if (at?.type === 4 && Array.isArray(at.num) && mr) {
    // type 4 触发值 = fix(offsetDrag) ∈ machine.range，num 不在 range ±25% 邻域内则恒不可触发
    const [n0, n1] = at.num
    const inReach = (n) => n >= mr[0] - Math.abs(n) * 0.25 && n <= mr[1] + Math.abs(n) * 0.25
    if (!inReach(n0) || !inReach(n1)) {
      issues.push(`action_trigger.num [${n0},${n1}] 不在 machine.range [${mr}] 的 ±25% 邻域内，恒不可触发`)
    }
  }
  if (issues.length) {
    flagged++
    console.log(`✗ ${e.id} ${e.draw_able_name} (${pid || '无参数'})`)
    for (const s of issues) console.log(`    ${s}`)
  }
}
if (!flagged) console.log('（无越界/不可达配置）')
