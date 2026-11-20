// 回归测试：spine .skel 二进制解析 + spine 3.8 JSON 转换（scripts/extract/spineSkel.js）。
// 合成字节流逐字段复刻游戏 spine-unity.dll 的 SkeletonBinary 语法（逆向定案见该文件头注）：
// 哈希/版本串、x/y/w/h、nonessential=false、strings 表、2 骨骼、1 槽位、default skin 1 个
// region 附件、1 支动画（rotate 两帧）。断言解析树字段与 JSON 转换的结构映射。
import { suite } from '../helpers/suite.mjs'
import { parseSkel, toSpine38Json } from '../../extract/spineSkel.js'

const { check, eq, near, section, finish } = suite('spineSkel')

// ---- 合成 .skel 字节流 ----
const bytes = []
const u8 = (v) => bytes.push(v & 0xff)
const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); bytes.push(...b) }
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); bytes.push(...b) }
const varint = (v) => {
    do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; bytes.push(b) } while (v)
}
const str = (s) => { varint(s.length + 1); for (const c of Buffer.from(s, 'utf8')) bytes.push(c) }

str('deadbeef') // hash
str('3.8.99') // version
f32(-10); f32(-20); f32(300); f32(400) // x,y,width,height
u8(0) // nonessential = false

varint(2) // strings 表
str('tex_page')
str('event_hit')

varint(2) // 骨骼
str('root'); f32(0); f32(0); f32(0); f32(1); f32(1); f32(0); f32(0); f32(0); u8(0); u8(0) // 无 parent 字段（j==0 读取器跳过），mode=normal + skinRequired=false
str('body'); varint(0); f32(90); f32(10.5); f32(-3.25); f32(1); f32(2); f32(0.5); f32(0); f32(12); varint(1); u8(1)

varint(1) // 槽位
str('slot_a'); varint(1); i32(-1); i32(-1); varint(0); varint(0) // rgba/rgba2=-1 无两色，attachment=null，blend=normal

varint(0) // ik
varint(0) // transform
varint(0) // path

varint(1) // default skin：count 即槽位条目数
varint(0) // slotIndex 0
varint(1) // 1 个附件
varint(1) // 附件名 -> strings[0] = 'tex_page'
varint(0) // 附件记录内部的名字引用（0 = null，继承皮肤键名）
u8(0) // type: region
varint(1) // path -> strings[0] = 'tex_page'
f32(45); f32(1); f32(2); f32(3); f32(4); f32(64); f32(32); i32(0x80ff00ff | 0)

varint(0) // 显式 skins

varint(0) // events

varint(1) // 动画数
str('normal')
varint(1) // 槽位时间轴数
varint(0); varint(1) // slot 0，1 条
u8(0); varint(2) // attachment 时间轴，2 帧
f32(0); varint(0) // t=0，name=null（清空）
f32(0.5); varint(1) // t=0.5，name=strings[0]
varint(1) // 骨骼时间轴数
varint(1); varint(1) // bone 1，1 条
u8(0); varint(2) // rotate，2 帧
f32(0); f32(10); u8(2); f32(0.33); f32(0.66); f32(0.99); f32(1.0) // bezier 曲线
f32(1); f32(20)
varint(0) // ik 时间轴数
varint(0) // transform
varint(0) // path
varint(0) // deform
varint(0) // drawOrder
varint(0) // events

const skel = parseSkel(Buffer.from(bytes))

section('parseSkel')
eq('版本', skel.version, '3.8.99')
eq('哈希', skel.hash, 'deadbeef')
eq('nonessential', skel.nonessential, false)
near('宽度', skel.width, 300)
eq('strings 表', skel.strings, ['tex_page', 'event_hit'])

eq('骨骼数', skel.bones.length, 2)
const [root, body] = skel.bones
check('root 无父', root.parent === null && root.scaleX === 1 && root.length === 0)
eq('body 父名', body.parent, 'root')
near('body 旋转', body.rotation, 90)
near('body x', body.x, 10.5)
near('body 长度', body.length, 12)
eq('body transformMode', body.mode, 1)
eq('body skinRequired', body.skinRequired, true)

