// 测试入口：串行跑 scripts/tests 下全部 test_*.mjs，按退出码汇总。
// 用法：node scripts/tests/run_all.mjs [名字子串...] [--fail-fast|-f]
// （从仓库根目录跑，各测试按相对路径读 models/、public/libs）。
// 各测试的 SUMMARY pass=N fail=M 行被解析进汇总；没打的显示 —。
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const failFast = args.includes('--fail-fast') || args.includes('-f')
const filter = args.filter((s) => !s.startsWith('-'))

const all = fs
  .readdirSync(here)
  .filter((f) => /^test_.*\.mjs$/.test(f))
  .sort()
const tests = all.filter((f) => filter.every((s) => f.includes(s)))

if (!tests.length) {
  console.log('没有匹配的测试文件。可用测试：\n' + all.map((f) => `  ${f}`).join('\n'))
  process.exit(1)
}

const results = []
const t0 = Date.now()
let stop = false
for (const f of tests) {
  console.log(`\n===== ${f} =====`)
  const start = Date.now()
  const r = spawnSync(process.execPath, [path.join(here, f)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  // stdout 捕获后原样回显（spawnSync 本就阻塞，观感与 inherit 相同），
  // 顺带解析末尾的 SUMMARY 行进汇总
  const out = r.stdout ? r.stdout.toString() : ''
  process.stdout.write(out)
  const m = out.match(/SUMMARY pass=(\d+) fail=(\d+)/)
  results.push([
    f,
    r.status,
    m ? `${m[1]}过/${m[2]}败` : '—',
    `${((Date.now() - start) / 1000).toFixed(1)}s`,
  ])
  if (r.status !== 0 && failFast) {
    console.log('\n--fail-fast：首个失败文件后停止，剩余不跑')
    stop = true
    break
  }
}

console.log('\n===== 汇总 =====')
let fail = 0
for (const [f, status, count, sec] of results) {
  console.log(`${status === 0 ? '  ok  ' : 'FAIL  '}${f}（${count}，${sec}）`)
  if (status !== 0) fail++
}
const skipped = stop ? tests.length - results.length : 0
if (skipped) console.log(`（跳过 ${skipped} 个未跑）`)
console.log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
process.exit(fail ? 1 : 0)
