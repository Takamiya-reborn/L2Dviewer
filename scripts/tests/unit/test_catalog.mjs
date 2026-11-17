// 皮肤目录纯逻辑单测：Lua 模板轻量解析、目录构建（交集/派生/撞名/排序）、状态分类。
// 全部合成配置，不依赖真实资产与设备。
import { suite } from '../helpers/suite.mjs'
import { buildCatalog } from '../../gen_catalog.js'
import { classifyState } from '../../dev/api.js'
import { readAllSkinTemplates } from '../../extract/lua.js'

const { check, eq, section, finish } = suite('皮肤目录')

// 与游戏快照同构的最小模板片段（条目头行匹配 LUA_TEMPLATE_RE，字段用 \t 缩进）
const TEMPLATE_TEXT = [
    '_G.pg.base.ship_skin_template[201113] = {',
    '\tname = "圣宵之鬼的微醺",',
    '\tdesc = "带\\"转义\\"引号的文案",',
    '\tpainting = "aersasi_3",',
    '\tship_group = 80503,',
    '\tskin_type = 4,',
    '\tid = 201113',
    '}',
    '_G.pg.base.ship_skin_template[300001] = {',
    '\tname = "首条",',
    '\tpainting = "shared_p",',
    '\tship_group = 30000,',
    '\tid = 300001',
    '}',
    '_G.pg.base.ship_skin_template[300002] = {',
    '\tname = "次条",',
    '\tpainting = "shared_p",',
    '\tship_group = 30000,',
    '\tid = 300002',
    '}',
    '_G.pg.base.ship_skin_template[400001] = {',
    '\tname = "基础名",',
    '\tpainting = "basis",',
    '\tship_group = 40000,',
    '\tid = 400001',
    '}',
    '_G.pg.base.ship_skin_template[400002] = {',
    '\tname = "同名",',
    '\tpainting = "dup_1",',
    '\tid = 400002',
    '}',
    '_G.pg.base.ship_skin_template[400003] = {',
    '\tname = "同名",',
    '\tpainting = "dup_2",',
    '\tid = 400003',
    '}',
    '_G.pg.base.ship_skin_template[500001] = {',
    '\tname = "无绘画皮肤",',
    '\tpainting = "",',
    '\tid = 500001',
    '}',
    '_G.pg.base.ship_skin_template[600001] = {',
    '\tname = "{namecode:6}",',
    '\tpainting = "ph_ship",',
    '\tship_group = 60000,',
    '\tid = 600001',
    '}',
    '_G.pg.base.ship_skin_template[700001] = {',
    '\tname = "大写皮肤",',
    '\tpainting = "PH_Upper_2",',
    '\tship_group = 70000,',
    '\tid = 700001',
    '}',
].join('\n')

// 对齐 scripts/dev/models.js nameClass 的首字符类别（测试自足，不依赖私有实现）
function classOf(ch) {
    const c = ch.codePointAt(0)
    if (c >= 0x30 && c <= 0x39) return 1
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) return 2
    if ((c >= 0x3400 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff) || c >= 0x20000) return 3
    return 0
}

section('readAllSkinTemplates')
const templates = readAllSkinTemplates(TEMPLATE_TEXT)
eq('条目数', templates.length, 9)
eq('文件序首条 id', templates[0].id, 201113)
eq('name 字段', templates[0].name, '圣宵之鬼的微醺')
check('含转义引号条目正常解析不崩', templates[0].painting === 'aersasi_3')
eq('空 painting 保留待过滤', templates[6].painting, '')

section('buildCatalog')
const bundles = ['aersasi_3', 'shared_p', 'basis_hx', 'basis_2', 'z46_2', 'dup_1', 'dup_2', 'ph_ship', 'ph_ship_hx', 'ph_upper_2']
const nameCodes = new Map([['6', '绫波']])
const camps = new Map([[80503, 1], [40000, 4], [30000, 2], [70000, 8]])
const catalog = buildCatalog(TEMPLATE_TEXT, bundles, '0.0.1605', nameCodes, camps)
eq('版本号透传', catalog.version, '0.0.1605')
const byPainting = Object.fromEntries(catalog.entries.map((e) => [e.painting, e]))
eq('交集条目全字段', byPainting.aersasi_3, { painting: 'aersasi_3', name: '圣宵之鬼的微醺', ship_group: 80503, skin_id: 201113, camp: 1 })
check('同 painting 取文件序首条', byPainting.shared_p?.name === '首条' && byPainting.shared_p.skin_id === 300001)
check('_hx 派生借基础名+（婚变）', byPainting.basis_hx?.name === '基础名（婚变）' && byPainting.basis_hx.derived === true)
check('数字后缀派生借基础名+（改造）', byPainting.basis_2?.name === '基础名（改造）' && byPainting.basis_2.derived === true)
check('派生条目继承基础阵营', byPainting.basis_hx?.camp === 4)
check('全不命中回退 painting 本名', byPainting.z46_2?.name === 'z46_2' && byPainting.z46_2.derived === true)
check('回退条目无 camp 不落字段', !('camp' in byPainting.z46_2))
check('阵营表按 ship_group 命中', byPainting.ph_upper_2?.camp === 8)
check('撞名防御追加 painting 后缀', byPainting.dup_1?.name === '同名' && byPainting.dup_2?.name === '同名（dup_2）')
check('namecode 占位符代换', byPainting.ph_ship?.name === '绫波')
check('派生名同样代换', byPainting.ph_ship_hx?.name === '绫波（婚变）' && byPainting.ph_ship_hx.derived === true)
check('大小写不敏感命中模板（bundle 全小写）', byPainting.ph_upper_2?.name === '大写皮肤' && byPainting.ph_upper_2.skin_id === 700001 && !byPainting.ph_upper_2.derived)
check('缺代换表保留占位符', buildCatalog(TEMPLATE_TEXT, ['ph_ship'], undefined).entries[0].name === '{namecode:6}')
check('无版本号时省略 version 字段', !('version' in buildCatalog(TEMPLATE_TEXT, bundles, undefined)))
const firstChars = catalog.entries.map((e) => e.name[0])
check('首字符类别单调不减（符号→数字→字母→汉字）',
    firstChars.every((ch, i) => i === 0 || classOf(ch) >= classOf(firstChars[i - 1])))

section('classifyState')
const baked = new Set(['baked_p'])
eq('已烘焙', classifyState(baked, 'baked_p', true), 'baked')
eq('未烘焙但有 bundle 缓存', classifyState(baked, 'cached_p', true), 'cached')
eq('远端未拉取', classifyState(baked, 'remote_p', false), 'remote')

finish()
