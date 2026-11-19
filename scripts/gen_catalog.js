// 皮肤目录生成：ship_skin_template.lua 与 hashes-live2d.csv 取交集 -> public/catalog.json
// （显示名 -> bundle 名映射，纯名字元数据，提交进仓库供前端目录列表使用）。
//
// 用法:
//     node scripts/gen_catalog.js
//
// 前置（缺文件时会提示）:
//     node scripts/pull_lua.js                 # .tmp/lua/CN/ 模板快照 + name_code.lua 代换表 + ship_data_statistics.lua 阵营表
//     node scripts/pull_bundles.js --index     # .tmp/hashes-live2d.csv、.tmp/version-live2d.txt
//
// 过滤判据是 painting 与设备侧 live2d 索引精确全等（skin_type 语义混杂不承担判别）。
// 游戏版本更新后通常经 scripts/update.js（npm run update）一键重跑全链路；单独重排目录时直接跑本脚本。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

import { compareSkinNames } from './dev/models.js'
import { readAllSkinTemplates } from './extract/lua.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE_PATH = resolve(ROOT, '.tmp', 'lua', 'CN', 'sharecfgdata', 'ship_skin_template.lua')
const NAME_CODE_PATH = resolve(ROOT, '.tmp', 'lua', 'CN', 'sharecfg', 'name_code.lua')
const STATISTICS_PATH = resolve(ROOT, '.tmp', 'lua', 'CN', 'sharecfgdata', 'ship_data_statistics.lua')
const HASHES_PATH = resolve(ROOT, '.tmp', 'hashes-live2d.csv')
const VERSION_PATH = resolve(ROOT, '.tmp', 'version-live2d.txt')
const CATALOG_PATH = resolve(ROOT, 'public', 'catalog.json')

function die(msg) {
    console.error(`错误: ${msg}`)
    process.exit(1)
}

// hashes-live2d.csv 行格式 live2d/<名>,<大小>,<md5>
function readBundleNames(path) {
    return readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => (line.split(',')[0] ?? '').replace(/^live2d\//, '').trim())
        .filter(Boolean)
}

// name_code.lua 条目行格式 pg.base.name_code[<id>] = { name = "舰名", ... }
const NAME_CODE_RE = /pg\.base\.name_code\[(\d+)\] = \{\s*name = "((?:[^"\\]|\\.)*)"/g

