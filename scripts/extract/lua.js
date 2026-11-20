// Lua 快照解析与 ship_l2d 配置烘焙：解析社区快照中的规范 Lua 表，
// 按皮肤 id 归集 ship_l2d 条目并落模型目录内的 l2d.json。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const LUA_ENTRY_RE = /^\tpg\.base\.ship_l2d\[(\d+)\] = \{$/gm
const LUA_TEMPLATE_RE = /^_G\.pg\.base\.ship_skin_template\[(\d+)\] = \{$/gm
const LUA_IDENT_RE = /[A-Za-z_]\w*/y

// 解析社区快照中的规范 Lua 表
class LuaParser {
    constructor(text) {
        this.text = text
        this.pos = 0
    }

    parse() {
        return this.value()
    }

    skip() {
        while (this.pos < this.text.length && ' \t\r\n'.includes(this.text[this.pos])) this.pos++
    }

    value() {
        this.skip()
        const char = this.text[this.pos]
        if (char === '{') return this.table()
        if (char === '"') {
            let end = this.pos + 1
            // 逐字符扫描，反斜杠连同转义字符一起跳过，避免 \" 提前截断字符串
            while (end < this.text.length && this.text[end] !== '"') {
                if (this.text[end] === '\\') end++
                end++
            }
            const value = this.text.slice(this.pos + 1, end).replace(/\\(["\\])/g, '$1')
            this.pos = end + 1
            return value
        }
        const rest = this.text.slice(this.pos)
        const number = rest.match(/^[-+0-9.eE]+/)
        if (number) {
            const value = number[0]
            this.pos += value.length
            return value.includes('.') || value.toLowerCase().includes('e') ? parseFloat(value) : parseInt(value)
        }
        for (const [word, val] of [['true', true], ['false', false], ['nil', null]]) {
            if (this.text.startsWith(word, this.pos)) {
                this.pos += word.length
                return val
            }
        }
        throw new Error(`无法解析 Lua 值: ${JSON.stringify(this.text.slice(this.pos, this.pos + 40))}`)
    }

    table() {
        this.pos += 1
        const table = {}
        const array = []
        for (;;) {
            this.skip()
            if (this.pos >= this.text.length) throw new Error('Lua 表在闭合前结束')
            if (this.text[this.pos] === '}') {
                this.pos += 1
                return array.length ? array : table
            }
            LUA_IDENT_RE.lastIndex = this.pos
            const ident = LUA_IDENT_RE.exec(this.text)
            if (ident) {
                const save = this.pos
                this.pos = ident.index + ident[0].length
                this.skip()
                if (this.pos < this.text.length && this.text[this.pos] === '=') {
                    this.pos += 1
                    table[ident[0]] = this.value()
                    this.comma()
                    continue
                }
                this.pos = save
            }
            array.push(this.value())
            this.comma()
        }
    }

    comma() {
        this.skip()
        if (this.pos < this.text.length && this.text[this.pos] === ',') this.pos += 1
    }
}

function luaBlock(text, matches, index) {
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length
    return new LuaParser(`{${text.slice(matches[index].index + matches[index][0].length, end)}`).parse()
}

function readSkinTemplate(text, skinId) {
    const matches = [...text.matchAll(LUA_TEMPLATE_RE)]
    for (let index = 0; index < matches.length; index++) {
        if (parseInt(matches[index][1]) === skinId) return luaBlock(text, matches, index)
    }
    throw new Error(`ship_skin_template 中没有皮肤 ${skinId}`)
}

export function readTemplateByPainting(text, painting) {
    const matches = [...text.matchAll(LUA_TEMPLATE_RE)]
    // bundle 名全小写而模板 painting 可能含大写（Z46_2 / lafeiII_3），按不区分大小写匹配
    const lineRe = new RegExp(`^\\tpainting = "${painting.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}",$`, 'gmi')
    for (const line of text.matchAll(lineRe)) {
        const owners = matches.filter((m) => m.index < line.index)
        if (owners.length) {
            const owner = owners[owners.length - 1]
            return luaBlock(text, matches, matches.indexOf(owner))
        }
    }
    throw new Error(`ship_skin_template 中没有 painting ${painting}`)
}

// 按文件序解析全部皮肤模板条目的轻量字段（gen_catalog.js 构建目录用）。
// painting 可为空串/缺省（普通立绘皮肤无 L2D），由调用方自行过滤。
export function readAllSkinTemplates(text) {
    const matches = [...text.matchAll(LUA_TEMPLATE_RE)]
    return matches.map((match, index) => {
        const template = luaBlock(text, matches, index)
        return {
            id: parseInt(match[1]),
            name: template.name,
            painting: template.painting,
            ship_group: template.ship_group,
            skin_type: template.skin_type,
        }
    })
}

// 解析全部 ship_l2d 条目。键是 skinId 直接连缀序号，序号宽度不定（老皮肤 1 位如 4990521、
// 新皮肤 2 位补零如 81801101），宽度启发式会漏配——模板 ship_l2d_id 已给出精确键，由调用方按 id 直查
function parseShipL2d(text) {
    const matches = [...text.matchAll(LUA_ENTRY_RE)]
    return matches.map((match, index) => ({ key: parseInt(match[1]), ...luaBlock(text, matches, index) }))
}

// 从 ship_skin_newmainui_shift.lua 读单皮肤的主页位移条目（skin_shift/l2d_shift/spine_shift）
function readMainuiShift(path, skinId) {
    const text = readFileSync(path, 'utf8')
    const re = /^\tpg\.base\.ship_skin_newmainui_shift\[(\d+)\] = \{$/gm
    const matches = [...text.matchAll(re)]
    for (let index = 0; index < matches.length; index++) {
        if (parseInt(matches[index][1]) === skinId) return luaBlock(text, matches, index)
    }
    return null
}

// 从已落盘的 interaction.json 读 idle 变体索引：actionId=1 的状态按 subIndex 升序 -> clip 名
// 老皮肤的基础状态没有 subIndex 字段，视作变体 0
function idleIndex(modelDir, modelId) {
    const path = join(modelDir, `${modelId}.interaction.json`)
    if (!existsSync(path)) return {}
    const states = JSON.parse(readFileSync(path, 'utf8')).animator?.states ?? []
    const entries = states
        .filter((s) => s.actionId === 1 && s.clip)
        .map((s) => [s.subIndex ?? 0, s.clip])
        .sort((a, b) => a[0] - b[0])
    return Object.fromEntries(entries)
}

// 把本地 Lua 快照烘焙为模型目录内的 l2d.json。skinRef 是皮肤 id 或 painting 名。
// log: { info(msg), warn(msg) }——warn 自动带 [warn] 前缀（由 CLI 层统一加工）。
export function bakeL2d(root, modelDir, modelId, server, skinRef, log) {
    const luaRoot = resolve(root, '.tmp', 'lua', server)
    const luaPath = join(luaRoot, 'sharecfg', 'ship_l2d.lua')
    const templatePath = join(luaRoot, 'sharecfgdata', 'ship_skin_template.lua')
    if (!existsSync(luaPath) || !existsSync(templatePath)) {
        log.warn(`Lua 快照不存在，跳过 l2d.json（服务器: ${server}）`)
        return false
    }

    const templateText = readFileSync(templatePath, 'utf8')
    let skinId
    let painting
    let template
    if (/^\d+$/.test(skinRef)) {
        skinId = parseInt(skinRef)
        template = readSkinTemplate(templateText, skinId)
        painting = template.painting
    } else {
        painting = skinRef
        template = readTemplateByPainting(templateText, painting)
        skinId = parseInt(template.id)
    }

    // live2d_offset 与机器条目解耦：老皮肤没有参数机也照常烘焙——游戏端对无 offset 皮肤按
    // Live2DPainting 默认语义取景（根缩放 52 + 原点位移），缺了 offset 查看器只能退回 ROI 拟合
    const l2dIds = Array.isArray(template.ship_l2d_id) ? template.ship_l2d_id : []
    const byKey = l2dIds.length
        ? new Map(parseShipL2d(readFileSync(luaPath, 'utf8')).map((e) => [e.key, e]))
        : new Map()
    const missing = l2dIds.filter((key) => !byKey.has(key))
    if (missing.length) log.warn(`皮肤 ${skinId}（${painting}）ship_l2d.lua 缺少条目: ${JSON.stringify(missing)}，按已有条目烘焙`)
    // 缺键条目落 null 会毒化机器循环，过滤掉（缺失已由上面的 warn 声明）
    const found = l2dIds.map((key) => byKey.get(key)).filter((e) => e)

    // 主页容器位移（mellow 主题 per-skin 表）：skin_shift 是背景画层、l2d_shift 是 L2D 容器层，
    // 查看器取景消费 l2d − skin 的相对位移；快照缺这份文件时落 null（取景回退表外常量位移）
    const shiftPath = join(luaRoot, 'sharecfg', 'ship_skin_newmainui_shift.lua')
    const shiftEntry = existsSync(shiftPath)
        ? readMainuiShift(shiftPath, skinId)
        : null

    const product = {
        skin_id: skinId,
        painting,
        name: template.name,
        ship_group: template.ship_group,
        live2d_offset: template.live2d_offset,
        mainui_shift: shiftEntry,
        idle_index: idleIndex(modelDir, modelId),
        entries: found,
    }
    const dest = join(modelDir, `${modelId}.l2d.json`)
    writeFileSync(dest, JSON.stringify(product, null, 2))
    log.info(`  l2d: ${dest}（${product.entries.length} 台机器）`)
    return true
}
