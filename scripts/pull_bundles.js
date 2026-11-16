// 碧蓝航线 L2D 资源 adb 拉取器：设备 files/AssetBundles/live2d -> .tmp/bundles/。
//
// 用法:
//     node scripts/pull_bundles.js <skin_id>...   # 按皮肤 id 拉取（_hx 为改造/婚变体）
//     ... --all                                   # 拉取全部 bundle（先预览总量，需确认）
//     ... --list [关键词]                         # 只列出远端 bundle（可按关键词过滤）
//     ... --index                                 # 只更新 .tmp/ 下的索引缓存
//
// 选项:
//     --host [host:port] 先 adb connect（模拟器地址）
//     --serial ADDR   指定 adb -s 设备（仅多台不同设备时需要；同一设备多路连接自动收敛）
//     --package PKG   手动指定游戏包名（默认从 pm list packages 里自动匹配 azurlane）
//     --dest DIR      bundle 落盘目录（默认 .tmp/bundles/）
//     --force         本地已存在也重拉（默认大小一致即跳过，可断点续传）
//
// 说明:
//     - 索引文件 hashes-live2d.csv / version-live2d.txt 随任何拉取动作一并更新到 .tmp/（--list 除外）。
//     - 其他资源类别（语音、立绘等）同构清单换 --package 外的类别名不在本脚本范围，按 docs/azurlane.md 手动 pull 即可
//     - 以数组参数调用 adb.exe，不受 Git Bash 的 MSYS 路径转换影响，不需要 `//` 前缀

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ADB = resolve(ROOT, 'tools', 'adb', 'adb.exe')

const REMOTE_FILES_DIR = 'files/AssetBundles/live2d'
const INDEX_FILES = ['hashes-live2d.csv', 'version-live2d.txt']

// ls -l 行：权限开头，倒数第 3/4 列附近是大小与日期；用日期 token 定位大小
const LSL_DATE = /^\d{4}-\d{2}-\d{2}$/

function die(msg) {
    console.error(`错误: ${msg}`)
    process.exit(1)
}

function adb(args, serial = null) {
    const cmd = [ADB]
    if (serial) cmd.push('-s', serial)
    cmd.push(...args)
    const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'buffer' })
    const out = r.stdout ? r.stdout.toString('utf8') : ''
    const err = r.stderr ? r.stderr.toString('utf8') : ''
    if (r.status !== 0) {
        die(`adb ${args.join(' ')} 失败:\n${err.trim() || out.trim()}`)
    }
    return out
}

// 取设备硬件序列号，把同一设备的多路连接（USB/TCP/无线调试）归并到一起
function deviceIdentity(serial) {
    for (const prop of ['ro.serialno', 'ro.boot.serialno']) {
        const out = adb(['shell', 'getprop', prop], serial).trim()
        if (out) return out
    }
    return serial
}

// 不指定 --serial 时自动选定设备；同一物理设备的重复条目收敛为一台
function resolveSerial(explicit, host) {
    if (explicit) return explicit
    const out = adb(['devices', '-l'])
    const entries = []
    for (const ln of out.replace(/\r/g, '').split('\n')) {
        const parts = ln.trim().split(/\s+/)
        if (parts.length >= 2 && ['device', 'offline', 'unauthorized'].includes(parts[1])) {
            entries.push([parts[0], parts[1]])
        }
    }
    const online = entries.filter(([, st]) => st === 'device').map(([s]) => s)
    if (!online.length) {
        const states = entries.map(([s, st]) => `${s}(${st})`).join(', ') || '列表为空'
        die(`没有处于 device 状态的设备（${states}）；模拟器请先 --host 连接`)
    }
    const groups = new Map()
    for (const s of online) {
        const id = deviceIdentity(s)
        if (!groups.has(id)) groups.set(id, [])
        groups.get(id).push(s)
    }
    if (groups.size > 1) {
        const listing = online.map((s) => `  ${s}`).join('\n')
        die(`检测到多台不同设备，请用 --serial 指定其一:\n${listing}`)
    }
    const cands = groups.values().next().value
    if (host && cands.includes(host)) return host
    // 同一设备 USB/TCP 并存时优先 USB（serial 不含冒号），拉取更快更稳
    cands.sort((a, b) => (a.includes(':') === b.includes(':') ? a.localeCompare(b) : a.includes(':') ? 1 : -1))
    const chosen = cands[0]
    if (cands.length > 1) {
        const others = cands.filter((s) => s !== chosen).join(', ')
        console.log(`多路连接收敛到 ${chosen}（其余: ${others}）`)
    }
    return chosen
}

// 从 `ls -l` 一行解析字节大小，解析失败返回 null
function remoteSize(lslLine) {
    const tokens = lslLine.split(/\s+/)
    for (let i = 0; i < tokens.length; i++) {
        if (LSL_DATE.test(tokens[i]) && i >= 1) {
            return /^\d+$/.test(tokens[i - 1]) ? Number(tokens[i - 1]) : null
        }
    }
    return null
}

