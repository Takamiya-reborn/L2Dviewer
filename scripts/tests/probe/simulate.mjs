/**
 * 交互管线场景重放探针（通用 CLI）。
 * 用真实 InteractionRuntime + DragOrchestrator + createActions 代码 + 真实资产，
 * 在 node 里按 60fps 重放点击/等待/复位场景，末尾 dump 机器状态与参数，
 * 并可与"游戏应然态"（clip 节点尾值 + 变体 motion 曲线@t）逐参数对比。
 *
 * 用法（仓库根目录）：
 *   node scripts/tests/probe/simulate.mjs models/fulici/fulici_2 \
 *     --scene "wait:0.5 click:TouchIdle1 wait:4.5 click:TouchIdle4 wait:13" \
 *     [--tap] [--param dianjikyc,All_Size] [--game "touch_idle4 idle4@0"]
 *
 *   --scene  空格分隔的步骤序列：
 *              wait:<sec>          播 <sec> 秒
 *              click:<zone>[:hold]  点区域（hold 默认 0.15）
 *              reset               ctx.actions.resetInteraction()（修复版时序）
 *   --tap    打印 orchestrator 的 [tap] 调试行
 *   --param  末尾追加打印这些参数的当前值（逗号分隔）
 *   --game   "<clip> <motion>[@<t>]"，与应然态对比（差 >0.01 的参数）
 */
import { resolveModelDir } from './model_probe.mjs'
import { createPipelineSim } from '../helpers/sim.mjs'
import { clipNodeEnd, loadMotion, sampleMotionAt } from '../helpers/motion3.mjs'

const args = process.argv.slice(2)
const flag = (n) => {
  const i = args.indexOf(n)
  return i >= 0 ? args.splice(i, 2)[1] : null
}
const target = args[0]
const scene = flag('--scene') ?? 'wait:1'
const tap = args.includes('--tap')
const paramWatch = flag('--param')?.split(',').filter(Boolean) ?? []
const game = flag('--game') // "<clip> <motion>[@<t>]"

if (!target) {
  console.error('用法: node scripts/tests/probe/simulate.mjs <皮肤目录> [--scene "wait:1 click:TouchIdle1 wait:4.5"] [--tap] [--param a,b] [--game "clip motion@t"]')
  process.exit(1)
}

const dir = resolveModelDir(target)
const sim = await createPipelineSim(dir, {
  debugHook: tap ? (s) => console.log('  [tap]', s) : null,
})

// ---- 场景重放 ----
console.log(`--- 场景开始: ${dir}  "${scene}"`)
for (const stepSpec of scene.split(/\s+/).filter(Boolean)) {
  const [kind, rest] = stepSpec.split(/:(.+)/)
  if (kind === 'wait') await sim.playSeconds(Number(rest))
  else if (kind === 'click') {
    const [zone, hold] = rest.split(':')
    await sim.clickZone(zone, hold ? Number(hold) : 0.15)
  } else if (kind === 'reset') sim.actions.resetInteraction()
  else {
    console.error(`未知场景步骤: ${stepSpec}（支持 wait:<sec> / click:<zone>[:hold] / reset）`)
    process.exit(1)
  }
}

// ---- dump ----
const { runtime, orch, core } = sim
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

// ---- 与游戏应然态对比 ----
if (game) {
  const [clipName, motionSpec] = game.split(/\s+/)
  const [motionClip, tSpec] = motionSpec.split('@')
  const t = tSpec ? (tSpec === 'end' ? loadMotion(dir, motionClip).Meta.Duration - 1 / 30 : Number(tSpec)) : 0
  const expected = { ...clipNodeEnd(sim.interaction, clipName), ...sampleMotionAt(loadMotion(dir, motionClip), t) }
  const P_ids = sim.P.ids
  console.log(`\n--- viewer 参数态 vs 应然态 (${clipName} 节点尾值 + ${motionClip}@${t.toFixed(3)}，差 >0.01)`)
  let diffs = 0
  // 遍历全部参数：clip/motion 未覆盖的参数以 moc3 默认值为应然态，
  // 这样"机器把开关写偏了"（如默认 1 的开关被写成 0）也能暴露
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
