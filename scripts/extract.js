// 碧蓝航线 Live2D 皮肤提取器：UnityFS bundle -> 标准 Cubism 4 模型。
//
// 用法:
//     node scripts/extract.js <skin_id>
//     node scripts/extract.js <painting 名>
//     node scripts/extract.js <bundle_path> <out_dir>   # 兼容旧用法
//
// 可选: --server CN（Lua 快照服务器目录）  --painting <名>  --no-lua（跳过 l2d.json 烘焙）
//
// 产物 (out_dir) —— 一次提取即完整模型资源，逆向无需再回头 dump:
//
//     <id>.moc3 / <id>.model3.json / <id>.physics3.json / <id>.char.json
//     <id>.interaction.json   （clips 交互状态数据 + animator 动作编号路由表）
//     <id>.fades.json         Animator 转场时长表（逐 clip 交叉渐变秒数）
//     <id>.defaults.json      参数默认值/min/max（解析自 moc3 二进制）
//     <id>.inventory.json     bundle 全量参考：GameObject 表、全部组件 typetree（CubismMoc._bytes 除外）、AnimationClip 事件与绑定
//     textures/texture_XX.png
//     motions/<clip_name>.motion3.json
//
// 原理 (见 docs/azurlane.md):
//     - CubismMoc._bytes 直接是 moc3 二进制
//     - 贴图 Texture2D（ASTC 走 texture2ddecoder-wasm 自补分支）-> PNG
//     - TextAsset *.physics3 为 JSON 原文，但包内这份缺每条设置的 Input.Normalization（游戏运行时物理用
//       CubismPhysicsController._rig 序列化数据，不经这份 JSON）——落盘时按 _rig.SubRigs[i].Normalization
//       逐条注入补齐；非 UTF-8 的 TextAsset 落 .bin 原始字节
//     - Unity AnimationClip (streamed+constant 曲线, CRC32 哈希绑定) -> motion3.json
//     - moc3 默认值：头部 0x40 起是节偏移表，表[51/52/53]=max/min/defaults（详见 extract/moc3.js）

import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import process from 'node:process'

import { loadBundle, resolveHashBindings, pathID } from './extract/bundle.js'
import { crc32, CRC_MOUTH, convertClip, motion3Json, clipEvents, clipBoundaryState, LOOP_GROUPS, clipGroup } from './extract/motion.js'
import { animatorRouting, animatorFades } from './extract/animator.js'
import { moc3ParamTables } from './extract/moc3.js'
import { injectPhysicsNormalization } from './extract/physics.js'
import { bakeL2d } from './extract/lua.js'
import { isAstcFormat, decodeAstcTexture } from './extract/texture.js'

// 固定路径约定：bundle 由 pull_bundles.js 拉到 .tmp/bundles/<skin_id>，产物按 models/<角色>/<skin_id>/ 归档（scan_models.mjs 按此路径生成清单）
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_DIR = resolve(ROOT, '.tmp', 'bundles')
const MODEL_ROOT = resolve(ROOT, 'models')

const crc32Str = (s) => crc32(s)

// 模型 id -> 角色目录名：fulici_2 -> fulici，shengluyisi_2 -> shengluyisi
function charName(modelId) {
    return modelId.replace(/_\d+$/, '')
}

const warn = (msg) => console.log(`[warn] ${msg}`)
const info = (msg) => console.log(msg)
// 管线进度里程碑：stdout 输出 [progress] <0-100> <阶段>，dev server 解析成 job.progress 透传前端进度条
const progress = (pct, label) => info(`[progress] ${pct} ${label}`)

// int64 路径 ID：安全整数落 number，超出的落十进制字符串（JS number 有精度上限，直写会失真）
const jsonReplacer = (k, v) =>
    typeof v === 'bigint'
        ? v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(v)
            : v.toString()
        : v

