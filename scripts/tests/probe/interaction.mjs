/** 探针：打印 interaction.json 的 clip 状态与门控参数摘要。
 * 用法：node scripts/tests/probe/interaction.mjs models/wuzang/wuzang_3
 */
import path from 'path'
import { readJson, resolveModelDir } from './model_probe.mjs'

const target = process.argv[2]
if (!target) {
  console.error('用法: node scripts/tests/probe/interaction.mjs <皮肤目录|interaction.json>')
  process.exit(1)
}

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
