import { loadMocModel } from '../helpers/cubism.mjs'

// 转出口：既有 probe 一直从这里 import，实际实现在 helpers/model_files.mjs
import { resolveModelDir, readJson } from '../helpers/model_files.mjs'
export { resolveModelDir, readJson }

export function normalizeZone(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function drawableBounds(drawables, index) {
  const vertices = drawables.vertexPositions[index]
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < vertices.length; i += 2) {
    minX = Math.min(minX, vertices[i])
    maxX = Math.max(maxX, vertices[i])
    minY = Math.min(minY, vertices[i + 1])
    maxY = Math.max(maxY, vertices[i + 1])
  }
  return { minX, minY, maxX, maxY }
}

export async function loadProbeModels(targets) {
  const models = []
  for (const target of targets) {
    const dir = resolveModelDir(target)
    models.push({ dir, ...(await loadMocModel(dir)) })
  }
  return models
}