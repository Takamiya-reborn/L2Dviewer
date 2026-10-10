/** 探针：各模型 drawable 的 textureIndex 分布、part/drawable 计数。
 *
 * 用法（仓库根目录）：
 *   node scripts/tests/probe/drawable_textures.mjs models/wuzang/wuzang_3
 */
import { loadProbeModels } from './model_probe.mjs'

const targets = process.argv.slice(2)
if (!targets.length) {
  console.error('用法: node scripts/tests/probe/drawable_textures.mjs <皮肤目录|moc3> [...]')
  process.exit(1)
}

for (const { model, name } of await loadProbeModels(targets)) {
  const drawables = model.drawables
  const textureCounts = {}
  let maxTextureIndex = 0
  for (const textureIndex of drawables.textureIndices) {
    textureCounts[textureIndex] = (textureCounts[textureIndex] || 0) + 1
    maxTextureIndex = Math.max(maxTextureIndex, textureIndex)
  }
  console.log(`== ${name}`)
  console.log('  drawables:', drawables.count, 'parts:', model.parts.count)
  console.log('  textureIndex 分布:', textureCounts, 'max:', maxTextureIndex)
  const partIds = Array.from(model.parts.ids || [])
  console.log('  parts 样例:', partIds.slice(0, 10), '... 共', partIds.length)
}