eq('槽数', skel.slots.length, 1)
eq('槽位归属', skel.slots[0].bone, 'body')
eq('槽位 rgba（-1 白）', skel.slots[0].rgba, -1)
eq('槽位 attachment', skel.slots[0].attachment, null)

eq('skin 数', skel.skins.length, 1)
const att = skel.skins[0].attachments[0]
eq('附件名引用 strings 表', att.name, 'tex_page')
eq('附件类型 region', att.type, 0)
eq('附件 path 引用', att.path, 'tex_page')
near('附件宽', att.width, 64)
eq('附件 rgba', att.rgba, 0x80ff00ff | 0)

eq('动画名', skel.animations[0].name, 'normal')
const [slotTl] = skel.animations[0].slots
eq('attachment 时间轴帧', slotTl.frames.map((f) => f.name), [null, 'tex_page'])
const [boneTl] = skel.animations[0].bones
eq('rotate 帧值', boneTl.frames.map((f) => f.value), [10, 20])
check('bezier 曲线', Array.isArray(boneTl.frames[0].curve) && Math.abs(boneTl.frames[0].curve[0] - 0.33) < 1e-6, JSON.stringify(boneTl.frames[0].curve))

section('toSpine38Json')
const json = toSpine38Json(skel)
eq('skeleton 块版本', json.skeleton.spine, '3.8.99')
near('skeleton 宽', json.skeleton.width, 300)
eq('骨骼 transform 串', json.bones[1].transform, 'onlyTranslation')
check('skin: body 有 skin 标记', json.bones[1].skin === true)
eq('槽位 blend 缺省省略', 'blend' in json.slots[0], false)
// pixi-spine 3.8 的 skins 是数组形态（{name, attachments:{槽:{附件}}}），"default" 由运行时自动设为 defaultSkin
const skinAtt = json.skins[0].attachments.slot_a.tex_page
check('default skin 数组形态', json.skins[0].name === 'default')
eq('skin 附件类型', skinAtt.type, 'region')
eq('skin 附件 path', skinAtt.path, 'tex_page')
eq('skin 附件 color', skinAtt.color, '80ff00ff')
const rot = json.animations.normal.bones.body.rotate
eq('rotate JSON 帧角', rot.map((f) => f.angle), [10, 20])
// pixi-spine 的 JSON 曲线是四个独立键 curve/c2/c3/c4（官方 spine 是数组），按运行时为准
check('rotate JSON 曲线键位', rot[0].curve === rot[0].curve && Math.abs(rot[0].curve - 0.33) < 1e-6
    && Math.abs(rot[0].c2 - 0.66) < 1e-6 && Math.abs(rot[0].c3 - 0.99) < 1e-6 && Math.abs(rot[0].c4 - 1) < 1e-6,
    JSON.stringify({ curve: rot[0].curve, c2: rot[0].c2, c3: rot[0].c3, c4: rot[0].c4 }))
eq('attachment JSON 帧', json.animations.normal.slots.slot_a.attachment.map((f) => f.name), [null, 'tex_page'])

// ---- 第二条流：加权 mesh + clipping 附件（回归：weightedFlat 序号错位曾让顶点读到越界 undefined） ----
const bytes2 = []
const u82 = (v) => bytes2.push(v & 0xff)
const f322 = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); bytes2.push(...b) }
const i322 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); bytes2.push(...b) }
const varint2 = (v) => {
    do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; bytes2.push(b) } while (v)
}
const str2 = (s) => { varint2(s.length + 1); for (const c of Buffer.from(s, 'utf8')) bytes2.push(c) }
const sh16 = (v) => { u82(v >> 8); u82(v & 0xff) }

str2('feedface') // hash
str2('3.8.99') // version
f322(0); f322(0); f322(100); f322(100) // x,y,width,height
u82(0) // nonessential = false

varint2(2) // strings 表
str2('mesh_a')
str2('clip_a')

varint2(1) // 骨骼：root（j==0 无 parent 字段）
str2('root'); f322(0); f322(0); f322(0); f322(1); f322(1); f322(0); f322(0); f322(0); varint2(0); u82(0)

varint2(2) // 槽位
str2('slot_mesh'); varint2(0); i322(-1); i322(-1); varint2(0); varint2(0)
str2('slot_clip'); varint2(0); i322(-1); i322(-1); varint2(0); varint2(0)