/** 解析 {namecode:N} 占位符代换表（如弗莱彻级/雷级共用模板的舰名）；文件缺失返回空表。 */
function readNameCodes(path) {
    if (!existsSync(path)) return new Map()
    const codes = new Map()
    for (const [, id, name] of readFileSync(path, 'utf8').matchAll(NAME_CODE_RE)) {
        codes.set(id, name.replace(/\\(["\\])/g, '$1'))
    }
    return codes
}

// 皮肤名中的运行时占位符（游戏按 name_code 表代换舰名），显示名落盘前代换；缺表保留原样
const NAMECODE_PH_RE = /\{namecode:(\d+)\}/g

function resolveNamecode(name, nameCodes) {
    return name.replace(NAMECODE_PH_RE, (ph, id) => nameCodes.get(id) ?? ph)
}

// ship_data_statistics.lua 条目行格式 _G.pg.base.ship_data_statistics[<id>] = { ... }
const STATISTICS_HEAD_RE = /_G\.pg\.base\.ship_data_statistics\[(\d+)\] = \{/g

/** 解析舰船阵营（nationality）-> 按 ship_group 归并的查询表；文件缺失返回空表。
 *  statistics 键是 group*10+序号，同 group 各变体的 nationality 一致，取首见即可。 */
function readCamps(path) {
    if (!existsSync(path)) return new Map()
    const text = readFileSync(path, 'utf8')
    const matches = [...text.matchAll(STATISTICS_HEAD_RE)]
    const camps = new Map()
    for (let i = 0; i < matches.length; i++) {
        const end = i + 1 < matches.length ? matches[i + 1].index : text.length
        const nat = text.slice(matches[i].index, end).match(/\bnationality = (\d+)/)
        if (!nat) continue
        const group = Math.floor(parseInt(matches[i][1]) / 10)
        if (!camps.has(group)) camps.set(group, parseInt(nat[1]))
    }
    return camps
}

// 模板外 bundle 的派生显示名（大小写不敏感匹配后仍查不到的少数条目才走这里）：
// 先试原样、再剥 _数字，命中模板条目即借它的名字加（改造）后缀；全不命中回退 painting 本名。
function deriveName(painting, byPainting) {
    const candidates = [painting, painting.replace(/_\d+$/, '')]
    for (const candidate of new Set(candidates)) {
        const template = byPainting.get(candidate.toLowerCase())
        if (template?.name) {
            return { name: `${template.name}（改造）`, base: template }
        }
    }
    return { name: painting, base: null }
}

/**
 * 纯函数：模板文本 + bundle 名集合 + 版本号 -> 目录对象。
 * nameCodes 为 {namecode:N} 代换表；camps 为 ship_group -> 阵营(nationality) 表，查不到不落 camp 字段。
 * 查找键统一小写（bundle 名全小写而模板 painting 可能含大写，如 Z46_2 / lafeiII_3）。
 * 同 painting 被多条模板共享时取文件序第一条（与 extract.js 的 readTemplateByPainting 运行时行为一致）。
 * `_hx` 后缀 bundle 是 CN 审核用的和谐变体（客户端 HXSet.isHx() 时改拉），不收录，目录只保留非和谐版本。
 */
export function buildCatalog(templateText, bundleNames, gameVersion, nameCodes = new Map(), camps = new Map()) {
    const byPainting = new Map()
    for (const template of readAllSkinTemplates(templateText)) {
        if (!template.painting) continue
        const key = template.painting.toLowerCase()
        if (!byPainting.has(key)) byPainting.set(key, template)
    }

    const entries = []
    const usedNames = new Set()
    for (const painting of bundleNames) {
        if (painting.endsWith('_hx')) continue
        let entry
        let shipGroup
        const template = byPainting.get(painting.toLowerCase())
        if (template) {
            shipGroup = template.ship_group
            entry = {
                painting,
                name: template.name || painting,
                ship_group: template.ship_group,
                skin_id: template.id,
            }
        } else {
            const derived = deriveName(painting, byPainting)
            shipGroup = derived.base?.ship_group
            entry = { painting, name: derived.name, derived: true }
        }
        if (entry.ship_group === undefined) delete entry.ship_group
        if (shipGroup !== undefined && camps.has(shipGroup)) entry.camp = camps.get(shipGroup)
        entry.name = resolveNamecode(entry.name, nameCodes)
        if (usedNames.has(entry.name)) entry.name = `${entry.name}（${painting}）`
        usedNames.add(entry.name)
        entries.push(entry)
    }
    entries.sort((a, b) => compareSkinNames(a.name, b.name) || a.painting.localeCompare(b.painting))
    return gameVersion ? { version: gameVersion, entries } : { entries }
}

function main() {
    for (const [path, hint] of [
        [TEMPLATE_PATH, 'node scripts/pull_lua.js'],
        [HASHES_PATH, 'node scripts/pull_bundles.js --index'],
    ]) {
        if (!existsSync(path)) die(`缺少 ${path}，先跑 ${hint}`)
    }
    const version = existsSync(VERSION_PATH) ? readFileSync(VERSION_PATH, 'utf8').trim() : undefined
    const catalog = buildCatalog(
        readFileSync(TEMPLATE_PATH, 'utf8'),
        readBundleNames(HASHES_PATH),
        version,
        readNameCodes(NAME_CODE_PATH),
        readCamps(STATISTICS_PATH),
    )
    writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2))
    console.log(`目录 ${catalog.entries.length} 条（版本 ${version ?? '未知'}）-> ${CATALOG_PATH}`)
}

// 允许单测 import buildCatalog 而不触发落盘
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
