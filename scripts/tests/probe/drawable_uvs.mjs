/** 探针：按 textureIndex 汇总 drawable 的 UV 范围。
 *
 * 用法（仓库根目录）：
 *   node scripts/tests/probe/drawable_uvs.mjs models/wuzang/wuzang_3
 */
import { loadProbeModels } from './model_probe.mjs'

const targets = process.argv.slice(2)
if (!targets.length) {
  console.error('用法: node scripts/tests/probe/drawable_uvs.mjs <皮肤目录|moc3> [...]')
  process.exit(1)
}

for (const { model, name } of await loadProbeModels(targets)) {
  const { vertexUvs, textureIndices } = model.drawables
  const bounds = new Map()
  for (let i = 0; i < textureIndices.length; i++) {
    const textureIndex = textureIndices[i]
    const bound = bounds.get(textureIndex) ?? {
      minU: Infinity,
      maxU: -Infinity,
      minV: Infinity,
      maxV: -Infinity,
    }
    for (let j = 0; j < vertexUvs[i].length; j += 2) {
      bound.minU = Math.min(bound.minU, vertexUvs[i][j])
      bound.maxU = Math.max(bound.maxU, vertexUvs[i][j])
      bound.minV = Math.min(bound.minV, vertexUvs[i][j + 1])
      bound.maxV = Math.max(bound.maxV, vertexUvs[i][j + 1])
    }
    bounds.set(textureIndex, bound)
  }

  console.log(`== ${name}`)
  for (const [textureIndex, bound] of bounds) {
    console.log(
      `  tex${textureIndex}: U[${bound.minU.toFixed(3)},${bound.maxU.toFixed(3)}] ` +
      `V[${bound.minV.toFixed(3)},${bound.maxV.toFixed(3)}]`,
    )
  }
}