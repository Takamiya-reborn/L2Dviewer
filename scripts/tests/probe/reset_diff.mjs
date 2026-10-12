/** 探针：复位流程的参数终态差分 + 残差收敛追踪 + 写入者归属。
 *
 * 场景 A（挂载稳态基线）：干净挂载 + 播 2s idle，记录全部偏离默认的参数。
 * 场景 B（复位流）：点触点制造交互残留 -> actions.resetInteraction() -> 推进到回显时刻（fade+余量）-> 与基线差分，并逐参标注写入者（idle 常量曲线 / 机器 parameterName / relation / 都不是=物理或引擎层）。
 * 差分非零即复位后参数未收敛的参数级来源；之后每 0.25s 采样差分参数数直到收敛。动作日志核对 idle 重播是否被拒。
 */
import path from 'path'
import { fileURLToPath } from 'url'
import { createPipelineSim } from '../helpers/sim.mjs'
import { loadMotion } from '../helpers/motion3.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const skins = {
  fulici_2: 'models/fulici/fulici_2',
  wuzang_3: 'models/wuzang/wuzang_3',
  shengluyisi_5: 'models/shengluyisi/shengluyisi_5',
  baifeng_2: 'models/baifeng/baifeng_2',
}
const args = process.argv.slice(2)
const skin = args[0] ?? 'fulici_2'
const flag = (name) => {
  const index = args.indexOf(name)
  if (index < 0) return null
  const value = args[index + 1]
  args.splice(index, 2)
  return value
}
const numberFlag = (name, fallback) => {
  const value = flag(name)
  if (value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} 必须是非负数`)
  return number
}

const config = {
  baselineWait: numberFlag('--baseline-wait', 2),
  interactionWait: numberFlag('--interaction-wait', 1),
  clickWait: numberFlag('--click-wait', 1.2),
  resetWait: numberFlag('--reset-wait', 0.75),
  defaultDiffThreshold: numberFlag('--default-diff-threshold', 0.01),
  baselineDiffThreshold: numberFlag('--baseline-diff-threshold', 0.05),
  sampleStep: numberFlag('--sample-step', 0.25),
  maxSampleTime: numberFlag('--max-sample-time', 6),
  maxPrint: Number(flag('--max-print') ?? 30),
  maxTailPrint: Number(flag('--max-tail-print') ?? 10),
  idleIndex: Number(flag('--idle-index') ?? 0),
  zonePattern: new RegExp(flag('--zone-pattern') ?? '^Touch', 'i'),
}
if (!Number.isInteger(config.maxPrint) || config.maxPrint < 0) throw new Error('--max-print 必须是非负整数')
if (!Number.isInteger(config.maxTailPrint) || config.maxTailPrint < 0) throw new Error('--max-tail-print 必须是非负整数')
if (!Number.isInteger(config.idleIndex) || config.idleIndex < 0) throw new Error('--idle-index 必须是非负整数')
if (config.sampleStep <= 0) throw new Error('--sample-step 必须大于 0')
if (!skins[skin]) throw new Error(`未知皮肤 ${skin}`)
const base = path.join(root, skins[skin])

const fmt = (v) => v.toFixed(3)
// 与参照表差分超阈值 thr 的参数，[id, 现值, 参照值]；参照表取空 Map 即对默认值比
function diffVs(sim, ref, thr) {
  const out = []
  for (let i = 0; i < sim.count; i++) {
    const d = ref.get(sim.P.ids[i]) ?? sim.P.defaultValues[i]
    if (Math.abs(sim.values[i] - d) > thr) out.push([sim.P.ids[i], sim.values[i], d])
  }
  return out
}

// ---- 场景 A：挂载稳态基线 ----
const simA = await createPipelineSim(base)
await simA.playSeconds(config.baselineWait)
const baseline = new Map()
for (let i = 0; i < simA.count; i++) baseline.set(simA.P.ids[i], simA.values[i])
const offA = diffVs(simA, new Map(), config.defaultDiffThreshold)
console.log(`--- A 挂载稳态 @${simA.now().toFixed(2)}s: 偏离默认的参数 ${offA.length} 个`)
console.log('  ', offA.slice(0, config.maxPrint).map(([id, v, d]) => `${id}=${fmt(v)}(默认${fmt(d)})`).join('  '))

// ---- 场景 B：交互残留 -> 复位 -> 回显差分 -> 收敛追踪 ----
const sim = await createPipelineSim(base)
await sim.playSeconds(config.interactionWait)
// 点触点制造状态残留（zone 名取 l2d.json 的 draw_able_name；motion 组名 orchestrator 认不出，点击会静默空转）
const zones = [...new Set(sim.l2d.entries.map((e) => e.draw_able_name).filter((n) => config.zonePattern.test(n)))]
console.log(`[B] 点击 zone：${zones.join(' ')}`)
for (const z of zones) {
  await sim.clickZone(z)
  await sim.playSeconds(config.clickWait)
}
if (!sim.motionLog.some((l) => l.startsWith('[start]') && !l.includes('(idle)'))) {
  console.warn('[B] 警告：交互未起播任何非 idle 动作——后续差分只是 idle 漂移')
}
console.log(`[B] 交互后 @${sim.now().toFixed(2)}s 日志尾：`, sim.motionLog.slice(-4))
const offB = diffVs(sim, new Map(), config.defaultDiffThreshold)
console.log(`--- B 复位前（残留态）: 偏离默认的参数 ${offB.length} 个`)

sim.actions.resetInteraction()
await sim.playSeconds(config.resetWait)
console.log('[B] 日志尾：', sim.motionLog.slice(-4))

// 写入者归属：idle 常量曲线 / 机器 parameterName / relation / 都不是（物理或引擎层）
const idleCurves = new Map()
for (const c of loadMotion(base, sim.orch.idleClipFor(config.idleIndex)).Curves) {
  if (c.Target === 'Parameter') idleCurves.set(c.Id, c.Segments[c.Segments.length - 1])
}
const writers = new Map()
for (const m of sim.orch.machines) {
  if (m.parameterName) writers.set(m.parameterName, `机器${m.id}(${m.drawAbleName ?? ''}) param`)
  for (const r of m.relations) writers.set(r.name, `机器${m.id} relation type${r.type}`)
}

const d = diffVs(sim, baseline, config.baselineDiffThreshold)
console.log(`=== 回显时刻 @${sim.now().toFixed(2)}s 与基线差分 ${d.length} 个`)
for (const [id, v, b] of d) {
  const idle = idleCurves.get(id)
  console.log(
    `  ${id}: now=${fmt(v)} base=${fmt(b)}` +
    ` | idle曲线末值=${idle ?? '无'} | 写入者=${writers.get(id) ?? '（无机器/曲线——物理或引擎层）'}`,
  )
}

// 基线点亮被复位抹掉的（回显缺失）/ 基线没有但回显态多出的（残留）
const defOf = (id) => sim.P.defaultValues[sim.idxOfId.get(id)]
const lost = offA.map(([id]) => id).filter((id) => Math.abs(sim.values[sim.idxOfId.get(id)] - defOf(id)) <= config.defaultDiffThreshold)
console.log(`=== 仅基线有（回显缺失的点亮）${lost.length} 个：
  ${lost.join('\n  ')}`)
const extra = offB.filter(([id]) => Math.abs(baseline.get(id) - defOf(id)) <= config.defaultDiffThreshold)
console.log(`=== 仅回显态有（多余残留）${extra.length} 个：
  ${extra.map(([id, v, dd]) => `${id}=${fmt(v)}(默认${fmt(dd)})`).join('\n  ')}`)

// 收敛追踪：回显后继续步进，每 0.25s 采样差分参数数
let tail = d
for (let t = 0; t < config.maxSampleTime && tail.length; t += config.sampleStep) {
  await sim.playSeconds(config.sampleStep)
  tail = diffVs(sim, baseline, config.baselineDiffThreshold)
  console.log(`@+${(t + config.sampleStep).toFixed(2)}s 差分 ${tail.length}`)
}
if (tail.length) tail.slice(0, config.maxTailPrint).forEach(([id, v, b]) => console.log(`  残留 ${id}: ${fmt(v)} vs ${fmt(b)}`))
process.exit(0)
