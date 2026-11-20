// dev server 的模型静态伺服与皮肤清单扫描，从 vite.config.js 拆出：
// gen_catalog.js 与 scripts/dev/api.js 也要复用 scanModels / compareSkinNames，
// 放这里避免它们反向 import vite.config（会连带拉起 vite 插件链）。

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '..', '..')

export const MIME = {
  '.json': 'application/json',
  '.moc3': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
}

/** 皮肤名首字符归类：0 特殊符号、1 数字、2 字母、3 汉字（含假名）。 */
const nameClass = (ch) => {
  const c = ch.codePointAt(0)
  if (!c) return 0
  if (c >= 0x30 && c <= 0x39) return 1
  if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) return 2
  // 仅表意文字（含扩展区）与假名归汉字组；其余如全角标点归符号
  if ((c >= 0x3400 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff) || c >= 0x20000) return 3
  return 0
}

/**
 * 皮肤名排序：按首字符类别分组，特殊符号 → 数字 → 字母 → 汉字；
 * 同组内符号/数字/字母按字典序（忽略大小写），汉字按 zh 拼音序。
 */
export function compareSkinNames(a, b) {
  const da = nameClass(a[0])
  const db = nameClass(b[0])
  if (da !== db) return da - db
  if (da === 3) return a.localeCompare(b, 'zh')
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  return la < lb ? -1 : la > lb ? 1 : 0
}

/**
 * 扫描 models/<角色>/<皮肤>/，生成皮肤清单。两类皮肤：
 * - L2D：<皮肤>.model3.json 在位，url 指向它；显示名取 <皮肤>.l2d.json 的 name。
 * - Ani（spine）：<皮肤>.spine.json 在位（spineBake.js 产物），url 指向它，条目带 type: 'spine'。
 * 显示名缺失回退目录名。新增皮肤把目录丢进 models/ 刷新页面即生效。
 */
export function scanModels(modelsDir = resolve(ROOT, 'models')) {
  const models = []
  for (const char of existsSync(modelsDir) ? readdirSync(modelsDir, { withFileTypes: true }) : []) {
    if (!char.isDirectory()) continue
    for (const skin of readdirSync(join(modelsDir, char.name), { withFileTypes: true })) {
      const id = skin.name
      if (!skin.isDirectory()) continue
      const dir = join(modelsDir, char.name, id)
      const spine = existsSync(join(dir, `${id}.spine.json`))
      const l2d = existsSync(join(dir, `${id}.model3.json`))
      if (!spine && !l2d) continue
      let name = id
      // 显示名取自元数据文件（l2d.json / spine.json），与挂载 url 无关：
      // L2D 挂载入口恒为 model3.json，spine 挂载入口为 spine.json
      const metaFile = spine ? `${id}.spine.json` : `${id}.l2d.json`
      try {
        name = JSON.parse(readFileSync(join(dir, metaFile), 'utf8')).name || id
      } catch { } // 烘焙文件缺失/损坏时静默回退目录名
      const entry = spine ? `${id}.spine.json` : `${id}.model3.json`
      const url = `/models/${char.name}/${id}/${entry}`
      models.push(spine ? { id, name, url, type: 'spine' } : { id, name, url })
    }
  }
  // 按显示名分组排序（符号→数字→字母→汉字），侧栏顺序与可见文字一致；同名回退 id
  return models.sort(
    (a, b) => compareSkinNames(a.name, b.name) || a.id.localeCompare(b.id),
  )
}

/**
 * 模型放在仓库根目录 models/（游戏资产不入库，也刻意不在 public/ 里）。
 * dev server 用这个中间件把 /models/* 映射过去：manifest.json 每次请求实时
 * 扫描目录生成，其余文件按静态资源直接读盘——不参与构建，也没有清单文件。
 */
export function serveModels() {
  const modelsDir = resolve(ROOT, 'models')
  return {
    name: 'serve-models',
    configureServer(server) {
      server.middlewares.use('/models', (req, res, next) => {
        // 挂载后 req.url 已去掉 /models 前缀；normalize 以 / 开头可吞掉越级 ..
        const rel = decodeURIComponent(req.url.split('?')[0])
        if (rel === '/manifest.json') {
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Cache-Control', 'no-cache')
          return res.end(JSON.stringify(scanModels(modelsDir)))
        }
        const file = resolve(modelsDir, '.' + join('/', rel))
        const inside = file === modelsDir || file.startsWith(modelsDir + sep)
        if (!inside || !existsSync(file) || !statSync(file).isFile()) return next()
        res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
        createReadStream(file).pipe(res)
      })
    },
  }
}
