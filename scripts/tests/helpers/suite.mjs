/**
 * 极简断言套件：各 test_*.mjs 复用同一套 ok/FAIL 行格式与退出码约定
 * （0 全过 / 1 有失败），run_all.mjs 看退出码汇总、解析 SUMMARY 行出计数。
 *
 * 断言三件套（解构出来用，内部不走 this）：
 * - check(name, cond, detail?)  布尔断言，失败时同行追加 detail（可 grep）
 * - eq(name, actual, expected)  严格/深比较，失败自动打印实际 vs 期望
 * - near(name, actual, expected, eps?)  浮点比较（各文件手写 Math.abs 的收编）
 * section(title) 打分组行，可选。
 */

/** 值格式化：JSON 截断，超 160 字符加省略号（undefined/函数 JSON 不出，特殊处理） */
function fmt(v) {
  let s
  try {
    s = typeof v === 'function' ? String(v) : JSON.stringify(v) ?? String(v)
  } catch {
    s = String(v)
  }
  return s.length > 160 ? `${s.slice(0, 160)}…` : s
}

/** 深比较：数组逐项、平面对象逐键，其余走 Object.is */
function deepEq(a, b) {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEq(x, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => deepEq(a[k], b[k]))
  }
  return false
}

export function suite(title) {
  let pass = 0
  let fail = 0
  const failed = []

  function check(name, cond, detail) {
    console.log(cond ? `  ok  ${name}` : `FAIL  ${name}${detail ? `（${detail}）` : ''}`)
    if (cond) pass++
    else {
      fail++
      failed.push(name)
    }
  }

  return {
    check,
    eq(name, actual, expected) {
      const ok = deepEq(actual, expected)
      check(name, ok, ok ? undefined : `实际 ${fmt(actual)}，期望 ${fmt(expected)}`)
    },
    near(name, actual, expected, eps = 1e-9) {
      const ok =
        typeof actual === 'number' &&
        typeof expected === 'number' &&
        Math.abs(actual - expected) < eps
      check(name, ok, ok ? undefined : `实际 ${fmt(actual)}，期望 ${fmt(expected)}（±${eps}）`)
    },
    section(title2) {
      console.log(`\n--- ${title2} ---`)
    },
    finish() {
      console.log(
        fail
          ? `\n${title}：${fail} 项失败 / ${pass} 项通过\n失败项：${failed.join('、')}`
          : `\n${title}：全部通过（${pass} 项）`,
      )
      console.log(`SUMMARY pass=${pass} fail=${fail}`)
      process.exit(fail ? 1 : 0)
    },
  }
}
