import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { catalogApi } from './scripts/dev/api.js'
import { MIME, serveModels } from './scripts/dev/models.js'

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
  plugins: [vue(), serveModels(), serveProbes(), catalogApi()],
})
