/** 探针：打印 l2d.json 的动作条目摘要。
 * 用法：node scripts/tests/probe/entries.mjs models/wuzang/wuzang_3
 */
import path from 'path'
import { readJson, resolveModelDir } from './model_probe.mjs'

const target = process.argv[2]
if (!target) {
  console.error('用法: node scripts/tests/probe/entries.mjs <皮肤目录|l2d.json>')
  process.exit(1)
}

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