varint2(0) // ik
varint2(0) // transform
varint2(0) // path

varint2(2) // default skin：2 个槽位条目
// 条目 1：mesh（加权，2 顶点 = 2 绑定 + 1 绑定）
varint2(0); varint2(1)
varint2(1) // 附件名 -> strings[0] = 'mesh_a'
varint2(0) // 附件记录内部的名字引用（null = 继承键名）
u82(2) // type: mesh
varint2(0) // path = null，继承键名
i322(255) // rgba
varint2(2) // 顶点数
f322(0); f322(0); f322(10); f322(10) // uvs 4 个
varint2(3); sh16(0); sh16(1); sh16(2) // triangles
u82(1) // 加权
varint2(2); varint2(0); f322(1); f322(2); f322(0.5); varint2(1); f322(3); f322(4); f322(0.25) // 顶点 0：2 绑定
varint2(1); varint2(2); f322(5); f322(6); f322(0.25) // 顶点 1：1 绑定
varint2(4) // hull
// 条目 2：clipping（无权）
varint2(1); varint2(1)
varint2(2) // 附件名 -> strings[1] = 'clip_a'
varint2(0) // 附件记录内部的名字引用（null = 继承键名）
u82(6) // type: clipping
varint2(1) // endSlot = 1
varint2(3) // 顶点数
u82(0) // 无权
f322(0); f322(1); f322(2); f322(3); f322(4); f322(5)

varint2(0) // 显式 skins
varint2(0) // events
varint2(0) // animations

const skel2 = parseSkel(Buffer.from(bytes2))
const meshAtt = skel2.skins[0].attachments[0]

section('parseSkel 加权 mesh + clipping')
eq('mesh 顶点绑定数列', meshAtt.bones, [2, 0, 1, 1, 2])
eq('mesh 加权三元组', meshAtt.vertices, [1, 2, 0.5, 3, 4, 0.25, 5, 6, 0.25])
eq('mesh 顶点数', meshAtt.worldVerticesLength, 4)
eq('clipping 顶点数', skel2.skins[0].attachments[1].worldVerticesLength, 6)

section('toSpine38Json 加权 mesh + clipping')
const json2 = toSpine38Json(skel2)
const meshJson = json2.skins[0].attachments.slot_mesh.mesh_a
const clipJson = json2.skins[0].attachments.slot_clip.clip_a
// pixi-spine 布局 [count, boneIdx, x, y, weight,...]，靠 vertices.length !== uvs.length 判加权
eq('mesh 加权平铺', meshJson.vertices,
    [2, 0, 1, 2, 0.5, 1, 3, 4, 0.25, 1, 2, 5, 6, 0.25])
check('mesh 加权判定', meshJson.vertices.length !== meshJson.uvs.length)
eq('mesh 三角序', meshJson.triangles, [0, 1, 2])
eq('clipping end 键取槽名', clipJson.end, 'slot_clip')
eq('clipping vertexCount', clipJson.vertexCount, 3)

// ---- 第三条流：deform 悬挂引用（美术迭代改名的旧引用。单候选同槽位名做最长公共前缀
// 修补；多候选且无公共前缀时无从判定，丢弃——3.8 JSON 读取器严格解析会整体抛错） ----
const bytes3 = []
const u83 = (v) => bytes3.push(v & 0xff)
const f323 = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); bytes3.push(...b) }
const i323 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); bytes3.push(...b) }
const varint3 = (v) => {
    do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; bytes3.push(b) } while (v)
}
const str3 = (s) => { varint3(s.length + 1); for (const c of Buffer.from(s, 'utf8')) bytes3.push(c) }

str3('0badf00d') // hash
str3('3.8.99') // version
f323(0); f323(0); f323(100); f323(100) // x,y,width,height
u83(0) // nonessential = false

varint3(7) // strings 表
str3('att_a')
str3('att_b')
str3('att_ghost') // 旧名，前缀 att_ 与同槽位唯一候选修补
str3('att_x')
str3('att_y')
str3('qqq_ghost') // 旧名，与多候选无公共前缀，丢弃
str3('1')

