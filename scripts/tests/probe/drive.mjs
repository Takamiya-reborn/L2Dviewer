/**
 * 交互管线驱动探针（通用 CLI）：用真实 InteractionRuntime + DragOrchestrator + createActions 代码 + 真实资产，在 node 里按 60fps 复现 viewer 帧循环（helpers/sim.mjs 装配，顺序与 mount.js 对齐），排查"点了没反应 / 播错动作 / 特殊待机扭曲 / 复位不干净"类运行时问题。
 *
 * 用法（仓库根目录）：node scripts/tests/probe/drive.mjs <皮肤目录> <子命令> [参数]
 *
 *   replay --scene "wait:0.5 click:TouchIdle1 wait:4.5 click:TouchIdle4 wait:13" [--tap] [--param a,b] [--game "clip motion@t"] [--trace-out 文件] [--trace-compare 文件]
 *       场景重放：--scene 步骤为 wait:<sec> 播放 / click:<zone>[:hold] 点区域（hold 默认 0.15）/ reset 调
 *       resetInteraction()（对齐挂载层复位时序）；--tap 打印 orchestrator 的 [tap] 调试行；--param 末尾追加打印参数
 *       当前值；--game 与"游戏应然态"（clip 节点尾值 + 变体 motion 曲线@t，未覆盖参数以 moc3 默认值兜底）逐参数
 *       对比（差 >0.01）；--trace-out 导出逐帧 trace JSON，--trace-compare 与外部样本（Unity 录制）比较并打印第一
 *       批差异。场景时间/点击窗口/动作起播/逐帧采样共用 helpers/clock.mjs 的虚拟时钟，可复现。
 *   chain <分区名> [点击前等待秒] [--watch 参数名 ...]
 *       点击链路追踪：逐次点击指定分区，打印动作日志与指定参数的实时值轨迹，定位链系动作的触发/分档行为。
 *   zones
 *       分区交互审计：从干净态逐个命中区实测"点/按/拖是否真的有响应"，并对照提示层判据（机器 interactable /
 *       无机器 canPlay），输出两侧不一致与死分区清单。响应判据：① 动作播出（motionLog 增量，含 idle 变体切换
 *       重播）；② 机器参数值位移（|Δ|>0.01，拖后读）；③ 分区参数被联动层带动。三者皆无 = 死分区。每个分区
 *       tap（down 0.15s + up）与 drag（按住 1s 内线性拖 60px + up，取触发型机器的按住/邻域语义）两轮，两轮间
 *       resetInteraction 归零。
 *   minigame <入口分区> <判定分区> [轮数=20] [--seed 1]
 *       小游戏会话统计：模拟"进入→随机时刻点判定分区"的连续会话，统计 good/miss 走向与状态滞留。
 */
import fs from 'fs'
import path from 'path'
import { createPipelineSim } from '../helpers/sim.mjs'
import { clipNodeEnd, loadMotion, sampleMotionAt } from '../helpers/motion3.mjs'
import { diffTraces } from '../helpers/trace.mjs'
import { resolveModelDir, resolveSkin } from '../helpers/model_files.mjs'

const argv = process.argv.slice(2)

/** 从参数表抽出 `--name <值>`（原位删除），找不到返回 null */
function flagOf(list, name) {
  const i = list.indexOf(name)
  return i >= 0 ? list.splice(i, 2)[1] : null
}

