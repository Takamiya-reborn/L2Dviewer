/** 皮肤目录/JSON 读取小工具（probe 与 helper 共用）。 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

/** 目标解析为皮肤目录：给目录用目录，给文件（moc3/json）取所在目录 */
export function resolveModelDir(target) {
  return fs.existsSync(target) && fs.statSync(target).isDirectory()
    ? target
    : path.dirname(target)
}

/** 皮肤名解析为目录：models/ 下递归找 <name>.model3.json；给实际存在的路径则透传 resolveModelDir */
export function resolveSkin(target) {
  if (fs.existsSync(target)) return resolveModelDir(target)
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  const hits = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === `${target}.model3.json`) hits.push(path.dirname(p))
    }
  }
  walk(path.join(root, 'models'))
  if (hits.length !== 1) throw new Error(`皮肤 ${target} 解析失败（${hits.length} 处命中；也可直接给皮肤目录路径）`)
  return hits[0]
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** 分区名归一化（查看器机器路由同款）：toLowerCase + 剔除非字母数字 */
export function normalizeZone(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '')
}
