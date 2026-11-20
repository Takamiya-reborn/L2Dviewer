// spine .skel 二进制解析：碧蓝航线 Ani 皮肤的骨架格式（spine 3.8 系，游戏定制读取器的逐字段还原）。
// 语法权威 = 游戏 HybridCLR 热更程序集 spine-unity.dll 的 SkeletonBinary.ReadSkeletonData（反编译核对）。
// 关键点：
//   - 字节必须是 bundle 内 TextAsset 的原始字节（unityfs-js typetree 的 m_Script 经 UTF-8 解码已毁二进制段，不可用）
//   - nonessential 为真时：头部多读 fps/imagesPath/debug int/audioPath，每根骨骼、每个顶点型附件、path/point/clipping
//     附件尾部各多一个 int（游戏用 Debug.Log 调试读取吃掉的占位字段）
//   - 槽位/皮肤/事件/附件名走 strings 表引用（1 基，0 = null），骨骼名内联
//
// parseSkel(bytes) -> 解析树；toSpine38Json(parsed) -> spine 3.8 JSON 文档（供 3.8 系运行时直接加载）。

export function parseSkel(bytes) {
    // 每步读取前记位置，抛错时带上偏移与十六进制上下文，定位语法分歧点
    const ctx = () =>
        `@${p}/${bytes.length}: ${Buffer.from(bytes.subarray(Math.max(0, p - 4), p + 8)).toString('hex').replace(/(..)/g, '$1 ')}`
    const guard = (fn) => (...args) => {
        try {
            return fn(...args)
        } catch (e) {
            throw new Error(`spineSkel: 读取出错 ${ctx()}（${e.message}）`)
        }
    }
    let p = 0
    const _u8 = () => bytes[p++]
    const _s8 = () => (u8() << 24) >> 24
    const _f32 = () => { const v = Buffer.from(bytes.subarray(p, p + 4)).readFloatBE(0); p += 4; return v }
    const _i32 = () => { const v = Buffer.from(bytes.subarray(p, p + 4)).readInt32BE(0); p += 4; return v }
    const _varint = () => {
        let b = u8(), v = b & 0x7f, sh = 0
        while (b & 0x80) { b = u8(); sh += 7; v |= (b & 0x7f) << sh }
        return v
    }
    const u8 = guard(_u8)
    const s8 = guard(_s8)
    const f32 = guard(_f32)
    const i32 = guard(_i32)
    const varint = guard(_varint)
    const int = () => varint()
    // ReadInt(false)：zigzag 解码（事件 Int 用）
    const intSigned = () => { const v = varint(); return (v >> 1) ^ -(v & 1) }
    const bool = () => u8() !== 0
    function str() {
        const n = varint()
        if (n === 0) return null
        if (n === 1) return ''
        const s = Buffer.from(bytes.subarray(p, p + n - 1)).toString('utf8')
        p += n - 1
        return s
    }
    function strRef() { const i = varint(); return i === 0 ? null : strings[i - 1] }
    // 每帧可选曲线：0/缺省=线性，1=stepped，2=bezier 4 float
    function curve(frames, i) {
        const t = u8()
        if (t === 1) frames[i].curve = 'stepped'
        else if (t === 2) frames[i].curve = [f32(), f32(), f32(), f32()]
    }
    function readVertices(vertexCount) {
        if (!bool()) {
            const v = []
            for (let i = 0; i < vertexCount * 2; i++) v.push(f32())
            return { vertices: v, bones: null }
        }
    const bones = []; const verts = []
        for (let i = 0; i < vertexCount; i++) {
            const bn = int(); bones.push(bn)
            for (let j = 0; j < bn; j++) { bones.push(int()); verts.push(f32(), f32(), f32()) }
        }
        return { vertices: verts, bones }
    }
    const readShortArray = () => { const n = int(); const v = []; for (let i = 0; i < n; i++) v.push((u8() << 8) | u8()); return v }
    const readFloatArray = (n) => { const v = []; for (let i = 0; i < n; i++) v.push(f32()); return v }

    const hash = str()
    const version = str()
    const x = f32(), y = f32(), width = f32(), height = f32()
    const nonessential = bool()
    let fps, imagesPath, audioPath
    if (nonessential) {
        fps = f32()
        imagesPath = str()
        varint() // 游戏 Debug.Log 调试读取的占位 int
        audioPath = str()
    }

    const strings = []
    { const n = int(); for (let i = 0; i < n; i++) strings.push(str()) }

    const bones = []
    { const n = int(); for (let j = 0; j < n; j++) {
        const name = str()
        const parent = j === 0 ? null : bones[int()]
        const rotation = f32(), bx = f32(), by = f32(), scaleX = f32(), scaleY = f32(), shearX = f32(), shearY = f32(), length = f32()
        const mode = int()
        const skinRequired = bool()
        if (nonessential) i32()
        bones.push({ name, parent: parent?.name ?? null, rotation, x: bx, y: by, scaleX, scaleY, shearX, shearY, length, mode, skinRequired })
    } }

    const slots = []
    { const n = int(); for (let k = 0; k < n; k++) {
        const name = str()
        const bone = bones[int()]?.name
        const rgba = i32()
        const rgba2 = i32()
        const attachment = strRef()
        const blend = int()
        slots.push({ name, bone, rgba, rgba2, attachment, blend })
    } }

    const ik = []
    { const n = int(); for (let l = 0; l < n; l++) {
        const name = str(); const order = int(); const skinRequired = bool()
        const bonesList = []
        { const bn = int(); for (let m = 0; m < bn; m++) bonesList.push(int()) }
        const target = int()
        const mix = f32(), softness = f32()
        const bend = s8(), compress = bool(), stretch = bool(), uniform = bool()
        ik.push({ name, order, skinRequired, bones: bonesList, target, mix, softness, bend, compress, stretch, uniform })
    } }

    const transform = []
    { const n = int(); for (let i = 0; i < n; i++) {
        const name = str(); const order = int(); const skinRequired = bool()
        const bonesList = []
        { const bn = int(); for (let m = 0; m < bn; m++) bonesList.push(int()) }
        const target = int()
        const local = bool(), relative = bool()
        const offsetRotation = f32(), offsetX = f32(), offsetY = f32(), offsetScaleX = f32(), offsetScaleY = f32(), offsetShearY = f32()
        const rotateMix = f32(), translateMix = f32(), scaleMix = f32(), shearMix = f32()
        transform.push({ name, order, skinRequired, bones: bonesList, target, local, relative, offsetRotation, offsetX, offsetY, offsetScaleX, offsetScaleY, offsetShearY, rotateMix, translateMix, scaleMix, shearMix })
    } }

    const path = []
    { const n = int(); for (let i = 0; i < n; i++) {
        const name = str(); const order = int(); const skinRequired = bool()
        const bonesList = []
        { const bn = int(); for (let m = 0; m < bn; m++) bonesList.push(int()) }
        const target = int()
        const positionMode = int(), spacingMode = int(), rotateMode = int()
        const offsetRotation = f32(), position = f32(), spacing = f32(), rotateMix = f32(), translateMix = f32()
        path.push({ name, order, skinRequired, bones: bonesList, target, positionMode, spacingMode, rotateMode, offsetRotation, position, spacing, rotateMix, translateMix })
    } }

    const readAttachment = (slotIndex, attachmentName) => {
        let name = strRef()
        if (name === null) name = attachmentName
        const type = u8()
        const a = { name, type }
        switch (type) {
            case 0: { // Region
                let path = strRef(); if (path === null) path = name
                const rotation = f32(), ax = f32(), ay = f32(), scaleX = f32(), scaleY = f32(), w = f32(), h = f32()
                const rgba = i32()
                Object.assign(a, { path, rotation, x: ax, y: ay, scaleX, scaleY, width: w, height: h, rgba })
                break
            }
            case 1: { // Boundingbox
                const vc = int()
                const verts = readVertices(vc)
                if (nonessential) i32()
                Object.assign(a, { worldVerticesLength: vc * 2, ...verts })
                break
            }
            case 2: { // Mesh
                let path = strRef(); if (path === null) path = name
                const rgba = i32()
                const vc = int()
                const uvs = readFloatArray(vc * 2)
                const triangles = readShortArray()
                const verts = readVertices(vc)
                const hull = int()
                let edges, mw, mh
                if (nonessential) { edges = readShortArray(); mw = f32(); mh = f32() }
                Object.assign(a, { path, rgba, worldVerticesLength: vc * 2, uvs, triangles, ...verts, hull, edges, w: mw, h: mh })
                break
            }
            case 3: { // Linkedmesh
                let path = strRef(); if (path === null) path = name
                const rgba = i32()
                const skin = strRef()
                const parent = strRef()
                const inheritDeform = bool()
                let mw, mh
                if (nonessential) { mw = f32(); mh = f32() }
                Object.assign(a, { path, rgba, skin, parent, inheritDeform, w: mw, h: mh })
                break
            }
            case 4: { // Path
                const closed = bool(), constantSpeed = bool()
                const vc = int()
                const verts = readVertices(vc)
                const lengths = []
                for (let i = 0; i < Math.floor(vc / 3); i++) lengths.push(f32())
                if (nonessential) i32()
                Object.assign(a, { closed, constantSpeed, worldVerticesLength: vc * 2, ...verts, lengths })
                break
            }
            case 5: { // Point
                const rotation = f32(), px = f32(), py = f32()
                if (nonessential) i32()
                Object.assign(a, { rotation, x: px, y: py })
                break
            }
            case 6: { // Clipping
                const endSlot = int()
                const vc = int()
                const verts = readVertices(vc)
                if (nonessential) i32()
                Object.assign(a, { endSlot, worldVerticesLength: vc * 2, ...verts })
                break
            }
            default:
                throw new Error(`spineSkel: 未知附件类型 ${type} @${p - 1}（槽位 ${slotIndex}，附件 ${attachmentName}）`)
        }
        return a
    }
    const readSkin = (name) => {
        let count
        const skin = { name, bones: [], constraints: [], attachments: [] }
        if (name === undefined) { // default skin：count==0 即无 default
            count = int()
            if (count === 0) return null
            skin.name = 'default'
        } else {
            const bn = int()
            for (let i = 0; i < bn; i++) skin.bones.push(int())
            for (const kind of ['ik', 'transform', 'path']) {
                const cn = int()
                for (let i = 0; i < cn; i++) skin.constraints.push([kind, int()])
            }
            count = int()
        }
        for (let m = 0; m < count; m++) {
            const slot = int()
            const an = int()
            for (let i = 0; i < an; i++) {
                const aname = strRef()
                skin.attachments.push({ slot, name: aname, ...readAttachment(slot, aname) })
            }
        }
        return skin
    }
    const skins = []
    { const def = readSkin(undefined)
        if (def) skins.push(def)
        const more = int()
        for (let i = 0; i < more; i++) skins.push(readSkin(strRef()))
    }

    const events = []
    { const n = int(); for (let i = 0; i < n; i++) {
        const name = strRef()
        const intValue = intSigned()
        const floatValue = f32()
        const stringValue = str()
        const audioPath = str()
        let volume, balance
        if (audioPath !== null) { volume = f32(); balance = f32() }
        events.push({ name, intValue, floatValue, stringValue, audioPath, volume, balance })
    } }

    const animations = []
    { const n = int(); for (let i = 0; i < n; i++) animations.push(readAnimation(str())) }

    function readAnimation(name) {
        const slotsTimelines = []
        { const n = int(); for (let i = 0; i < n; i++) {
            const slotIndex = int()
            const n2 = int()
            for (let j = 0; j < n2; j++) {
                const type = u8()
                const fc = int()
                const frames = []
                for (let k = 0; k < fc; k++) {
                    if (type === 0) { // attachment
                        frames.push({ time: f32(), name: strRef() })
                    } else if (type === 1) { // color
                        const time = f32()
                        const rgba = i32()
                        frames.push({ time, rgba })
                        if (k < fc - 1) curve(frames, k)
                    } else { // two color
                        const time = f32()
                        const rgba = i32()
                        const rgba2 = i32()
                        frames.push({ time, rgba, rgba2 })
                        if (k < fc - 1) curve(frames, k)
                    }
                }
                slotsTimelines.push({ slotIndex, type, frames })
            }
        } }

        const boneTimelines = []
        { const n = int(); for (let i = 0; i < n; i++) {
            const boneIndex = int()
            const n2 = int()
            for (let j = 0; j < n2; j++) {
                const type = u8()
                const fc = int()
                const frames = []
                for (let k = 0; k < fc; k++) {
                    const time = f32()
                    const v1 = f32()
                    const v2 = type === 0 ? undefined : f32() // rotate 单值
                    frames.push(type === 0 ? { time, value: v1 } : { time, x: v1, y: v2 })
                    if (k < fc - 1) curve(frames, k)
                }
                boneTimelines.push({ boneIndex, type, frames })
            }
        } }

        const ikTimelines = []
        { const n = int(); for (let i = 0; i < n; i++) {
            const ikIndex = int()
            const fc = int()
            const frames = []
            for (let k = 0; k < fc; k++) {
                frames.push({ time: f32(), mix: f32(), softness: f32(), bend: s8(), compress: bool(), stretch: bool() })
                if (k < fc - 1) curve(frames, k)
            }
            ikTimelines.push({ ikIndex, frames })
        } }

        const transformTimelines = []
        { const n = int(); for (let i = 0; i < n; i++) {
            const tcIndex = int()
            const fc = int()
            const frames = []
            for (let k = 0; k < fc; k++) {
                frames.push({ time: f32(), rotateMix: f32(), translateMix: f32(), scaleMix: f32(), shearMix: f32() })
                if (k < fc - 1) curve(frames, k)
            }
            transformTimelines.push({ tcIndex, frames })
        } }

        const pathTimelines = []
        { const n = int(); for (let i = 0; i < n; i++) {
            const pcIndex = int()
            const n2 = int()
            for (let j = 0; j < n2; j++) {
                const type = s8()
                const fc = int()
                const frames = []
                for (let k = 0; k < fc; k++) {
                    if (type === 2) {
                        frames.push({ time: f32(), rotateMix: f32(), translateMix: f32() })
                    } else {
                        frames.push({ time: f32(), value: f32() })
                    }
                    if (k < fc - 1) curve(frames, k)
                }
                pathTimelines.push({ pcIndex, type, frames })
            }
        } }

        const deformTimelines = []
        { const n = int(); for (let i = 0; i < n; i++) {
            const skinIndex = int()
            const n2 = int()
            for (let j = 0; j < n2; j++) {
                const slotIndex = int()
                const n3 = int()
                for (let k = 0; k < n3; k++) {
                    const attachmentName = strRef()
                    const fc = int()
                    const frames = []
                    for (let m = 0; m < fc; m++) {
                        const time = f32()
                        let end = int()
                        let start = 0; const verts = []
                        if (end !== 0) {
                            start = int()
                            end += start
                            for (let q = start; q < end; q++) verts.push(f32())
                        }
                        frames.push({ time, start, end, vertices: verts })
                        if (m < fc - 1) curve(frames, m)
                    }
                    deformTimelines.push({ skinIndex, slotIndex, attachmentName, frames })
                }
            }
        } }

        const drawOrder = []
        { const n = int()
            if (n > 0) {
                const slotCount = slots.length
                for (let i = 0; i < n; i++) {
                    const time = f32()
                    const changed = int()
                    const slots2 = new Array(slotCount).fill(-1)
                    const pairs = [] // [slotIndex, offset]，JSON 侧换算成 offsets
                    const unchanged = []
                    let original = 0, unchangedIdx = 0
                    for (let j = 0; j < changed; j++) {
                        const slot = int()
                        while (original !== slot) unchanged[unchangedIdx++] = original++
                        const offset = int()
                        pairs.push([slot, offset])
                        slots2[original + offset] = original++
                    }
                    while (original < slotCount) unchanged[unchangedIdx++] = original++
                    for (let j = slotCount - 1; j >= 0; j--) if (slots2[j] === -1) slots2[j] = unchanged[--unchangedIdx]
                    drawOrder.push({ time, pairs, slots: slots2 })
                }
            }
        }

        const animEvents = []
        { const n = int()
            if (n > 0) {
                for (let i = 0; i < n; i++) {
                    const time = f32()
                    const eventIndex = int()
                    const ev = events[eventIndex]
                    const intValue = intSigned()
                    const floatValue = f32()
                    const stringValue = bool() ? str() : ev?.stringValue ?? null
                    let volume, balance
                    if (ev?.audioPath != null) { volume = f32(); balance = f32() }
                    animEvents.push({ time, eventIndex, intValue, floatValue, stringValue, volume, balance })
                }
            }
        }

        return { name, slots: slotsTimelines, bones: boneTimelines, ik: ikTimelines, transform: transformTimelines, path: pathTimelines, deform: deformTimelines, drawOrder, events: animEvents }
    }

    return { hash, version, x, y, width, height, nonessential, fps, imagesPath, audioPath, strings, bones, slots, ik, transform, path, skins, events, animations }
}

