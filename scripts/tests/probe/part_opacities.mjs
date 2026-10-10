/** 探针：初始 part opacity 分布，以及由此推算的 drawable 可见性。
 *
 * 用法（仓库根目录）：
 *   node scripts/tests/probe/part_opacities.mjs models/wuzang/wuzang_3
 *   node scripts/tests/probe/part_opacities.mjs models/<角色>/<皮肤>
 */
import { loadProbeModels } from './model_probe.mjs'

const targets = process.argv.slice(2)
if (!targets.length) {
  console.error('用法: node scripts/tests/probe/part_opacities.mjs <皮肤目录|moc3> [...]')
  process.exit(1)
}

for (const { model, name } of await loadProbeModels(targets)) {
  const partIds = Array.from(model.parts.ids)
  const partOps = model.parts.opacities
  const zero = partIds.filter((_, i) => partOps[i] < 0.01)
  console.log(`== ${name}: parts ${partIds.length}, 初始 opacity=0 的部件 ${zero.length}`)
  if (zero.length) console.log('  零透明度部件:', zero.join(', '))
  // moc3 没有 drawable 到 part 的直接索引，因此这里只看 drawable 自身 opacity。
  const dOps = model.drawables.opacities
  const invis = dOps.reduce((count, opacity) => count + (opacity < 0.01 ? 1 : 0), 0)
  console.log(`  drawable 自身初始 opacity<0.01: ${invis}/${dOps.length}`)
}