// ---- replay：场景重放 + 状态 dump + 应然态/外部 trace 对比 ----
async function replay(list) {
  const [target] = list
  const scene = flagOf(list, '--scene') ?? 'wait:1'
  const tap = list.includes('--tap')
  const paramWatch = flagOf(list, '--param')?.split(',').filter(Boolean) ?? []
  const game = flagOf(list, '--game') // "<clip> <motion>[@<t>]"
  const traceOut = flagOf(list, '--trace-out')
  const traceCompare = flagOf(list, '--trace-compare')

  if (!target) {
    console.error('用法: node scripts/tests/probe/drive.mjs <皮肤目录> replay --scene "wait:1 click:TouchIdle1 wait:4.5" [--tap] [--param a,b] [--game "clip motion@t"]')
    process.exit(1)
  }

  const dir = resolveModelDir(target)
  const sim = await createPipelineSim(dir, {
    debugHook: tap ? (s) => console.log('  [tap]', s) : null,
  })

  // 场景重放
  console.log(`--- 场景开始: ${dir}  "${scene}"`)
  for (const stepSpec of scene.split(/\s+/).filter(Boolean)) {
    const [kind, r] = stepSpec.split(/:(.+)/)
    if (kind === 'wait') await sim.playSeconds(Number(r))
    else if (kind === 'click') {
      const [zone, hold] = r.split(':')
      await sim.clickZone(zone, hold ? Number(hold) : 0.15)
    } else if (kind === 'reset') sim.actions.resetInteraction()
    else {
      console.error(`未知场景步骤: ${stepSpec}（支持 wait:<sec> / click:<zone>[:hold] / reset）`)
      process.exit(1)
    }
  }

  // dump
  const { runtime, orch, core } = sim
  const traceJson = sim.trace.toJSON()
  if (traceOut) {
    fs.writeFileSync(traceOut, JSON.stringify(traceJson, null, 2))
    console.log(`逐帧 trace 已写入: ${traceOut}`)
  }
  if (traceCompare) {
    const expected = JSON.parse(fs.readFileSync(traceCompare, 'utf8'))
    const diffs = diffTraces(traceJson, expected, { epsilon: 0.01, maxDiffs: 20 })
    console.log('\n--- trace 差异（Web vs 外部样本）')
    if (!diffs.length) console.log('(无差异)')
    else {
      for (const diff of diffs) console.log(JSON.stringify(diff))
      process.exitCode = 1
    }
  }
  console.log('\n--- 动作播放日志')
  for (const l of sim.motionLog) console.log(l)
  console.log('\n--- 状态')
  console.log('idleIndex =', orch.idleIndex, ' pending =', runtime.pending,
    ' pendingIdle =', runtime.pendingIdle, ' machineAble =', orch.machineAble,
    ' isNeutral =', runtime.isNeutral(), ' 白名单 =', orch.enablePlayActions.length)
  const residue = [...runtime.node.entries()].filter(([pid, v]) => Math.abs(v - runtime.paramDefault(pid)) > 0.001)
  console.log('节点(非默认):', residue.length ? residue.map(([p, v]) => `${p}=${v}`).join(', ') : '无')
  if (paramWatch.length) {
    console.log('--- 参数当前值')
    for (const pid of paramWatch) console.log(pid, '=', core.getParameterValueById(pid))
  }

  // 与游戏应然态对比
  if (game) {
    const [clipName, motionSpec] = game.split(/\s+/)
    const [motionClip, tSpec] = motionSpec.split('@')
    const t = tSpec ? (tSpec === 'end' ? loadMotion(dir, motionClip).Meta.Duration - 1 / 30 : Number(tSpec)) : 0
    const expected = { ...clipNodeEnd(sim.interaction, clipName), ...sampleMotionAt(loadMotion(dir, motionClip), t) }
    const P_ids = sim.P.ids
    console.log(`\n--- viewer 参数态 vs 应然态 (${clipName} 节点尾值 + ${motionClip}@${t.toFixed(3)}，差 >0.01)`)
    let diffs = 0
    // 遍历全部参数：clip/motion 未覆盖的参数以 moc3 默认值为应然态，默认值非 0 的开关被写偏也能暴露
    for (let i = 0; i < sim.count; i++) {
      const want = expected[P_ids[i]] ?? sim.P.defaultValues[i]
      const d = sim.values[i] - want
      if (Math.abs(d) > 0.01) {
        diffs++
        console.log(`${sim.P.ids[i]}: viewer=${sim.values[i].toFixed(3)} game=${want.toFixed(3)} delta=${d.toFixed(3)}`)
      }
    }
    if (!diffs) console.log('(无差异)')
  }

  console.log(`\n完成，仿真时钟 ${sim.now().toFixed(2)}s`)
}

