// 体检 models/ 下每套皮肤的 moc3 资产（node scripts/tests/test_models.mjs，在仓库根目录跑）。
// 合并了昔日的 probe_deformed / probe_hitmesh：HitAreas 可解析、defaults 覆盖、
// 提取清单在位为硬检查；默认姿态下命中区网格包围盒（isHit 的实际判定范围）打印
// 出来供人工对照游戏内触发位置。
// 模型不入库：本机 models/ 为空或缺 Cubism Core 时整支跳过。
import fs from 'fs'
import path from 'path'
import { suite } from './helpers/suite.mjs'
import { cubismCoreAvailable, loadMocModel } from './helpers/cubism.mjs'
import { drawableBounds, readJson } from './probe/model_probe.mjs'

const { check, finish } = suite('models 资产体检')

const skins = fs.existsSync('models')
  ? fs
      .readdirSync('models', { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((role) =>
        fs
          .readdirSync(path.join('models', role.name), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => path.join('models', role.name, d.name)),
      )
      .filter((dir) => fs.readdirSync(dir).some((f) => f.endsWith('.moc3')))
  : []

if (!cubismCoreAvailable() || !skins.length) {
  console.log('-- 本机无 models/ 皮肤或缺 public/libs/live2dcubismcore.min.js，整支跳过')
  process.exit(0)
}

for (const dir of skins) {
  const name = path.basename(dir)
  console.log(`\n== ${name} ==`)
  const { model, model3, defaults } = await loadMocModel(dir)
  const D = model.drawables
  const CI = model.canvasinfo
  console.log(
    `drawables ${D.count}, parts ${model.parts.count}, canvas ${CI.CanvasWidth}x${CI.CanvasHeight} units, ppu ${CI.PixelsPerUnit.toFixed(1)}`,
  )

  check(`${name}: HitAreas 全部可解析到 drawable`, (model3?.HitAreas ?? []).every((ha) => D.ids.includes(ha.Id)))

  check(`${name}: defaults.json 在位`, !!defaults)
  if (defaults) {
    const uncovered = model.parameters.ids.filter((id) => !(id in defaults))
    check(`${name}: defaults 覆盖全部参数`, uncovered.length === 0)
    if (uncovered.length) console.log(`  未覆盖: ${uncovered.join(', ')}`)
    for (let i = 0; i < model.parameters.count; i++) {
      const d = defaults[model.parameters.ids[i]]
      if (d) model.parameters.values[i] = d.default
    }
    model.update()
  }

  check(`${name}: interaction.json 在位`, fs.existsSync(path.join(dir, `${name}.interaction.json`)))
  check(`${name}: l2d.json 在位`, fs.existsSync(path.join(dir, `${name}.l2d.json`)))
  const l2d = fs.existsSync(path.join(dir, `${name}.l2d.json`))
    ? readJson(path.join(dir, `${name}.l2d.json`))
    : null
  check(`${name}: l2d.json 带 name`, typeof l2d?.name === 'string' && l2d.name.length > 0)

  const ppu = CI.PixelsPerUnit
  console.log('  命中区            w(units)  h        cx      cy     op')
  for (const ha of model3?.HitAreas ?? []) {
    const di = D.ids.indexOf(ha.Id)
    if (di < 0) continue
    const { minX, minY, maxX, maxY } = drawableBounds(D, di)
    console.log(
      `  ${ha.Name.padEnd(15)} ${((maxX - minX) / ppu).toFixed(2).padStart(7)} ${((maxY - minY) / ppu).toFixed(2).padStart(8)}`,
      `${((minX + maxX) / 2 / ppu).toFixed(2).padStart(7)} ${((minY + maxY) / 2 / ppu).toFixed(2).padStart(7)}`,
      ` ${String(D.opacities[di]).padStart(4)}`,
    )
  }
}
finish()
