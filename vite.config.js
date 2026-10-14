import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const MIME = {
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
function compareSkinNames(a, b) {
  const da = nameClass(a[0])
  const db = nameClass(b[0])
  if (da !== db) return da - db
  if (da === 3) return a.localeCompare(b, 'zh')
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  return la < lb ? -1 : la > lb ? 1 : 0
}

/**
 * 扫描 models/<角色>/<皮肤>/<皮肤>.model3.json，生成皮肤清单。
 * 显示名取 <皮肤>.l2d.json 的 name（extract.py 烘焙的游戏内皮肤名），
 * 没有烘焙文件的皮肤回退目录名。新增皮肤把目录丢进 models/ 刷新页面即生效。
 */
function scanModels(modelsDir) {
  const models = []
  for (const char of existsSync(modelsDir) ? readdirSync(modelsDir, { withFileTypes: true }) : []) {
    if (!char.isDirectory()) continue
    for (const skin of readdirSync(join(modelsDir, char.name), { withFileTypes: true })) {
      const id = skin.name
      if (!skin.isDirectory()) continue
      const dir = join(modelsDir, char.name, id)
      if (!existsSync(join(dir, `${id}.model3.json`))) continue
      let name = id
      try {
        name = JSON.parse(readFileSync(join(dir, `${id}.l2d.json`), 'utf8')).name || id
      } catch { } // 烘焙文件缺失/损坏时静默回退目录名
      models.push({ id, name, url: `/models/${char.name}/${id}/${id}.model3.json` })
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
function serveModels() {
  const modelsDir = resolve(import.meta.dirname, 'models')
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

/**
 * 探针外挂的装载口：/probes/* 直接伺服 scripts/tests/probe/ 下的模块。
 * 浏览器控制台 import('/probes/<名>.mjs') 即在页面上下文执行——探针保持真
 * 模块（语法高亮/可 lint），主代码只提供装载路径，不含任何探针逻辑。
 */
function serveProbes() {
  const probesDir = resolve(import.meta.dirname, 'scripts/tests/probe')
  return {
    name: 'serve-probes',
    configureServer(server) {
      server.middlewares.use('/probes', (req, res, next) => {
        // 挂载后 req.url 已去掉 /probes 前缀；normalize 以 / 开头可吞掉越级 ..
        const rel = decodeURIComponent(req.url.split('?')[0])
        const file = resolve(probesDir, '.' + join('/', rel))
        const inside = file === probesDir || file.startsWith(probesDir + sep)
        if (!inside || !existsSync(file) || !statSync(file).isFile()) return next()
        res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-cache')
        createReadStream(file).pipe(res)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), serveModels(), serveProbes()],
})