// ---- chain：逐次点击指定分区，追踪参数轨迹与动作日志 ----
async function chain(list) {
  const [target, zone, waitStr] = list
  const wait = Number(waitStr ?? 0.5)
  const wi = list.indexOf('--watch')
  const watch = wi >= 0 ? list.slice(wi + 1).filter((a) => !a.startsWith('--')) : []
  if (!target || !zone) {
    console.error('用法: node scripts/tests/probe/drive.mjs <皮肤目录> chain <分区名> [等待秒] [--watch 参数...]')
    process.exit(1)
  }
  const dir = resolveModelDir(target)
  const sim = await createPipelineSim(dir)
  const { orch, core } = sim

  const readWatch = (tag) => {
    const vals = watch.map((p) => `${p}=${orch.readParameter(p).toFixed(3)}`)
    console.log(`  t=${sim.now().toFixed(2)} idle=${orch.idleIndex} ${tag} ${vals.join(' ')}`)
  }

  await sim.playSeconds(2)
  console.log('== 基线 ==')
  readWatch('基线')

  const logFrom = sim.motionLog.length
  console.log(`== 点 ${zone} ==`)
  await sim.clickZone(zone)
  readWatch('点击后')

  console.log('== 后续 6s 轨迹（每 0.5s 采样）==')
  for (let i = 0; i < 12; i++) {
    await sim.playSeconds(0.5)
    readWatch('')
  }
  console.log('== 动作日志 ==')
  for (const l of sim.motionLog.slice(logFrom)) console.log(' ', l)
}

// ---- zones：分区交互审计（tap/drag 两轮实测 vs 提示层判据）----
async function zones(list) {
  const [target] = list
  if (!target) {
    console.error('用法: node scripts/tests/probe/drive.mjs <皮肤目录> zones')
    process.exit(1)
  }
  const dir = resolveModelDir(target)
  const name = path.basename(dir)
  const sim = await createPipelineSim(dir)
  const { runtime, orch } = sim

  // 命中区名单：model3.json HitAreas + l2d.json 条目里的 draw_able_name 并集
  const model3 = JSON.parse(fs.readFileSync(`${dir}/${name}.model3.json`, 'utf8'))
  const hitAreas = (model3.HitAreas ?? []).map((h) => h.Name)
  const l2dZones = [...new Set(sim.l2d.entries.map((e) => e.draw_able_name).filter(Boolean))]
  const zonesList = [...new Set([...hitAreas, ...l2dZones])]
  // 位移观察参数 = 全部机器参数 + 联动参数（从 l2d.json 条目现收，不写模型专属表）
  const watchPids = [
    ...new Set(
      sim.l2d.entries.flatMap((e) => [
        e.parameter,
        ...(e.relation_parameter?.list ?? []).map((r) => r.name),
      ]).filter(Boolean),
    ),
  ]

  console.log(`== ${dir} 分区审计（${zonesList.length} 个分区）==`)
  for (const zone of zonesList) {
    const machines = orch.machinesForZone(zone)
    const hasMachine = machines.length > 0
    // 提示层判据（hints.js 同款）：机器分区看 zoneInteractable，无机器分区看 canPlay
    const hintState = hasMachine ? orch.zoneInteractable(zone) : runtime.canPlay(zone)

    const results = []
    for (const gesture of ['tap', 'drag']) {
      sim.actions.resetInteraction()
      await sim.playSeconds(1.0)
      const logFrom = sim.motionLog.length
      const tapFrom = (orch.tapLog ?? []).length
      const before = new Map()
      for (const pid of watchPids) before.set(pid, sim.core.getParameterValueById(pid))

      if (gesture === 'tap') {
        await sim.clickZone(zone, 0.15)
      } else {
        // 拖拽：按住 1s，位置线性推进 60px（游戏屏幕 px，过 dragScale 的坐标域）
        orch.onDown(zone, { x: 0, y: 0 })
        for (let i = 1; i <= 60; i++) {
          orch.onMove({ x: i, y: i })
          sim.step()
          await sim.flush()
        }
        orch.onUp(zone, { x: 60, y: 60 })
        await sim.flush()
      }
      await sim.playSeconds(2.5)

      const motions = sim.motionLog.slice(logFrom).map((l) => l.replace(/^\[\w+\] [\d.]+ /, ''))
      const taps = (orch.tapLog ?? []).slice(tapFrom).map((l) => l.line)
      const moved = [...before].filter(([pid, v]) => Math.abs(sim.core.getParameterValueById(pid) - v) > 0.01).map(([pid]) => pid)
      results.push({ gesture, motions, taps, moved, idle: orch.idleIndex })
    }

    // 汇总：有动作 / 有参数位移 / 有机器记账即算有响应
    const acted = results.filter((r) => r.motions.length).map((r) => `${r.gesture}:${r.motions.join('|')}`)
    const paramMoves = [...new Set(results.flatMap((r) => r.moved))]
    const live = acted.length || paramMoves.length
    const verdict = !hasMachine
      ? (live ? 'C#路径有响应' : 'C#路径无动作')
      : live
        ? (hintState === true ? '正常' : '⚠ 有响应但提示层不亮(interactable=' + hintState + ')')
        : (hintState === true ? '⚠ 提示层亮但实测无响应' : '死分区(interactable=' + hintState + ')')

    console.log(`\n[${zone}] 机器=${machines.length ? machines.map((m) => m.id + '/t' + (m.actionTrigger?.type ?? '-')).join(',') : '无'} 提示判据=${hintState}`)
    for (const r of results) {
      if (r.motions.length) console.log(`  ${r.gesture}: 播出 ${r.motions.join(' | ')}（终态idle=${r.idle}）`)
      if (r.taps.length) console.log(`  ${r.gesture}: 链 ${r.taps.join(' -> ')}`)
      if (r.moved.length) console.log(`  ${r.gesture}: 参数位移 ${r.moved.join(',')}`)
      if (!r.motions.length && !r.taps.length && !r.moved.length) console.log(`  ${r.gesture}: 无任何响应`)
    }
    console.log(`  => ${verdict}`)
  }
}

