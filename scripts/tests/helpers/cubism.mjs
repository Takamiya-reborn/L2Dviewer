/**
 * node 下加载 Cubism Core 与 moc3 模型（真实资产体检用）。
 * 需在仓库根目录跑（相对路径 public/libs、models/）。
 */
import fs from 'fs'
import path from 'path'
import vm from 'vm'

export const CORE_PATH = 'public/libs/live2dcubismcore.min.js'

export function cubismCoreAvailable() {
  return fs.existsSync(CORE_PATH)
}

let corePromise = null

/**
 * 加载 Cubism Core。仓库带的这份构建没有 ccall/就绪探针，wasm 在首个事件轮
 * 才绑定完成——loadMocModel 的 fromArrayBuffer 重试负责吸收这一延迟。
 */
export function loadCubismCore() {
  corePromise ??= (async () => {
    globalThis.window ??= globalThis
    globalThis.self ??= globalThis
    globalThis.document ??= {}
    vm.runInThisContext(fs.readFileSync(CORE_PATH, 'utf8'), {
      filename: 'live2dcubismcore.min.js',
    })
    return globalThis.Live2DCubismCore
  })()
  return corePromise
}

/**
 * 加载 <dir> 下的 moc3 模型。
 * @returns { model, model3, defaults, name } model3/defaults 缺文件时为 null
 */
export async function loadMocModel(dir) {
  const Core = await loadCubismCore()
  const files = fs.readdirSync(dir)
  const mocFile = files.find((f) => f.endsWith('.moc3'))
  if (!mocFile) throw new Error(`${dir} 下没有 moc3`)
  const name = mocFile.replace(/\.moc3$/, '')
  const buf = fs.readFileSync(path.join(dir, mocFile))
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  // wasm 异步初始化完成前 fromArrayBuffer 会抛错，重试到成功
  let model = null
  let lastErr
  for (let t = 0; t < 100; t++) {
    try {
      model = Core.Model.fromMoc(Core.Moc.fromArrayBuffer(ab))
      break
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  if (!model) throw lastErr
  const model3File = files.find((f) => f.endsWith('.model3.json'))
  const defaultsFile = files.find((f) => f.endsWith('.defaults.json'))
  return {
    model,
    model3: model3File
      ? JSON.parse(fs.readFileSync(path.join(dir, model3File), 'utf8'))
      : null,
    defaults: defaultsFile
      ? JSON.parse(fs.readFileSync(path.join(dir, defaultsFile), 'utf8'))
      : null,
    name,
  }
}
