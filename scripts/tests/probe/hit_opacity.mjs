/** 探针：打印 HitAreas 对应 drawable 的初始透明度与渲染顺序。
 * 用法：node scripts/tests/probe/hit_opacity.mjs models/wuzang/wuzang_3
 */
import { loadProbeModels } from './model_probe.mjs'

const targets = process.argv.slice(2)
if (!targets.length) {
  console.error('用法: node scripts/tests/probe/hit_opacity.mjs <皮肤目录|moc3> [...]')
  process.exit(1)
}

for (const { model, model3, name } of await loadProbeModels(targets)) {
  const drawables = model.drawables
  console.log(`== ${name}: hit-area drawable opacities`)
  for (const hitArea of model3?.HitAreas ?? []) {
    const index = drawables.ids.indexOf(hitArea.Id)
    if (index < 0) {
      console.log(`${hitArea.Name}: drawable 不存在`)
      continue
    }
    console.log(
      `${hitArea.Name.padEnd(16)} idx=${String(index).padStart(4)} ` +
      `opacity=${drawables.opacities[index]} renderOrder=${drawables.renderOrders[index]} ` +
      `flags=0b${drawables.constantFlags[index].toString(2).padStart(8, '0')}`,
    )
  }
  const zeroTop = drawables.opacities.reduce(
    (count, opacity, index) => count + (opacity < 0.01 && drawables.renderOrders[index] > 900 ? 1 : 0),
    0,
  )
  console.log(`zero-opacity drawables with renderOrder>900: ${zeroTop}`)
}