// ---------- spine 3.8 JSON 转换（供 3.8 系运行时如 @pixi-spine/runtime-3.8 直接加载） ----------

const rgbaHex = (v) => {
    const r = (v >>> 24) & 0xff, g = (v >>> 16) & 0xff, b = (v >>> 8) & 0xff, a = v & 0xff
    return [r / 255, g / 255, b / 255, a / 255]
}
// pixi-spine 的 JSON 曲线是四个独立键 curve/c2/c3/c4（官方 spine 是数组 curve:[...]），按运行时为准
const curveJson = (f) =>
    f.curve === 'stepped'
        ? { curve: 'stepped' }
        : Array.isArray(f.curve)
            ? { curve: f.curve[0], c2: f.curve[1], c3: f.curve[2], c4: f.curve[3] }
            : undefined

const TRANSFORM_MODES = ['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection']
const BLEND_MODES = ['normal', 'additive', 'multiply', 'screen']
const POSITION_MODES = ['fixed', 'percent']
const SPACING_MODES = ['length', 'fixed', 'percent']
const ROTATE_MODES = ['tangent', 'chain', 'chainScale']

export function toSpine38Json(parsed) {
    // 资产修补：美术迭代后附件改名，槽位 setup 名与动画 attachment 时间轴引用的旧名在所有
    // 皮肤表里都解析不到（旧 region 也已从 atlas 删除，皮肤表键名与 atlas 才是现存名）。
    // 按同槽位附件名集合做最长公共前缀修补（如旧名 shentiA -> shentiA_1、datuiLB_2 -> datuiLB_1）；
    // 仅对解析落空的名字动手，合法引用原样保留。deform 引用同理修补，见 animationJson。
    const slotAttNames = new Map() // slotIndex -> 该槽位在各皮肤里的附件名全集
    for (const skin of parsed.skins) {
        for (const att of skin.attachments) {
            let names = slotAttNames.get(att.slot)
            if (!names) { names = new Set(); slotAttNames.set(att.slot, names) }
            names.add(att.name)
        }
    }
    const repairName = (slotIndex, name, candidates) => {
        if (!name) return name
        const cands = candidates ?? slotAttNames.get(slotIndex)
        if (!cands || cands.has(name)) return name
        let best = null
        let bestLen = -1
        for (const c of cands) {
            let n = 0
            const m = Math.min(name.length, c.length)
            while (n < m && name[n] === c[n]) n++
            if (n > bestLen) { bestLen = n; best = c }
        }
        // 唯一候选直接采用；多候选须有公共前缀，否则无从判定不改
        return (cands.size === 1 || bestLen > 0) ? best : name
    }
    const doc = {
        skeleton: {
            hash: parsed.hash,
            spine: parsed.version,
            x: parsed.x, y: parsed.y,
            width: parsed.width, height: parsed.height,
        },
        bones: parsed.bones.map((b) => ({
            name: b.name,
            parent: b.parent,
            rotation: b.rotation,
            x: b.x, y: b.y,
            scaleX: b.scaleX, scaleY: b.scaleY,
            shearX: b.shearX, shearY: b.shearY,
            length: b.length,
            transform: TRANSFORM_MODES[b.mode] ?? 'normal',
            ...(b.skinRequired ? { skin: true } : {}),
        })),
        slots: parsed.slots.map((s, slotIndex) => {
            const [r, g, b, a] = rgbaHex(s.rgba)
            const slot = { name: s.name, bone: s.bone, color: `${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a)}` }
            if (s.attachment) slot.attachment = repairName(slotIndex, s.attachment)
            if (s.blend) slot.blend = BLEND_MODES[s.blend] ?? 'normal'
            return slot
        }),
    }
    if (parsed.ik.length) {
        doc.ik = parsed.ik.map((c) => ({
            name: c.name,
            ...(c.order ? { order: c.order } : {}),
            ...(c.skinRequired ? { skin: true } : {}),
            bones: c.bones.map((i) => parsed.bones[i]?.name),
            target: parsed.bones[c.target]?.name,
            mix: c.mix,
            softness: c.softness,
            bendPositive: c.bend >= 0,
            ...(c.compress ? { compress: true } : {}),
            ...(c.stretch ? { stretch: true } : {}),
            ...(c.uniform ? { uniform: true } : {}),
        }))
    }
    if (parsed.transform.length) {
        doc.transform = parsed.transform.map((c) => ({
            name: c.name,
            ...(c.order ? { order: c.order } : {}),
            ...(c.skinRequired ? { skin: true } : {}),
            bones: c.bones.map((i) => parsed.bones[i]?.name),
            target: parsed.bones[c.target]?.name,
            ...(c.local ? { local: true } : {}),
            ...(c.relative ? { relative: true } : {}),
            rotation: c.offsetRotation,
            x: c.offsetX, y: c.offsetY,
            scaleX: c.offsetScaleX, scaleY: c.offsetScaleY,
            shearY: c.offsetShearY,
            rotateMix: c.rotateMix,
            translateMix: c.translateMix,
            scaleMix: c.scaleMix,
            shearMix: c.shearMix,
        }))
    }
    if (parsed.path.length) {
        doc.path = parsed.path.map((c) => ({
            name: c.name,
            ...(c.order ? { order: c.order } : {}),
            ...(c.skinRequired ? { skin: true } : {}),
            bones: c.bones.map((i) => parsed.bones[i]?.name),
            target: parsed.slots[c.target]?.name,
            positionMode: POSITION_MODES[c.positionMode] ?? 'percent',
            spacingMode: SPACING_MODES[c.spacingMode] ?? 'length',
            rotateMode: ROTATE_MODES[c.rotateMode] ?? 'tangent',
            rotation: c.offsetRotation,
            position: c.position,
            spacing: c.spacing,
            rotateMix: c.rotateMix,
            translateMix: c.translateMix,
        }))
    }

    // skins：pixi-spine 3.8 的 JSON 读取器要数组形态 [{name, attachments:{槽名:{附件名:定义}}}]，
    // 名为 "default" 的皮肤会被运行时自动设为 defaultSkin（官方 spine 新版是按名映射，此处按运行时为准）
    doc.skins = parsed.skins.map((skin) => {
        const attachments = {}
        for (const att of skin.attachments) {
            const slotName = parsed.slots[att.slot]?.name
            if (!slotName) continue
            ;(attachments[slotName] ??= {})[att.name] = attachmentJson(parsed, att)
        }
        return { name: skin.name, attachments }
    })

    if (parsed.events.length) {
        // pixi-spine 3.8 的 JSON 事件表是按事件名键控的映射（官方 spine 是数组，此处按运行时为准）
        doc.events = {}
        for (const e of parsed.events) {
            const ev = { int: e.intValue ?? 0, float: e.floatValue ?? 0, string: e.stringValue ?? '' }
            if (e.audioPath !== null && e.audioPath !== undefined) { ev.audio = e.audioPath; ev.volume = e.volume; ev.balance = e.balance }
            doc.events[e.name] = ev
        }
    }

    doc.animations = {}
    for (const anim of parsed.animations) {
        doc.animations[anim.name] = animationJson(parsed, anim, repairName)
    }
    return doc
}

