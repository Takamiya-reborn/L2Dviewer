/**
 * 参数态差分探针（通用 CLI）：构造候选参数态与参照态对比，定位"复位不干净 / 扭曲错位"的参数级来源。
 *
 * 用法（仓库根目录）：node scripts/tests/probe/diff.mjs <皮肤名|目录> <子命令> [参数]
 *
 *   reset [flags]
 *       复位流程差分：场景 A 干净挂载 + 播 idle 记稳态基线；场景 B 点触点制造交互残留 → resetInteraction → 推进到
 *       回显时刻（fade+余量）与基线差分，并逐参标注写入者（idle 常量曲线 / 机器 parameterName / relation / 都不是
 *       =物理或引擎层）。差分非零即复位后参数未收敛的来源；之后按步长采样差分参数数直到收敛。动作日志核对 idle
 *       重播是否被拒。
 *       flags：--baseline-wait 2 / --interaction-wait 1 / --click-wait 1.2 / --reset-wait 0.75 /
 *       --default-diff-threshold 0.01 / --baseline-diff-threshold 0.05 / --sample-step 0.25 / --max-sample-time 6 /
 *       --max-print 30 / --max-tail-print 10 / --idle-index 0 / --zone-pattern '^Touch'（秒数类必须非负）
 *   pose --pose "标签: clip=<clip> motion=<name>@<t> set=P=v" [--pose ...] [--diff 1,2,3] [--skip-diff]
 *       参数姿态几何对比：按「节点尾值 + motion 曲线@t + 手工覆盖」构造若干候选参数态，对真实 moc3 逐个 update，
 *       打印各姿态的网格包围盒（全部/可见两行），以及各姿态 vs 第一个姿态（基准）的按 drawable 顶点最大位移排名
 *       ——定位"扭曲/错位"来自哪个参数态假设。
 *       姿态 spec：clip=<name> 节点尾值（state+carry 的 end）；carry=0 / state=0 掐掉对应来源；start=<name> 改用
 *       另一 clip 的衔接首值（carry 首值 + state 首值兜底）；motion=<name>[@t] 叠加曲线采样（t 默认 0，@end = 末帧
 *       -1/30）；set=Pid=v,... 手工覆盖。--diff 指定参与对比的姿态序号（0 起），默认全部非基准姿态。
 */
import path from 'path'
import { loadMocModel } from '../helpers/cubism.mjs'
import { createPipelineSim } from '../helpers/sim.mjs'
import { loadMotion, sampleMotionAt, clipNodeEnd, clipCarryStart } from '../helpers/motion3.mjs'
import { poseSnapshot, printBBox, displacementRanking } from '../helpers/geometry.mjs'
import { readJson, resolveModelDir, resolveSkin } from '../helpers/model_files.mjs'

const argv = process.argv.slice(2)

/** 从参数表抽出 `--name <值>`（原位删除），找不到返回 null */
function flagOf(list, name) {
  const i = list.indexOf(name)
  return i >= 0 ? list.splice(i, 2)[1] : null
}

// ---- reset：复位流终态差分 + 残差收敛追踪 + 写入者归属 ----
async function reset(list) {
  if (!list[0]) throw new Error('用法：node scripts/tests/probe/diff.mjs <skin 名或目录路径> reset [flags]')
  const base = resolveSkin(list[0])
  const numberFlag = (name, fallback) => {
    const value = flagOf(list, name)
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
    maxPrint: Number(flagOf(list, '--max-print') ?? 30),
    maxTailPrint: Number(flagOf(list, '--max-tail-print') ?? 10),
    idleIndex: Number(flagOf(list, '--idle-index') ?? 0),
    zonePattern: new RegExp(flagOf(list, '--zone-pattern') ?? '^Touch', 'i'),
  }
  if (!Number.isInteger(config.maxPrint) || config.maxPrint < 0) throw new Error('--max-print 必须是非负整数')
  if (!Number.isInteger(config.maxTailPrint) || config.maxTailPrint < 0) throw new Error('--max-tail-print 必须是非负整数')
  if (!Number.isInteger(config.idleIndex) || config.idleIndex < 0) throw new Error('--idle-index 必须是非负整数')
  if (config.sampleStep <= 0) throw new Error('--sample-step 必须大于 0')

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

  // 场景 A：挂载稳态基线
  const simA = await createPipelineSim(base)
  await simA.playSeconds(config.baselineWait)
  const baseline = new Map()
  for (let i = 0; i < simA.count; i++) baseline.set(simA.P.ids[i], simA.values[i])
  const offA = diffVs(simA, new Map(), config.defaultDiffThreshold)
  console.log(`--- A 挂载稳态 @${simA.now().toFixed(2)}s: 偏离默认的参数 ${offA.length} 个`)
  console.log('  ', offA.slice(0, config.maxPrint).map(([id, v, d]) => `${id}=${fmt(v)}(默认${fmt(d)})`).join('  '))

  // 场景 B：交互残留 -> 复位 -> 回显差分 -> 收敛追踪
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

  // 收敛追踪：回显后继续步进，按步长采样差分参数数
  let tail = d
  for (let t = 0; t < config.maxSampleTime && tail.length; t += config.sampleStep) {
    await sim.playSeconds(config.sampleStep)
    tail = diffVs(sim, baseline, config.baselineDiffThreshold)
    console.log(`@+${(t + config.sampleStep).toFixed(2)}s 差分 ${tail.length}`)
  }
  if (tail.length) tail.slice(0, config.maxTailPrint).forEach(([id, v, b]) => console.log(`  残留 ${id}: ${fmt(v)} vs ${fmt(b)}`))
  process.exit(0)
}

// ---- pose：候选参数态几何对比 ----
async function pose(list) {
  const target = list[0]
  const poseSpecs = []
  while (list.includes('--pose')) poseSpecs.push(flagOf(list, '--pose'))
  const diffSpec = flagOf(list, '--diff')
  const skipDiff = list.includes('--skip-diff')

  if (!target || !poseSpecs.length) {
    console.error('用法: node scripts/tests/probe/diff.mjs <皮肤目录> pose --pose "标签: clip=<clip> motion=<name>@<t> set=P=v" [--pose ...] [--diff 1,2]')
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

  // 解析各姿态 spec 并构造参数态
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

  // 位移对比
  if (!skipDiff) {
    const targets = diffSpec
      ? diffSpec.split(',').map(Number)
      : poses.map((_, i) => i).slice(1)
    for (const ti of targets) {
      displacementRanking(model, `${poses[ti].label} vs ${poses[0].label} (基准)`, snapshots[0], snapshots[ti])
    }
  }
}

const SUB = { reset, pose }

// 子命令可在参数表任意位置（惯例放皮肤目录后），命中即从表里摘出
const subIndex = argv.findIndex((a) => SUB[a])
const subName = subIndex >= 0 ? argv[subIndex] : null
const subRest = argv.filter((_, i) => i !== subIndex)

if (!subName || !subRest.length) {
  console.error(`用法: node scripts/tests/probe/diff.mjs <皮肤名|目录> ${Object.keys(SUB).join(' | ')} [子命令参数]`)
  process.exit(1)
}
await SUB[subName](subRest)