varint3(1) // 骨骼：root
str3('root'); f323(0); f323(0); f323(0); f323(1); f323(1); f323(0); f323(0); f323(0); varint3(0); u83(0)

varint3(2) // 槽位
str3('slot_a'); varint3(0); i323(-1); i323(-1); varint3(0); varint3(0)
str3('slot_b'); varint3(0); i323(-1); i323(-1); varint3(0); varint3(0)

varint3(0) // ik
varint3(0) // transform
varint3(0) // path

varint3(1) // default skin：1 个槽位条目
varint3(0); varint3(1) // slot 0，1 个附件
varint3(1) // 附件名 -> strings[0] = 'att_a'
varint3(0) // 内部名字引用（null = 继承键名）
u83(0) // type: region
varint3(0) // path = null，继承键名
f323(0); f323(0); f323(0); f323(1); f323(1); f323(64); f323(64); i323(0xffffffff | 0)

varint3(1) // 显式 skins：1 个（皮肤名走 strings 表引用）
varint3(7) // 皮肤名 -> strings[6] = '1'
varint3(0) // 皮肤骨骼数
varint3(0); varint3(0); varint3(0) // ik / transform / path 约束数
varint3(2) // 槽位条目数
// slot 0：唯一候选 att_b（ghost 修补目标）
varint3(0); varint3(1)
varint3(2) // 附件名 -> strings[1] = 'att_b'
varint3(0)
u83(0) // type: region
varint3(0)
f323(0); f323(0); f323(0); f323(1); f323(1); f323(64); f323(64); i323(0xffffffff | 0)
// slot 1：两候选 att_x / att_y（无前缀 ghost 丢弃目标）
varint3(1); varint3(2)
varint3(4) // 附件名 -> strings[3] = 'att_x'
varint3(0)
u83(0)
varint3(0)
f323(0); f323(0); f323(0); f323(1); f323(1); f323(64); f323(64); i323(0xffffffff | 0)
varint3(5) // 附件名 -> strings[4] = 'att_y'
varint3(0)
u83(0)
varint3(0)
f323(0); f323(0); f323(0); f323(1); f323(1); f323(64); f323(64); i323(0xffffffff | 0)

varint3(0) // events

varint3(1) // 动画数
str3('normal')
varint3(0) // 槽位时间轴数
varint3(0) // 骨骼时间轴数
varint3(0) // ik
varint3(0) // transform
varint3(0) // path
varint3(2) // deform 分组数：2 个皮肤
varint3(0); varint3(1) // 组 1：skin 0（default），1 个槽位
varint3(0); varint3(1) // slot 0，1 个附件时间轴
varint3(1) // 附件名 -> strings[0] = 'att_a'（default 皮肤有，原样保留）
varint3(1) // 1 帧
f323(0); varint3(0) // t=0，end=0（空形变）
varint3(1); varint3(2) // 组 2：skin 1（'1'），2 个槽位
varint3(0); varint3(1) // slot 0，1 个附件时间轴
varint3(3) // 附件名 -> strings[2] = 'att_ghost'（单候选前缀修补 -> att_b）
varint3(1) // 1 帧
f323(0); varint3(0)
varint3(1); varint3(1) // slot 1，1 个附件时间轴
varint3(6) // 附件名 -> strings[5] = 'qqq_ghost'（多候选无前缀，丢弃）
varint3(1) // 1 帧
f323(0); varint3(0)
varint3(0) // drawOrder
varint3(0) // events

const skel3 = parseSkel(Buffer.from(bytes3))

section('toSpine38Json deform 悬挂引用修补/丢弃')
const json3 = toSpine38Json(skel3)
check('default 皮肤有效 deform 保留', json3.animations.normal.deform?.default?.slot_a?.att_a?.length === 1,
    JSON.stringify(json3.animations.normal.deform))
check('单候选旧名按公共前缀修补', json3.animations.normal.deform?.['1']?.slot_a?.att_b?.length === 1,
    JSON.stringify(json3.animations.normal.deform?.['1']))
check('多候选无前缀旧名丢弃', json3.animations.normal.deform?.['1']?.slot_b === undefined,
    JSON.stringify(json3.animations.normal.deform?.['1']?.slot_b))

finish()