function parseArgs(argv) {
    const args = { source: null, outDir: null, server: 'CN', painting: null, noLua: false }
    const rest = []
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        switch (a) {
            case '--server': args.server = argv[++i]; break
            case '--painting': args.painting = argv[++i]; break
            case '--no-lua': args.noLua = true; break
            default: rest.push(a)
        }
    }
    if (!rest.length || rest.length > 2) {
        console.error('用法: node scripts/extract.js <skin_id|painting|bundle路径> [out_dir] [--server CN] [--painting 名] [--no-lua]')
        process.exit(1)
    }
    args.source = rest[0]
    args.outDir = rest[1] ?? null
    return args
}

async function main() {
    const args = parseArgs(process.argv.slice(2))

    // 只传 skin_id/painting 时 bundle 与输出目录按固定约定推导；传完整路径则沿用旧用法。
    let bundlePath = args.source
    if (!existsFile(bundlePath)) bundlePath = join(BUNDLE_DIR, args.source)
    if (!existsFile(bundlePath)) {
        console.error(`bundle 不存在: ${bundlePath}`)
        process.exit(1)
    }
    const modelId = basename(bundlePath).replace(/\.[^.]+$/, '') // 如 fulici_2
    const outDir = args.outDir ? resolve(args.outDir) : join(MODEL_ROOT, charName(modelId), modelId)
    mkdirSync(outDir, { recursive: true })
    mkdirSync(join(outDir, 'textures'), { recursive: true })
    mkdirSync(join(outDir, 'motions'), { recursive: true })

    const bundle = await loadBundle(bundlePath)
    const { scripts, pathHash } = resolveHashBindings(bundle, crc32Str)

    const goNames = new Map() // path_id -> 名（inventory gameobjects 表 + 组件反查 GameObject 名）
    for (const info of bundle.byClass('GameObject')) {
        goNames.set(info.pathID, bundle.readTypetree(info).m_Name)
    }
    progress(5, 'bundle 解析')

    // --- moc3 / 贴图 / physics / Live2dChar（同时收集全量 inventory 记录）
    const textureNames = []
    const textureJobs = [] // ASTC 解码是异步的，先记任务再统一执行（保持 objects 枚举次序）
    const textAssets = new Map() // 名 -> 原始字节（落盘时按可否严格解码决定 .json/.bin，保证无损）
    const monoRecords = [] // inventory: 全部 MonoBehaviour (path_id, 脚本类名, typetree)
    let mocBytes = null
    let live2dChar = null
    let physicsRig = null // CubismPhysicsController._rig：物理归一化区间的权威来源（包内 physics3.json 缺这块）
    const raycastables = []
    const paramsUi = new Map() // CubismParameter _unmanagedIndex -> 参数 id（GO 名即参数 id）
    let mouthCtrl = null // CubismMouthController typetree（根对象，动作可动画其 MouthOpening 字段）
    const mouthParams = [] // CubismMouthParameter 标记的参数 id（口控制器 Destinations，即 MouthOpening 的实际写入口）

    for (const info of bundle.infos) {
        const tname = info.className
        if (tname === 'Texture2D') {
            textureNames.push(info.name)
            textureJobs.push({ info, name: info.name })
        } else if (tname === 'TextAsset') {
            textAssets.set(info.name, info.object.data)
        } else if (tname === 'MonoBehaviour') {
            let tree
            try {
                tree = bundle.readTypetree(info)
            } catch (e) {
                // typetree 缺失/解析失败，inventory 记录原因
                monoRecords.push({ path_id: info.pathID, error: String(e.message ?? e) })
                continue
            }
            const cls = scripts.get(pathID(tree.m_Script?.m_PathID ?? 0))
            monoRecords.push({ path_id: info.pathID, script: cls, tree })
            if (cls === 'CubismMoc' && mocBytes === null) {
                mocBytes = Buffer.from(tree._bytes)
            } else if (cls === 'Live2dChar' && live2dChar === null) {
                live2dChar = Object.fromEntries(Object.entries(tree).filter(([k]) => !k.startsWith('m_')))
            } else if (cls === 'CubismPhysicsController' && physicsRig === null) {
                physicsRig = tree._rig
            } else if (cls === 'CubismRaycastable') {
                const gid = pathID(tree.m_GameObject.m_PathID)
                raycastables.push(goNames.get(gid) ?? `mesh_${info.pathID}`)
            } else if (cls === 'CubismMouthController' && mouthCtrl === null) {
                mouthCtrl = tree
            } else if (cls === 'CubismMouthParameter') {
                const pid = goNames.get(pathID(tree.m_GameObject.m_PathID))
                if (pid !== undefined) mouthParams.push(pid)
            } else if (cls === 'CubismParameter') {
                const pid = goNames.get(pathID(tree.m_GameObject.m_PathID))
                if (pid !== undefined) paramsUi.set(tree._unmanagedIndex, pid)
            }
        }
    }

    if (!mocBytes || mocBytes.subarray(0, 4).toString('latin1') !== 'MOC3') {
        throw new Error('未找到 CubismMoc 数据')
    }
    writeFileSync(join(outDir, `${modelId}.moc3`), mocBytes)

    // --- 贴图落盘（ASTC 走自补分支，其余交给 unityfs-js 解码管线）
    for (const [index, { info, name }] of textureJobs.entries()) {
        const tex = info.object
        const png = isAstcFormat(tex.textureFormat)
            ? (await decodeAstcTexture(tex, bundle.manager)).png
            : Buffer.from((await bundle.manager.exportFile(info, { type: 'uint8Array' })).data.raw)
        writeFileSync(join(outDir, 'textures', `${name}.png`), png)
        progress(textureJobs.length ? 5 + Math.round(45 * (index + 1) / textureJobs.length) : 50, `贴图 ${index + 1}/${textureJobs.length}`)
    }

    // --- moc3 参数默认值/min/max（逆向状态机的初始态 = 默认态）
    let paramRanges = null
    if (paramsUi.size) {
        const tables = moc3ParamTables(mocBytes, Math.max(...paramsUi.keys()) + 1)
        if (tables) {
            const { maxs, mins, defs } = tables
            const defaults = {}
            for (const i of [...paramsUi.keys()].sort((a, b) => a - b)) {
                defaults[paramsUi.get(i)] = { default: defs[i], min: mins[i], max: maxs[i] }
            }
            writeFileSync(join(outDir, `${modelId}.defaults.json`), JSON.stringify(defaults, null, 2))
            paramRanges = new Map(Object.entries(defaults))
        } else {
            warn('moc3 参数表(min/max/defaults)解析失败，跳过 defaults.json')
        }
    }

    // 根对象 MouthOpening 曲线迁移目标：CubismMouthParameter 标记的参数（游戏 LateUpdate 按 BlendMode 覆写口参数）
    // BlendMode 只有 Override(0) 能表达为参数曲线（直接覆写），Additive/Multiply 与动作混合语义无法在 motion3 落笔，不迁移
    const rootTargets = new Map()
    if (mouthCtrl && mouthParams.length) {
        if ((mouthCtrl.BlendMode ?? 0) !== 0) {
            warn('CubismMouthController.BlendMode 非 Override，MouthOpening 曲线不迁移')
        } else {
            if (mouthParams.length > 1) warn(`口参数标记多个(${mouthParams.join(',')})，只迁移第一个`)
            rootTargets.set(CRC_MOUTH, [mouthParams[0], 'Parameter'])
        }
    }

    const decoder = new TextDecoder('utf-8', { fatal: true })
    for (const [name, raw] of textAssets) {
        let text
        try {
            text = decoder.decode(raw)
        } catch {
            writeFileSync(join(outDir, `${name}.bin`), raw) // 非 UTF-8 资产存原始字节
            continue
        }
        if (name === `${modelId}.physics3` && physicsRig) {
            // 包内 physics3.json 缺 Input.Normalization（游戏运行时用 _rig 不用这份），按 _rig 逐条注入补齐
            text = injectPhysicsNormalization(text, physicsRig, warn)
        }
        writeFileSync(join(outDir, `${name}.json`), text)
    }

    if (live2dChar) {
        writeFileSync(join(outDir, `${modelId}.char.json`), JSON.stringify(live2dChar, jsonReplacer, 2))
    }

    // --- 动画
    const motionGroups = {}
    const interactionClips = {}
    const invClips = [] // inventory: 每个 AnimationClip 的事件与原始绑定
    const clips = [...bundle.byClass('AnimationClip')]
    progress(55, '动作转换')
    for (const [index, info] of clips.entries()) {
        const clip = bundle.readTypetree(info)
        const bindings = clip.m_ClipBindingConstant.genericBindings
        const { curves, duration } = convertClip(
            clip.m_MuscleClip.m_Clip.data,
            clip.m_MuscleClip,
            bindings,
            pathHash,
            clip.m_Name,
            warn,
            rootTargets,
        )
        // 交互状态机数据：AnimationEvent + 开关型/连续型参数的首末值（见 motion.js 注释）
        const events = clipEvents(clip)
        const { state: boundary, carry } = clipBoundaryState(
            clip.m_MuscleClip.m_Clip.data,
            bindings,
            pathHash,
            paramRanges,
        )
        invClips.push({
            name: clip.m_Name,
            events,
            bindings: bindings.map((b) => ({ path: b.path, attribute: b.attribute, typeID: b.typeID })),
        })
        if (Object.keys(boundary).length || Object.keys(carry).length || events.length) {
            interactionClips[clip.m_Name] = {
                duration: Number(duration.toFixed(3)),
                events,
                state: boundary,
                carry,
            }
        }
        if (!curves.length) {
            warn(`${clip.m_Name}: 无可解析曲线`)
            continue
        }
        const group = clipGroup(clip.m_Name)
        const loop = LOOP_GROUPS.has(group)
        writeFileSync(join(outDir, 'motions', `${clip.m_Name}.motion3.json`), JSON.stringify(motion3Json(curves, duration, loop)))
        if (!motionGroups[group]) motionGroups[group] = []
        motionGroups[group].push({ File: `motions/${clip.m_Name}.motion3.json` })
        progress(clips.length ? 55 + Math.round(35 * (index + 1) / clips.length) : 90, `动作 ${index + 1}/${clips.length}`)
    }

    // --- model3.json
    // Raycastable 网格名即原版点击分区 (TouchHead/TouchBody/TouchIdle3/...)，加下划线、保留序号后作为命中区名 = 对应动作文件名 (TouchIdle3 -> touch_idle3)。
    // 分区与动作一一对应，点哪个部位播哪支；不能剥掉序号归组，否则同名命中区在 pixi-live2d-display 里会互相覆盖，且无法定位到具体动作。
    const hitAreaName = (mesh) => {
        const name = mesh.toLowerCase()
        return name.startsWith('touch') ? `touch_${name.slice(5)}` : name
    }
    const hitAreas = raycastables.map((mesh) => ({ Id: mesh, Name: hitAreaName(mesh) }))

    const fileRefs = {
        Moc: `${modelId}.moc3`,
        Textures: textureNames.slice().sort().map((n) => `textures/${n}.png`),
    }
    if (textAssets.has(`${modelId}.physics3`)) fileRefs.Physics = `${modelId}.physics3.json`
    fileRefs.Motions = motionGroups
    const model3 = { Version: 3, FileReferences: fileRefs, HitAreas: hitAreas }
    writeFileSync(join(outDir, `${modelId}.model3.json`), JSON.stringify(model3, null, 2))

    // --- 交互状态机数据（本项目扩展文件，标准运行时忽略）
    // clips: 每支动作的 AnimationEvent（OnAnimEvent/OnFinishAnim 状态编号）与开关型参数的首/末值（[起, 止]，跨动作持续的菜单/道具开关）。
    // animator: AnimatorController 状态路由表（状态 -> 动作编号 -> clip），OnFinishAnim(N) 即结束时回写的动作编号。
    // 运行时据此实现：点击门控（仅菜单摊开时可点菜单分支）、跨动作保留状态参数、动作结束上报状态编号。
    const interactionData = { clips: interactionClips }
    const ctrlInfo = bundle.byClass('AnimatorController')[0]
    if (ctrlInfo) {
        const ctrl = bundle.readTypetree(ctrlInfo)
        const clipNames = new Map(bundle.byClass('AnimationClip').map((i) => [i.pathID, i.name]))
        interactionData.animator = animatorRouting(ctrl, clipNames, warn)
    } else {
        warn('未找到 AnimatorController，跳过路由表')
    }
    writeFileSync(join(outDir, `${modelId}.interaction.json`), JSON.stringify(interactionData, null, 2))

    // --- 逐 clip 转场时长表（fades.json）
    if (ctrlInfo) {
        const ctrl = bundle.readTypetree(ctrlInfo)
        const clipNames = new Map(bundle.byClass('AnimationClip').map((i) => [i.pathID, i.name]))
        const fades = animatorFades(ctrl, clipNames, warn)
        if (fades) {
            writeFileSync(join(outDir, `${modelId}.fades.json`), JSON.stringify(fades, null, 1))
        } else {
            warn('未找到 AnimatorController 转场时长，跳过 fades.json')
        }
    } else {
        warn('未找到 AnimatorController 转场时长，跳过 fades.json')
    }

    // --- bundle 全量参考数据（逆向用；CubismMoc._bytes 已是 .moc3 文件，剔除避免重复）
    for (const rec of monoRecords) {
        if (rec.script === 'CubismMoc') {
            rec.tree = Object.fromEntries(Object.entries(rec.tree).filter(([k]) => k !== '_bytes'))
        }
    }
    const relBundle = bundlePath.startsWith(ROOT) ? bundlePath.slice(ROOT.length + 1).replaceAll('\\', '/') : bundlePath
    const objects = {}
    for (const t of [...new Set(bundle.infos.map((i) => i.className))].sort()) {
        objects[t] = bundle.byClass(t).length
    }
    const gameobjects = {}
    for (const [pid, name] of goNames) gameobjects[pid.toString()] = name
    const inventory = {
        bundle: relBundle,
        objects,
        gameobjects,
        monobehaviours: monoRecords,
        animationclips: invClips.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    }
    // int64 路径 ID：安全整数落 number，超出的落十进制字符串（JS number 有精度上限，直写会失真）
    writeFileSync(join(outDir, `${modelId}.inventory.json`), JSON.stringify(inventory, jsonReplacer))
    progress(95, '交互配置与清单')

    if (!args.noLua) {
        const skinRef = args.painting ?? (isFilePath(args.source) ? modelId : args.source)
        progress(97, 'l2d 交互配置')
        try {
            bakeL2d(ROOT, outDir, modelId, args.server, skinRef, { info, warn })
        } catch (e) {
            warn(`l2d.json 烘焙失败，基础模型已完成: ${e.message}`)
        }
    }
    progress(100, '完成')

    info(`完成: ${modelId}`)
    info(`  贴图 ${textureNames.length}, 动作组 ${JSON.stringify(Object.fromEntries(Object.entries(motionGroups).map(([k, v]) => [k, v.length])))}`)
    info(`  Live2dChar: ${JSON.stringify(live2dChar).slice(0, 200)}`)
}

function existsFile(p) {
    try {
        return statSync(p).isFile()
    } catch {
        return false
    }
}

function isFilePath(p) {
    return existsFile(p)
}

function basename(p) {
    const norm = p.replaceAll('\\', '/')
    return norm.slice(norm.lastIndexOf('/') + 1)
}

main()
