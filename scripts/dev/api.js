// dev server 的皮肤目录 API：/api/* 仅存在于本机 dev server（vite 默认绑 127.0.0.1）。
// 执行参数只接受 public/catalog.json 白名单内的 painting 名，杜绝任意参数注入 adb/extract 命令行。

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { ROOT, scanModels } from './models.js'

const ADB = resolve(ROOT, 'tools', 'adb', 'adb.exe')
const BUNDLES_DIR = resolve(ROOT, '.tmp', 'bundles')
const CATALOG_PATH = resolve(ROOT, 'public', 'catalog.json')
const MODELS_DIR = resolve(ROOT, 'models')

const PAINTING_RE = /^[a-z0-9_]+$/
const ADB_TIMEOUT = 5000
const PULL_TIMEOUT = 120_000
const EXTRACT_TIMEOUT = 600_000
const LOG_LIMIT = 200

function json(res, code, body) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-cache')
  res.statusCode = code
  res.end(JSON.stringify(body))
}

/** 目录条目状态分类：baked=已烘焙可加载 / cached=bundle 已拉未烘焙 / remote=需从设备拉取。 */
export function classifyState(bakedIds, painting, bundleExists) {
  if (bakedIds.has(painting)) return 'baked'
  return bundleExists ? 'cached' : 'remote'
}

function readCatalog() {
  return JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))
}

// 常见模拟器 adb 端口：AVD/LDPlayer 5555-5559、MuMu 7555/16384、Nox 62001/62025、逍遥 21503。
// 第三方模拟器不向 adb server 自动登记（AVD 例外），设备列表为空时逐口 connect 一次再重查；
// 连接登记持久留在 server 里，非 adb 端口 connect 失败只留 offline 表项不影响后续。
const EMULATOR_PORTS = [5555, 5556, 5557, 5558, 5559, 7555, 16384, 62001, 62025, 21503]
// 端口扫描节流：无在线设备时最快 30s 扫一轮（connect 挂死端口单次最长 ADB_TIMEOUT，不节流会拖死每次查询）
let lastScanAt = 0

// adb devices 解析 + 在线设备补型号。软失败：adb 不存在/超时一律空列表（没设备不是服务器错误）。
function queryDevices() {
  if (!existsSync(ADB)) return []
  let r = spawnSync(ADB, ['devices', '-l'], { encoding: 'utf8', timeout: ADB_TIMEOUT, windowsHide: true })
  if (r.status !== 0 || !r.stdout) return []
  if (!r.stdout.split('\n').some((line) => line.trim().split(/\s+/)[1] === 'device')) {
    if (Date.now() - lastScanAt > 30_000) {
      lastScanAt = Date.now()
      for (const port of EMULATOR_PORTS) {
        spawnSync(ADB, ['connect', `127.0.0.1:${port}`], { timeout: ADB_TIMEOUT, windowsHide: true })
      }
      r = spawnSync(ADB, ['devices', '-l'], { encoding: 'utf8', timeout: ADB_TIMEOUT, windowsHide: true })
      if (r.status !== 0 || !r.stdout) return []
    }
  }
  const devices = []
  for (const line of r.stdout.replace(/\r/g, '').split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 2 && ['device', 'offline', 'unauthorized'].includes(parts[1])) {
      devices.push({ serial: parts[0], state: parts[1], model: null })
    }
  }
  for (const device of devices) {
    if (device.state !== 'device') continue
    const g = spawnSync(ADB, ['-s', device.serial, 'shell', 'getprop', 'ro.product.model'], {
      encoding: 'utf8', timeout: ADB_TIMEOUT, windowsHide: true,
    })
    if (g.status === 0 && g.stdout) device.model = g.stdout.trim()
  }
  return devices
}

// 单任务槽：同一时刻只跑一条"拉取 -> 烘焙"链，前端轮询 /api/job 展示进度。
let job = null

/** hashes-live2d.csv 里该 painting 的远端 bundle 字节大小，查不到返回 null（pull 进度条退化为不定态）。 */
function bundleRemoteSize(painting) {
  try {
    for (const line of readFileSync(resolve(ROOT, '.tmp', 'hashes-live2d.csv'), 'utf8').split('\n')) {
      if ((line.split(',')[0] ?? '').replace(/^live2d\//, '').trim() === painting) {
        return Number(line.split(',')[1]) || null
      }
    }
  } catch { }
  return null
}

/** 跑一条子进程步骤，stdout/stderr 按行进 push（环形截断），onLine 额外解析 stdout 行（进度提取），失败 reject 带 stderr 尾部。 */
function runStep(args, timeout, push, onLine = null) {
  return new Promise((resolveStep, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true })
    const errLines = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeout)
    const wire = (stream, sink) => {
      stream.setEncoding('utf8')
      let buf = ''
      stream.on('data', (chunk) => {
        buf += chunk
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) if (line.trim()) sink(line)
      })
      stream.on('end', () => { if (buf.trim()) sink(buf) })
    }
    wire(child.stdout, (line) => {
      push(line)
      onLine?.(line)
    })
    wire(child.stderr, (line) => {
      push(line)
      errLines.push(line)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return reject(new Error(`${args[1]} 超时（>${timeout / 1000}s），已终止`))
      if (code !== 0) {
        const tail = errLines.slice(-3).join('\n').trim() || '无输出'
        return reject(new Error(`${args[1]} 失败（退出码 ${code}）：\n${tail}`))
      }
      resolveStep()
    })
  })
}

