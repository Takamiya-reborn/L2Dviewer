// 测试入口：串行跑 scripts/tests 下全部 test_*.mjs，按退出码汇总。
// 用法：node scripts/tests/run_all.mjs [名字子串...]（从仓库根目录跑，
// 各测试按相对路径读 models/、public/libs）。
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const filter = process.argv.slice(2)

const tests = fs
  .readdirSync(here)
  .filter((f) => /^test_.*\.mjs$/.test(f))
  .filter((f) => filter.every((s) => f.includes(s)))
  .sort()

if (!tests.length) {
  console.log('没有匹配的测试文件')
  process.exit(1)
}

const results = []
for (const f of tests) {
  console.log(`\n===== ${f} =====`)
  const r = spawnSync(process.execPath, [path.join(here, f)], { stdio: 'inherit' })
  results.push([f, r.status])
}

console.log('\n===== 汇总 =====')
let fail = 0
for (const [f, status] of results) {
  console.log(`${status === 0 ? '  ok  ' : 'FAIL  '}${f}`)
  if (status !== 0) fail++
}
process.exit(fail ? 1 : 0)
