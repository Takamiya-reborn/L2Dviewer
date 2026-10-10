/**
 * 皮肤目录/JSON 读取小工具（probe 与 helper 共用）。
 */
import fs from 'fs'
import path from 'path'

/** 目标解析为皮肤目录：给目录用目录，给文件（moc3/json）取所在目录 */
export function resolveModelDir(target) {
  return fs.existsSync(target) && fs.statSync(target).isDirectory()
    ? target
    : path.dirname(target)
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