// 返回 [{name, size}]（size 可为 null）
function listRemoteBundles(serial, pkg, keyword) {
    const remote = `/sdcard/Android/data/${pkg}/${REMOTE_FILES_DIR}`
    const out = adb(['shell', 'ls', '-l', remote], serial)
    const bundles = []
    for (const line of out.replace(/\r/g, '').split('\n')) {
        const name = line.trim().split(/\s+/).pop() ?? ''
        if (!name || name.startsWith('total')) continue
        if (keyword && !name.toLowerCase().includes(keyword.toLowerCase())) continue
        bundles.push({ name, size: remoteSize(line) })
    }
    return bundles
}

function detectPackage(serial, override) {
    if (override) return override
    const out = adb(['shell', 'pm', 'list', 'packages'], serial)
    const pkgs = out
        .replace(/\r/g, '')
        .split('\n')
        .filter((ln) => ln.startsWith('package:') && ln.toLowerCase().includes('azurlane'))
        .map((ln) => ln.split(':', 2)[1])
    if (!pkgs.length) die('未在 pm list packages 中找到 azurlane 相关包名，请用 --package 手动指定')
    if (pkgs.length > 1) die(`找到多个候选包名 [${pkgs.join(', ')}]，请用 --package 指定其一`)
    return pkgs[0]
}

function pullOne(remote, local, serial) {
    adb(['pull', remote, local], serial)
}

function syncIndex(serial, pkg, tmp) {
    for (const name of INDEX_FILES) {
        const local = resolve(tmp, name)
        try {
            pullOne(`/sdcard/Android/data/${pkg}/files/${name}`, local, serial)
            console.log(`索引 ${name} -> ${local}`)
        } catch {
            console.error(`警告: 索引 ${name} 拉取失败（可能设备上不存在），跳过`)
        }
    }
}

// 解析 CLI 参数；--list 无值时记空串（与有值/缺省三态区分）
function parseArgs(argv) {
    const args = {
        skinIds: [],
        all: false,
        list: null, // null=未给，''=裸 --list，字符串=带关键词
        index: false,
        host: null,
        serial: null,
        package: null,
        dest: resolve(ROOT, '.tmp', 'bundles'),
        force: false,
    }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        const next = argv[i + 1]
        switch (a) {
            case '--all': args.all = true; break
            case '--list':
                if (next !== undefined && !next.startsWith('--')) args.list = argv[++i]
                else args.list = ''
                break
            case '--index': args.index = true; break
            case '--host': args.host = argv[++i]; break
            case '--serial': args.serial = argv[++i]; break
            case '--package': args.package = argv[++i]; break
            case '--dest': args.dest = argv[++i]; break
            case '--force': args.force = true; break
            default:
                if (a.startsWith('--')) die(`未知参数: ${a}`)
                args.skinIds.push(a)
        }
    }
    return args
}

async function main() {
    const args = parseArgs(process.argv.slice(2))

    if (!existsSync(ADB)) die(`未找到 ${ADB}`)
    if (args.host) console.log(adb(['connect', args.host]).trim())
    if (!args.skinIds.length && !args.all && args.list === null && !args.index) {
        die('需要皮肤 id 或 --all / --list / --index 之一')
    }

    const serial = resolveSerial(args.serial, args.host)
    const pkg = detectPackage(serial, args.package)
    console.log(`包名: ${pkg}`)

    const tmp = resolve(ROOT, '.tmp')
    mkdirSync(tmp, { recursive: true })
    mkdirSync(args.dest, { recursive: true })

    if (args.list !== null) {
        const bundles = listRemoteBundles(serial, pkg, args.list || null)
        for (const { name, size } of bundles) {
            console.log(size !== null ? `${String(size).padStart(12)}  ${name}` : `${'?'.padStart(12)}  ${name}`)
        }
        console.error(`-- 共 ${bundles.length} 个`)
        return
    }

    if (!args.index) {
        const bundles = listRemoteBundles(serial, pkg)
        const byName = new Map(bundles.map((b) => [b.name, b.size]))
        let targets
        if (args.all) {
            targets = [...byName.keys()].sort()
            const total = bundles.reduce((s, b) => s + (b.size ?? 0), 0)
            console.log(`远端共 ${targets.length} 个 bundle，合计 ${(total / 1e6).toFixed(1)} MB`)
            if (total > 100e6) {
                const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
                const answer = (await rl.question('确认全部拉取? [y/N] ')).trim().toLowerCase()
                rl.close()
                if (answer !== 'y') die('已取消')
            }
        } else {
            const missing = args.skinIds.filter((n) => !byName.has(n))
            if (missing.length) die(`远端不存在: [${missing.join(', ')}]（用 --list 查看可用皮肤 id）`)
            targets = args.skinIds
        }

        let ok = 0, fail = 0, skip = 0
        for (const name of targets) {
            const local = resolve(args.dest, name)
            const rsize = byName.get(name)
            if (!args.force && existsSync(local) && (rsize === null || statSync(local).size === rsize)) {
                skip++
                continue
            }
            try {
                pullOne(`/sdcard/Android/data/${pkg}/${REMOTE_FILES_DIR}/${name}`, local, serial)
                ok++
                console.log(`拉取 ${name} (${(statSync(local).size / 1e6).toFixed(1)} MB)`)
            } catch {
                fail++
                console.error(`失败 ${name}`)
            }
        }
        console.log(`完成: 拉取 ${ok}，跳过 ${skip}，失败 ${fail} -> ${args.dest}`)
    }

    syncIndex(serial, pkg, tmp)
}

main()