function hex2(v) { return Math.round(v * 255).toString(16).padStart(2, '0') }

function attachmentJson(parsed, att) {
    switch (att.type) {
        case 0: { // region
            const [r, g, b, a] = rgbaHex(att.rgba)
            return {
                type: 'region',
                path: att.path,
                rotation: att.rotation,
                x: att.x, y: att.y,
                scaleX: att.scaleX, scaleY: att.scaleY,
                width: att.width, height: att.height,
                color: `${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a)}`,
            }
        }
        case 1: // boundingbox
            return {
                type: 'boundingbox',
                vertexCount: att.worldVerticesLength / 2,
                vertices: att.bones ? weightedFlat(att) : att.vertices,
            }
        case 2: { // mesh
            const [r, g, b, a] = rgbaHex(att.rgba)
            return {
                type: 'mesh',
                path: att.path,
                color: `${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a)}`,
                uvs: att.uvs,
                triangles: att.triangles,
                vertices: att.bones ? weightedFlat(att) : att.vertices,
                hull: (att.hull ?? 0),
                ...(att.edges ? { edges: att.edges } : {}),
                ...(att.w !== undefined ? { width: att.w, height: att.h } : {}),
            }
        }
        case 3: { // linkedmesh
            const [r, g, b, a] = rgbaHex(att.rgba)
            return {
                type: 'linkedmesh',
                path: att.path,
                color: `${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a)}`,
                skin: att.skin ?? undefined,
                parent: att.parent,
                deform: att.inheritDeform,
                ...(att.w !== undefined ? { width: att.w, height: att.h } : {}),
            }
        }
        case 4: // path attachment
            return {
                type: 'path',
                closed: att.closed,
                constantSpeed: att.constantSpeed,
                vertexCount: att.worldVerticesLength / 2,
                vertices: att.bones ? weightedFlat(att) : att.vertices,
                lengths: att.lengths,
            }
        case 5: // point
            return { type: 'point', rotation: att.rotation, x: att.x, y: att.y }
        case 6: { // clipping
            // pixi-spine 3.8 的 JSON 读取器按 end 键取结束槽名（findSlot），不是序号
            return {
                type: 'clipping',
                end: parsed.slots[att.endSlot]?.name,
                vertexCount: att.worldVerticesLength / 2,
                vertices: att.bones ? weightedFlat(att) : att.vertices,
            }
        }
        default:
            throw new Error(`spineSkel: 未知附件类型 ${att.type}`)
    }
}

