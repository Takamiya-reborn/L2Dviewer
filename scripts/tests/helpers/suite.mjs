/**
 * 极简断言套件：各 test_*.mjs 复用同一套 ok/FAIL 行格式与退出码约定
 * （0 全过 / 1 有失败），run_all.mjs 只看退出码汇总。
 */
export function suite(title) {
  let pass = 0
  let fail = 0
  return {
    check(name, cond) {
      console.log(cond ? `  ok  ${name}` : `FAIL  ${name}`)
      cond ? pass++ : fail++
    },
    finish() {
      console.log(
        fail
          ? `\n${title}：${fail} 项失败 / ${pass} 项通过`
          : `\n${title}：全部通过（${pass} 项）`,
      )
      process.exit(fail ? 1 : 0)
    },
  }
}
