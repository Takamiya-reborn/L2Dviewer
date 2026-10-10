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
  return models.sort((a, b) => a.id.localeCompare(b.id))
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), serveModels()],
})
