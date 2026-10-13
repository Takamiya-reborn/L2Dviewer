/**
 * 配置摘要探针（通用 CLI）：直读皮肤目录下的 JSON 配置打印摘要，不碰 moc3。
 *
 * 用法（仓库根目录）：node scripts/tests/probe/config.mjs <皮肤目录> <子命令>
 *
 *   entries       l2d.json 动作条目摘要（id / 分区 / mode / 参数 / 触发器 / active 变体与名单规模）
 *   interaction   interaction.json 的 clip 状态与门控参数摘要（state/carry 区间、statePids、gated 可产出参数）
 */
import path from 'path'
import { readJson, resolveModelDir } from '../helpers/model_files.mjs'

const [target, sub] = process.argv.slice(2)

// ---- entries：l2d.json 动作条目摘要 ----
function entries(target) {
  const dir = resolveModelDir(target)
  const name = path.basename(dir)
  const l2d = readJson(path.join(dir, `${name}.l2d.json`))
  for (const entry of l2d.entries ?? []) {
    const trigger = entry.action_trigger
    const active = entry.action_trigger_active
    console.log(
      `${entry.id} zone=${entry.draw_able_name.padEnd(12)} mode=${entry.mode} ` +
      `param=${(entry.parameter || '-').padEnd(14)} ` +
      `at=${trigger ? `t${trigger.type}${trigger.num != null ? ` num=${JSON.stringify(trigger.num)}` : ''}${trigger.action ? ` act=${trigger.action}` : ''}${trigger.parameter ? ` on=${trigger.parameter}` : ''}${trigger.delta ? ` delta=${trigger.delta}` : ''}` : '-'} ` +
      `idle=${active && active.idle !== '' ? active.idle : '-'} ` +
      `enable_n=${Array.isArray(active?.enable) ? active.enable.length : active?.enable && typeof active.enable === 'object' ? Object.keys(active.enable).length : 0}`,
    )
  }
}

// ---- interaction：interaction.json clip 状态与门控参数摘要 ----
function interaction(target) {
  const dir = resolveModelDir(target)
  const name = path.basename(dir)
  const { clips = {} } = readJson(path.join(dir, `${name}.interaction.json`))
  console.log('clips:', Object.keys(clips).length)
  const watch = [
    'touch_drag9', 'touch_drag10', 'touch_drag11', 'touch_drag12', 'touch_drag13', 'touch_drag14',
    'touch_drag1', 'touch_drag2', 'touch_drag3', 'touch_drag4', 'touch_drag5', 'touch_drag6', 'touch_drag7', 'touch_drag8',
    'touch_special', 'touch_idle1', 'touch_idle3', 'touch_idle4', 'touch_idle5', 'touch_idle6', 'touch_idle7',
  ]
  for (const clipName of watch) {
    const clip = clips[clipName]
    if (!clip) { console.log(`${clipName}: (无 state/carry 记录)`); continue }
    const states = Object.entries(clip.state ?? {}).map(([key, value]) => `${key}:${value[0]}->${value[1]}`)
    console.log(`${clipName}: state[${states.join(', ')}] carry[${Object.keys(clip.carry ?? {}).join(', ')}]`)
  }

  const stateParameters = new Set()
  const gatedParameters = new Set()
  for (const clip of Object.values(clips)) {
    for (const [parameter, [start, end]] of Object.entries(clip.state ?? {})) {
      stateParameters.add(parameter)
      if (end === 1 && start !== 1) gatedParameters.add(parameter)
    }
  }
  console.log('\nstatePids:', [...stateParameters].sort().join(', '))
  console.log('gated(可产出=1):', [...gatedParameters].sort().join(', '))
}

const SUB = { entries, interaction }

if (!target || !SUB[sub]) {
  console.error(`用法: node scripts/tests/probe/config.mjs <皮肤目录> ${Object.keys(SUB).join(' | ')}`)
  process.exit(1)
}
SUB[sub](target)