// ---- minigame：入口→随机时刻点判定的连续会话统计 ----
async function minigame(list) {
  const [target, entryZone, judgeZone, roundsStr] = list
  const si = list.indexOf('--seed')
  let seed = si >= 0 ? Number(list[si + 1]) : 42
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  if (!target || !entryZone || !judgeZone) {
    console.error('用法: node scripts/tests/probe/drive.mjs <皮肤目录> minigame <入口分区> <判定分区> [轮数] [--seed]')
    process.exit(1)
  }
  const dir = resolveSkin(target)
  const sim = await createPipelineSim(dir)
  const { orch } = sim
  const rounds = Number(roundsStr ?? 20)

  await sim.playSeconds(2)
  let good = 0, miss = 0, none = 0, blocked = 0
  for (let r = 0; r < rounds; r++) {
    const logFrom = sim.motionLog.length
    // 入口：非 idle9 态才点（重复 idle 豁免会吞掉同变体触发）
    if (orch.idleIndex !== 9) {
      const f0 = sim.motionLog.length
      await sim.clickZone(entryZone)
      await sim.playSeconds(0.3)
      if (sim.motionLog.length === f0) blocked++
    }
    // 等 touch_drag8 播完进 idle9，再随机等 0.2~1.8s 点判定
    await sim.playSeconds(1.6)
    await sim.playSeconds(0.2 + rand() * 1.6)
    const v = orch.readParameter('touch_drag13')
    const before = orch.idleIndex
    const f1 = sim.motionLog.length
    await sim.clickZone(judgeZone)
    await sim.playSeconds(2.0)
    const moves = sim.motionLog.slice(Math.max(logFrom, f1)).join(' ')
    // 分支极性（baifeng_2 实机定案，HUD 触发链 + Miss 文字/动画随行）：扫描早半段 [0,5) → touch_drag9 = Miss（type10 不点的自动收束也接它），晚半段 [5,10) → touch_idle8 = Good
    if (moves.includes('touch_drag9')) { miss++; console.log(`r${r} v=${v.toFixed(2)} idle=${before} → miss(touch_drag9)`) }
    else if (moves.includes('touch_idle8')) { good++; console.log(`r${r} v=${v.toFixed(2)} idle=${before} → good(touch_idle8)`) }
    else { none++; console.log(`r${r} v=${v.toFixed(2)} idle=${before} idleIndex→${orch.idleIndex} → (无动作) ${moves || ''}`) }
  }
  console.log(`== good=${good} miss=${miss} 无动作=${none} 入口被吞=${blocked} / ${rounds}`)
}

const SUB = { replay, chain, zones, minigame }

// 子命令可在参数表任意位置（惯例放皮肤目录后），命中即从表里摘出
const subIndex = argv.findIndex((a) => SUB[a])
const subName = subIndex >= 0 ? argv[subIndex] : null
const subRest = argv.filter((_, i) => i !== subIndex)

if (!subName || !subRest.length) {
  console.error(`用法: node scripts/tests/probe/drive.mjs <皮肤目录> ${Object.keys(SUB).join(' | ')} [子命令参数]`)
  process.exit(1)
}
await SUB[subName](subRest)
