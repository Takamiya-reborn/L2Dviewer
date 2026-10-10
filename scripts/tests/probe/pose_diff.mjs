/**
 * 参数姿态几何探针（通用 CLI）。
 * 按「节点尾值 + motion 曲线@t + 手工覆盖」构造若干候选参数态，对真实 moc3
 * 逐个 update，打印各姿态的网格包围盒，以及指定姿态 vs 第一个姿态（基准）
 * 的按 drawable 顶点最大位移排名——定位"扭曲/错位"来自哪个参数态假设。
 *
 * 用法（仓库根目录）：
 *   node scripts/tests/probe/pose_diff.mjs models/fulici/fulici_2 \
 *     --pose "S_GAME: clip=touch_idle4 motion=idle4@0" \
 *     --pose "H1: clip=touch_idle4 motion=idle@0" \
 *     --pose "H2: motion=idle4@0 set=ParamEyeLOpen=1" \
 *     [--diff 1,2,3] [--skip-diff]
 *
 * 姿态 spec（--pose "标签: k=v ..."，标签可省）：
 *   clip=<name>        interaction clip 的节点尾值（state+carry 的 end）
 *   carry=0 / state=0  掐掉对应来源（假设"carry 丢失/开关丢失"）
 *   start=<name>       改用另一 clip 的衔接首值（carry 首值 + state 首值兜底）
 *   motion=<name>[@t]  叠加 motion 曲线@t（t 默认 0，@end = 末帧-1/30）
 *   set=Pid=v,...      手工覆盖参数
 * --diff 后给出与基准对比的姿态序号（0 起）；默认对比全部非基准姿态。
 */
import path from 'path'
import { resolveModelDir, readJson } from './model_probe.mjs'
import { loadMocModel } from '../helpers/cubism.mjs'
import { loadMotion, sampleMotionAt, clipNodeEnd, clipCarryStart } from '../helpers/motion3.mjs'
import { poseSnapshot, printBBox, displacementRanking } from '../helpers/geometry.mjs'

const args = process.argv.slice(2)
const flag = (n) => {
  const i = args.indexOf(n)
  return i >= 0 ? args.splice(i, 2)[1] : null
}
const target = args[0]
const poseSpecs = []
while (args.includes('--pose')) poseSpecs.push(flag('--pose'))
const diffSpec = flag('--diff')
const skipDiff = args.includes('--skip-diff')

if (!target || !poseSpecs.length) {
  console.error('用法: node scripts/tests/probe/pose_diff.mjs <皮肤目录> --pose "标签: clip=<clip> motion=<name>@<t> set=P=v" [--pose ...] [--diff 1,2]')
  process.exit(1)
}

const dir = resolveModelDir(target)
const { model } = await loadMocModel(dir)
const P = model.parameters
const count = P.count
const idxOfId = new Map(P.ids.map((id, i) => [id, i]))
const interaction = readJson(path.join(dir, `${path.basename(dir)}.interaction.json`))

/** 把一组参数对钳制写入模型（缺省参数保持 moc3 默认） */
function applyPairs(pairs) {
  for (const [pid, val] of Object.entries(pairs)) {
    const i = idxOfId.get(pid)
    if (i === undefined) continue
    P.values[i] = Math.min(P.maximumValues[i], Math.max(P.minimumValues[i], val))
  }
}

// ---- 解析各姿态 spec 并构造参数态 ----
const poses = poseSpecs.map((spec, si) => {
  const m = spec.match(/^(?:([^:]+):\s*)?(.*)$/)
  const label = m[1] ?? `P${si}`
  const kv = {}
  for (const tok of m[2].split(/\s+/).filter(Boolean)) {
    const [k, v = '1'] = tok.split('=')
    kv[k] = v
  }
  const pairs = {}
  if (kv.clip) Object.assign(pairs, clipNodeEnd(interaction, kv.clip, {
    state: kv.state !== '0',
    carry: kv.carry !== '0',
  }))
  if (kv.start) Object.assign(pairs, clipCarryStart(interaction, kv.start))
  if (kv.motion) {
    const [name, tSpec] = kv.motion.split('@')
    const t = tSpec ? (tSpec === 'end' ? loadMotion(dir, name).Meta.Duration - 1 / 30 : Number(tSpec)) : 0
    Object.assign(pairs, sampleMotionAt(loadMotion(dir, name), t))
  }
  if (kv.set) {
    for (const assign of kv.set.split(',')) {
      const [pid, v] = assign.split('=')
      pairs[pid] = Number(v)
    }
  }
  return { label, pairs }
})

const D = model.drawables
const snapshots = []
for (const { label, pairs } of poses) {
  for (let i = 0; i < count; i++) P.values[i] = P.defaultValues[i]
  applyPairs(pairs)
  model.update()
  snapshots.push(poseSnapshot(model))
  printBBox(`--- ${label}`, model, snapshots.at(-1))
}

// ---- 位移对比 ----
if (!skipDiff) {
  const targets = diffSpec
    ? diffSpec.split(',').map(Number)
    : poses.map((_, i) => i).slice(1)
  for (const ti of targets) {
    displacementRanking(model, `${poses[ti].label} vs ${poses[0].label} (基准)`, snapshots[0], snapshots[ti])
  }
}
