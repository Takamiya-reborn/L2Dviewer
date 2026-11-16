// Il2Cpp ARM64 反汇编与地址查询工具。
//
// 用法:
//     node scripts/disasm.js 0x391F018 0x1DC
//     node scripts/disasm.js window 0x391F018 0x1DC
//     node scripts/disasm.js addr 0x1234 0x5678
//     node scripts/disasm.js live2dchar
//     node scripts/disasm.js live2dchar Drag,Get
//
// 默认读取 .tmp/cs/libil2cpp.so、.tmp/cs/dump/dump.cs 和 .tmp/cs/dump/script.json，
// 相关文件由 pull_cs.js 生成。

import capstoneFactory from '@alexaltea/capstone-js'
import { openSync, closeSync, fstatSync, readSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SO = resolve(ROOT, '.tmp', 'cs', 'libil2cpp.so')
const DUMP = resolve(ROOT, '.tmp', 'cs', 'dump', 'dump.cs')
const SCRIPT_JSON = resolve(ROOT, '.tmp', 'cs', 'dump', 'script.json')
const MAX_WINDOW = 0x4000

// ARM64 小端反汇编：输出行与窗口序一致（address/mnemonic/op_str）
async function disassemble(data, address) {
    const cs = await capstoneFactory()
    const md = new cs.Capstone(cs.ARCH_ARM64, cs.MODE_LITTLE_ENDIAN)
    const lines = md
        .disasm(data, address)
        .map((ins) => `0x${ins.address.toString(16)}:\t${ins.mnemonic}\t${ins.op_str}`)
    md.close()
    return lines.join('\n')
}

// 只读 so 文件的指定区段，不整包载入内存
function readSoRange(offset, size) {
    const fd = openSync(SO, 'r')
    try {
        const fileSize = fstatSync(fd).size
        const start = Math.max(0, offset)
        const len = Math.min(size, fileSize - start)
        const buf = Buffer.alloc(len)
        readSync(fd, buf, 0, len, start)
        return buf
    } finally {
        closeSync(fd)
    }
}

function disassembleWindow(offset, size) {
    return disassemble(readSoRange(offset, size), offset)
}

function lookupAddresses(addresses) {
    const data = JSON.parse(readFileSync(SCRIPT_JSON, 'utf8'))
    const methods = data.ScriptMethod ?? []
    const byAddr = new Map()
    for (const method of methods) {
        const raw = method.Address
        const address = typeof raw === 'string' ? parseInt(raw, 0) : raw
        byAddr.set(address, method.Name)
    }
    const sorted = [...byAddr.keys()].sort((a, b) => a - b)

    for (const address of addresses) {
        let name = byAddr.get(address)
        if (!name) {
            const lower = sorted.filter((v) => v <= address)
            const higher = sorted.filter((v) => v > address)
            let near = ''
            if (lower.length && higher.length && address - lower[lower.length - 1] < 0x200) {
                const prev = lower[lower.length - 1]
                near = `  (前一个方法: ${byAddr.get(prev)} @0x${prev.toString(16).toUpperCase()}, 距离 0x${(address - prev).toString(16)})`
            }
            name = `<未知>${near}`
        }
        console.log(`0x${address.toString(16).toUpperCase()} -> ${name}`)
    }
}

function parseLive2dcharMethods() {
    const text = readFileSync(DUMP, 'utf8')
    const marker = 'public class Live2dChar : MonoBehaviour'
    const start = text.indexOf(marker)
    if (start < 0) throw new Error(`dump.cs 里找不到 ${marker}`)
    const end = text.indexOf('\n// Namespace:', start)
    const block = text.slice(start, end)
    const pattern =
        /\/\/ RVA: (0x[0-9A-Fa-f]+) Offset: (0x[0-9A-Fa-f]+)[\s\S]*?\n\t([^\n{]+?)\s*\{ \}/g
    const methods = []
    for (const match of block.matchAll(pattern)) {
        const [, rva, offset, signature] = match
        const name = signature.trim().split('(')[0].split(' ').pop()
        methods.push({ name, offset: parseInt(offset, 16), signature: signature.trim(), rva })
    }
    return methods.sort((a, b) => a.offset - b.offset)
}

async function disassembleLive2dchar(wanted) {
    const methods = parseLive2dcharMethods()
    for (let i = 0; i < methods.length; i++) {
        const { name, offset, signature } = methods[i]
        const nextOffset = i + 1 < methods.length ? methods[i + 1].offset : offset + MAX_WINDOW
        const size = Math.min(nextOffset - offset, MAX_WINDOW)
        if (wanted && !wanted.some((term) => name.includes(term) || signature.includes(term))) {
            continue
        }
        console.log(`\n===== ${name} @ off=0x${offset.toString(16).toUpperCase()} size≈0x${size.toString(16).toUpperCase()} =====`)
        console.log(`  // ${signature}`)
        const output = await disassembleWindow(offset, size)
        if (output) console.log(output)
    }
}

function parseIntAny(value) {
    return parseInt(value, 0)
}

// 解析子命令；首参数不是子命令名时按 window 处理（裸 `disasm <offset> <size>` 语义）
function parseArgs(argv) {
    const commands = ['window', 'addr', 'live2dchar', '-h', '--help']
    const rest = [...argv]
    if (rest.length && !commands.includes(rest[0])) rest.unshift('window')
    if (!rest.length || rest[0] === '-h' || rest[0] === '--help') return null
    const cmd = rest[0]
    const args = rest.slice(1)
    switch (cmd) {
        case 'window':
            if (args.length < 2) throw new Error('window 需要 <offset> <size>')
            return { command: 'window', offset: parseIntAny(args[0]), size: parseIntAny(args[1]) }
        case 'addr':
            if (!args.length) throw new Error('addr 需要至少一个地址')
            return { command: 'addr', addresses: args.map(parseIntAny) }
        case 'live2dchar':
            return {
                command: 'live2dchar',
                wanted: args.length && args[0] ? args[0].split(',') : null,
            }
        default:
            throw new Error(`未知子命令: ${cmd}`)
    }
}

async function main() {
    let parsed
    try {
        parsed = parseArgs(process.argv.slice(2))
    } catch (e) {
        console.error(`错误: ${e.message}`)
        process.exit(1)
    }
    if (!parsed) {
        console.log(
            '用法:\n' +
                '  node scripts/disasm.js window <offset> <size>\n' +
                '  node scripts/disasm.js addr <address...>\n' +
                '  node scripts/disasm.js live2dchar [过滤词]'
        )
        return
    }
    if (parsed.command === 'window') {
        const output = await disassembleWindow(parsed.offset, parsed.size)
        if (output) console.log(output)
    } else if (parsed.command === 'addr') {
        lookupAddresses(parsed.addresses)
    } else if (parsed.command === 'live2dchar') {
        await disassembleLive2dchar(parsed.wanted)
    }
}

main()