// 加权顶点：pixi-spine 的 JSON 布局为单 vertices 平铺数组 [boneCount, boneIdx, x, y, weight, ...]，
// 运行时以 vertices.length 对比 worldVerticesLength/uvs.length 判定加权，不读独立 bones 字段。
// 解析树的 bones 里穿插每顶点 count，verts 的三元组按骨骼绑定出现顺序 1:1 对齐，用独立游标取值
function weightedFlat(att) {
    const out = []
    let i = 0
    let v = 0
    const bones = att.bones
    const verts = att.vertices
    while (i < bones.length) {
        const count = bones[i++]
        out.push(count)
        for (let j = 0; j < count; j++) {
            out.push(bones[i++], verts[v], verts[v + 1], verts[v + 2])
            v += 3
        }
    }
    return out
}

function animationJson(parsed, anim, repairName) {
    const out = {}

    // slots：attachment / color / twoColor（pixi-spine 3.8 键名，两色用 light/dark 色串）
    for (const tl of anim.slots) {
        const slotName = parsed.slots[tl.slotIndex]?.name
        if (!slotName) continue
        const s = (out.slots ??= {})[slotName] ??= {}
        if (tl.type === 0) {
            s.attachment = tl.frames.map((f) => ({ time: f.time, name: repairName(tl.slotIndex, f.name) }))
        } else if (tl.type === 1) {
            s.color = tl.frames.map((f) => {
                const [r, g, b, a] = rgbaHex(f.rgba)
                return { time: f.time, color: colorArray(r, g, b, a), ...(curveJson(f) ?? {}) }
            })
        } else {
            s.twoColor = tl.frames.map((f) => {
                const [r, g, b, a] = rgbaHex(f.rgba)
                const [, r2, g2, b2] = rgbaHex2(f.rgba2)
                return { time: f.time, light: colorArray(r, g, b, a), dark: colorArray(r2, g2, b2, -1), ...(curveJson(f) ?? {}) }
            })
        }
    }

    // bones：rotate / translate / scale / shear
    for (const tl of anim.bones) {
        const boneName = parsed.bones[tl.boneIndex]?.name
        if (!boneName) continue
        const b = (out.bones ??= {})[boneName] ??= {}
        const kind = ['rotate', 'translate', 'scale', 'shear'][tl.type]
        b[kind] = tl.frames.map((f) => ({
            time: f.time,
            ...(tl.type === 0 ? { angle: f.value } : { x: f.x, y: f.y }),
            ...(curveJson(f) ?? {}),
        }))
    }

    // 约束时间轴：pixi-spine 3.8 用按约束名键控的映射（官方 spine 是数组，此处按运行时为准）
    if (anim.ik.length) {
        out.ik = {}
        for (const tl of anim.ik) {
            const name = parsed.ik[tl.ikIndex]?.name
            if (!name) continue
            out.ik[name] = framesJson(tl.frames, (f) => ({ time: f.time, mix: f.mix, softness: f.softness, bendPositive: f.bend >= 0, compress: f.compress, stretch: f.stretch }))
        }
    }
    if (anim.transform.length) {
        out.transform = {}
        for (const tl of anim.transform) {
            const name = parsed.transform[tl.tcIndex]?.name
            if (!name) continue
            out.transform[name] = framesJson(tl.frames, (f) => ({ time: f.time, rotateMix: f.rotateMix, translateMix: f.translateMix, scaleMix: f.scaleMix, shearMix: f.shearMix }))
        }
    }
    if (anim.path.length) {
        out.path = {}
        for (const tl of anim.path) {
            const name = parsed.path[tl.pcIndex]?.name
            if (!name) continue
            const p = (out.path[name] ??= {})
            if (tl.type === 0) {
                (p.position ??= []).push(...framesJson(tl.frames, (f) => ({ time: f.time, position: f.value })))
            } else if (tl.type === 1) {
                (p.spacing ??= []).push(...framesJson(tl.frames, (f) => ({ time: f.time, spacing: f.value })))
            } else {
                (p.mix ??= []).push(...framesJson(tl.frames, (f) => ({ time: f.time, rotateMix: f.rotateMix, translateMix: f.translateMix })))
            }
        }
    }

    // deform：skinName -> slotName -> attachmentName -> frames。
    // 引用名先经旧名修补（候选集 = 该皮肤在该槽位的附件名），修补后仍落空的条目丢弃
    //（游戏读取器对缺失附件静默跳过，3.8 JSON 读取器严格解析会整体抛错）。
    const skinAttachments = new Map()
    for (const skin of parsed.skins) {
        const bySlot = new Map()
        for (const att of skin.attachments) {
            let names = bySlot.get(att.slot)
            if (!names) { names = new Set(); bySlot.set(att.slot, names) }
            names.add(att.name)
        }
        skinAttachments.set(skin.name, bySlot)
    }
    for (const tl of anim.deform) {
        const skinName = parsed.skins[tl.skinIndex]?.name
        const slotName = parsed.slots[tl.slotIndex]?.name
        if (!skinName || !slotName) continue
        const attName = repairName(tl.slotIndex, tl.attachmentName, skinAttachments.get(skinName)?.get(tl.slotIndex))
        if (!skinAttachments.get(skinName)?.get(tl.slotIndex)?.has(attName)) continue
        const d = (out.deform ??= {})[skinName] ??= {}
        const s = (d[slotName] ??= {})[attName] ??= []
        for (const f of tl.frames) {
            s.push({ time: f.time, ...(f.end !== 0 ? { offset: f.start, vertices: f.vertices } : { vertices: [] }), ...(curveJson(f) ?? {}) })
        }
    }

    if (anim.drawOrder.length) {
        // pixi-spine 3.8 用 offsets 对（槽名 + 偏移），运行时按同一算法复原次序
        out.drawOrder = anim.drawOrder.map((f) => ({
            time: f.time,
            ...(f.pairs.length ? { offsets: f.pairs.map(([slot, offset]) => ({ slot: parsed.slots[slot]?.name, offset })) } : {}),
        }))
    }
    if (anim.events.length) {
        out.events = anim.events.map((f) => ({
            time: f.time,
            name: parsed.events[f.eventIndex]?.name,
            int: f.intValue, float: f.floatValue, string: f.stringValue,
            ...(f.volume !== undefined ? { volume: f.volume, balance: f.balance } : {}),
        }))
    }
    return out
}

function framesJson(frames, map) {
    return frames.map((f) => ({ ...map(f), ...(curveJson(f) ?? {}) }))
}

const hex2c = (v) => Math.round(v * 255).toString(16).padStart(2, '0')
function colorArray(r, g, b, a) {
    // 3.8 JSON color 是 "rrggbb" 或 "rrggbbaa" 字符串；a<0 表示不带 alpha
    return a < 0 ? `${hex2c(r)}${hex2c(g)}${hex2c(b)}` : `${hex2c(r)}${hex2c(g)}${hex2c(b)}${hex2c(a)}`
}
function rgbaHex2(v) {
    const r = (v >>> 16) & 0xff, g = (v >>> 8) & 0xff, b = v & 0xff
    return [0, r / 255, g / 255, b / 255]
}