function startJob(painting) {
  const push = (line) => {
    job.log.push(line)
    if (job.log.length > LOG_LIMIT) job.log.splice(0, job.log.length - LOG_LIMIT)
  }
  job = {
    painting, phase: 'pull', status: 'running', log: [], error: null, startedAt: Date.now(),
    progress: { percent: 2, label: '准备拉取' },
  }
  // pull 阶段进度：按本地 bundle 文件增长对比索引里的远端大小轮询；查不到大小则不定态
  const localPath = join(BUNDLES_DIR, painting)
  const remoteSize = bundleRemoteSize(painting)
  const poll = setInterval(() => {
    try {
      const size = statSync(localPath).size
      job.progress = remoteSize
        ? { percent: 2 + Math.min(38, (38 * size) / remoteSize), label: `拉取 bundle ${Math.min(100, Math.round((100 * size) / remoteSize))}%` }
        : { percent: null, label: '拉取 bundle' }
    } catch {
      job.progress = { percent: null, label: '拉取 bundle' }
    }
  }, 800)
  const stopPoll = () => clearInterval(poll)
  runStep(['scripts/pull_bundles.js', painting], PULL_TIMEOUT, push)
    // pull_bundles 自带"本地已存在且大小一致即跳过"，无条件先跑还能顺带刷新设备索引
    .then(() => {
      stopPoll()
      job.phase = 'extract'
      job.progress = { percent: 40, label: '解包烘焙' }
      return runStep(['scripts/extract.js', painting], EXTRACT_TIMEOUT, push, (line) => {
        const m = line.match(/^\[progress\] (\d+) (.+)$/)
        if (m) job.progress = { percent: 40 + Math.round(0.55 * Number(m[1])), label: m[2] }
      })
    })
    .then(() => {
      stopPoll()
      job.phase = 'done'
      job.status = 'done'
      job.progress = { percent: 100, label: '完成' }
    })
    .catch((err) => {
      stopPoll()
      job.status = 'error'
      job.error = err.message
    })
}

export function catalogApi() {
  let catalog = null // 白名单是执行参数的唯一合法来源，静态产物只在首次请求时读一次
  return {
    name: 'catalog-api',
    configureServer(server) {
      server.middlewares.use('/api', (req, res, next) => {
        const route = req.url.split('?')[0]
        if (route === '/catalog' && req.method === 'GET') {
          if (!catalog) catalog = readCatalog()
          const bakedIds = new Set(scanModels(MODELS_DIR).map((m) => m.id))
          const entries = catalog.entries.map((entry) => ({
            ...entry,
            state: classifyState(bakedIds, entry.painting, existsSync(join(BUNDLES_DIR, entry.painting))),
          }))
          return json(res, 200, { version: catalog.version, entries })
        }
        if (route === '/device' && req.method === 'GET') {
          return json(res, 200, { devices: queryDevices() })
        }
        if (route === '/job' && req.method === 'GET') {
          return json(res, 200, job ?? { status: 'idle' })
        }
        if (route === '/extract' && req.method === 'POST') {
          let body = ''
          req.on('data', (chunk) => { body += chunk })
          return req.on('end', () => {
            let painting
            try {
              painting = JSON.parse(body).painting
            } catch {
              return json(res, 400, { error: '请求体不是合法 JSON' })
            }
            if (typeof painting !== 'string' || !PAINTING_RE.test(painting)) {
              return json(res, 400, { error: `非法皮肤名: ${painting}` })
            }
            if (!catalog) catalog = readCatalog()
            if (!catalog.entries.some((e) => e.painting === painting)) {
              return json(res, 400, { error: `皮肤不在目录中: ${painting}` })
            }
            const bakedIds = new Set(scanModels(MODELS_DIR).map((m) => m.id))
            if (bakedIds.has(painting)) return json(res, 409, { error: '该皮肤已烘焙，直接点击加载即可' })
            if (job && job.status === 'running') return json(res, 409, { error: '已有烘焙任务进行中，请稍候', job })
            startJob(painting)
            return json(res, 200, { ok: true, job })
          })
        }
        return next()
      })
    },
  }
}
