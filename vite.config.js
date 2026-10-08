import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * 扫描 public/models/<角色>/<皮肤>/<皮肤>.model3.json，自动生成皮肤清单。
 * id 与显示名都取皮肤目录名，新增皮肤只需把目录丢进 public/models 重启 dev。
 */
function modelsManifest() {
  const VIRTUAL = 'virtual:models'
  const modelsDir = join(import.meta.dirname, 'public/models')

  function scan() {
    const models = []
    for (const char of readdirSync(modelsDir, { withFileTypes: true })) {
      if (!char.isDirectory()) continue
      for (const skin of readdirSync(join(modelsDir, char.name), { withFileTypes: true })) {
        const id = skin.name
        if (!skin.isDirectory()) continue
        if (!existsSync(join(modelsDir, char.name, id, `${id}.model3.json`))) continue
        models.push({ id, name: id, url: `/models/${char.name}/${id}/${id}.model3.json` })
      }
    }
    models.sort((a, b) => a.id.localeCompare(b.id))
    return models
  }

  return {
    name: 'models-manifest',
    resolveId(id) {
      if (id === VIRTUAL) return '\0' + VIRTUAL
    },
    load(id) {
      if (id === '\0' + VIRTUAL) {
        return `export const MODELS = ${JSON.stringify(scan(), null, 2)}\n`
      }
    },
  }
}

/**
 * 禁止构建：build 会把 public/models 下的游戏资产原样打进 dist/，
 * 产物一旦对外提供即构成资源再分发。本仓库仅限本地开发运行；
 * 确需本地构建调试时显式放行：ALLOW_BUILD=1 npm run build。
 */
function noBuild() {
  return {
    name: 'no-build',
    configResolved(resolved) {
      if (resolved.command === 'build' && process.env.ALLOW_BUILD !== '1') {
        throw new Error(
          '本项目禁止构建（dist/ 会包含 public/models 下的游戏资产，不得分发）。' +
          '如确需本地构建调试，使用 ALLOW_BUILD=1 npm run build，产物仅限本机使用。',
        )
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), modelsManifest(), noBuild()],
})
