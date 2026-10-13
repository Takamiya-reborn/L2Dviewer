/**
 * moc3 资产静态阅读探针（通用 CLI）：用 Cubism Core 直读 moc3/model3.json，按子命令打印各侧面摘要。
 *
 * 用法（仓库根目录）：node scripts/tests/probe/moc3.mjs <皮肤目录|moc3> <子命令> [参数]
 *
 *   params [–param 子串] [--check] [--all]
 *       参数表（id / min / max / default / 类型）。--check 与同目录 l2d.json 的拖拽参数机配置交叉核对——机器写入值会被
 *       模型参数区间二次钳制（Cubism 参数落在 [min,max] 之外取边界），machine.range 或 action_trigger.num 超出模型
 *       区间的配置在游戏里同样到不了位；type 4 的 num 不在 machine.range ±25% 邻域内则恒不可达（wuzang_3 的
 *       TouchDrag11/12 即此类）。排查"按档位/按位置的事件不出现"先跑这个：配置侧不可达的，移植端无病可修。
 *   textures            drawable 的 textureIndex 分布、part/drawable 计数（可给多个皮肤目录）
 *   uvs                 按 textureIndex 汇总 drawable 的 UV 范围（可给多个皮肤目录）
 *   parts               初始 part opacity 分布及由此推算的 drawable 可见性（可给多个皮肤目录）
 *   hitop               HitAreas 对应 drawable 的初始透明度与渲染顺序（可给多个皮肤目录）
 *   hits [--at clip@t ...] [--param pid=v ...]
 *       命中区解析（还原 pixi-live2d-display 的 internalModel.hitAreas）：各命中区网格包围盒（画布 px，数值天然巨大
 *       是正常的——moc3 画布空间，wuzang_3 画布 8000×8000，背景板级判定区即 4374×4000 量级），并与 l2d.json 的
 *       draw_able_name 按查看器同规则归一化核对，标出两侧对不上的分区。屏幕 px / 占视口高比例依赖实时取景，
 *       静态探针不可复算，只出画布 px。keyform 开关参数会整体拽动判定面网格，--at 按动作曲线@t、--param 按
 *       覆盖值重算判定框。
 */
import fs from 'fs'
import path from 'path'
import { loadMocModel } from '../helpers/cubism.mjs'
import { loadMotion, sampleMotionAt } from '../helpers/motion3.mjs'
import { drawableBounds } from '../helpers/geometry.mjs'
import { normalizeZone, readJson, resolveModelDir } from '../helpers/model_files.mjs'

const argv = process.argv.slice(2)

/** 从参数表抽出 `--name <值>`（原位删除），找不到返回 null */
function flagOf(list, name) {
  const i = list.indexOf(name)
  return i >= 0 ? list.splice(i, 2)[1] : null
}

/** 单/多皮肤目录统一装载 */
async function loadTargets(targets) {
  const models = []
  for (const target of targets) {
    const dir = resolveModelDir(target)
    models.push({ dir, ...(await loadMocModel(dir)) })
  }
  return models
}

// ---- params：参数表 + l2d.json 交叉核对 ----
async function params(rest) {
  const [target, list] = [rest[0], rest.slice(1)]
  const showAll = list.includes('--all')
  const check = list.includes('--check')
  const paramFilter = flagOf(list, '--param')?.toLowerCase() ?? null

  const dir = resolveModelDir(target)
  const loaded = await loadMocModel(dir)
  const model = loaded.model
  const l2dFile = path.join(dir, `${loaded.name}.l2d.json`)
  const l2d = fs.existsSync(l2dFile) ? readJson(l2dFile) : null

  const P = model.parameters
  const rows = P.ids.map((id, i) => ({
    id,
    min: P.minimumValues[i],
    max: P.maximumValues[i],
    def: P.defaultValues[i],
    type: P.types?.[i],
  }))

  console.log(`${path.join(dir, loaded.name + '.moc3')} 参数 ${rows.length} 条`)
  const ci = model.canvasinfo
  console.log(`canvas ${ci.CanvasWidth}x${ci.CanvasHeight} (origin ${ci.CanvasOriginX},${ci.CanvasOriginY}) PPU=${ci.PixelsPerUnit}`)

  let shown = 0
  if (!check || paramFilter) {
    for (const r of rows) {
      if (paramFilter && !r.id.toLowerCase().includes(paramFilter)) continue
      if (!showAll && !paramFilter && r.min === r.def && r.max === r.def) continue
      console.log(
        `${r.id.padEnd(28)} min=${String(r.min).padStart(8)}  max=${String(r.max).padStart(8)}  def=${String(r.def).padStart(8)}`,
      )
      shown++
    }
    if (!paramFilter && !showAll) {
      console.log(`（其余 ${rows.length - shown} 条 min=max=def 已省略，--all 全打印）`)
    }
  }

  if (!check) return
  if (!l2d) {
    console.log('--check：目录下无 l2d.json，跳过交叉核对')
    return
  }

  console.log('\n== l2d.json 机器区间 vs moc3 参数区间 ==')
  let flagged = 0
  for (const e of l2d.entries) {
    const pid = e.parameter
    const i = pid ? P.ids.indexOf(pid) : -1
    const [lo, hi] = i >= 0 && P.minimumValues[i] < P.maximumValues[i]
      ? [P.minimumValues[i], P.maximumValues[i]]
      : [null, null]
    const mr = Array.isArray(e.range) ? e.range : null
    const issues = []
    if (pid && i < 0) {
      issues.push(`参数 ${pid} 不在模型里（机器只记账不写值）`)
    } else if (mr && lo != null && (mr[0] < lo - 1e-6 || mr[1] > hi + 1e-6)) {
      issues.push(`machine.range [${mr}] 超出模型 [${lo},${hi}]，越界段被钳掉`)
    }
    const at = e.action_trigger
    if (at?.type === 4 && Array.isArray(at.num) && mr) {
      // type 4 触发值 = fix(offsetDrag) ∈ machine.range，num 不在 range ±25% 邻域内则恒不可触发
      const [n0, n1] = at.num
      const inReach = (n) => n >= mr[0] - Math.abs(n) * 0.25 && n <= mr[1] + Math.abs(n) * 0.25
      if (!inReach(n0) || !inReach(n1)) {
        issues.push(`action_trigger.num [${n0},${n1}] 不在 machine.range [${mr}] 的 ±25% 邻域内，恒不可触发`)
      }
    }
    if (issues.length) {
      flagged++
      console.log(`✗ ${e.id} ${e.draw_able_name} (${pid || '无参数'})`)
      for (const s of issues) console.log(`    ${s}`)
    }
  }
  if (!flagged) console.log('（无越界/不可达配置）')
}

// ---- textures：textureIndex 分布与部件计数 ----
async function textures(targets) {
  for (const { model, name } of await loadTargets(targets)) {
    const drawables = model.drawables
    const textureCounts = {}
    let maxTextureIndex = 0
    for (const textureIndex of drawables.textureIndices) {
      textureCounts[textureIndex] = (textureCounts[textureIndex] || 0) + 1
      maxTextureIndex = Math.max(maxTextureIndex, textureIndex)
    }
    console.log(`== ${name}`)
    console.log('  drawables:', drawables.count, 'parts:', model.parts.count)
    console.log('  textureIndex 分布:', textureCounts, 'max:', maxTextureIndex)
    const partIds = Array.from(model.parts.ids || [])
    console.log('  parts 样例:', partIds.slice(0, 10), '... 共', partIds.length)
  }
}

// ---- uvs：按 textureIndex 汇总 UV 范围 ----
async function uvs(targets) {
  for (const { model, name } of await loadTargets(targets)) {
    const { vertexUvs, textureIndices } = model.drawables
    const bounds = new Map()
    for (let i = 0; i < textureIndices.length; i++) {
      const textureIndex = textureIndices[i]
      const bound = bounds.get(textureIndex) ?? {
        minU: Infinity,
        maxU: -Infinity,
        minV: Infinity,
        maxV: -Infinity,
      }
      for (let j = 0; j < vertexUvs[i].length; j += 2) {
        bound.minU = Math.min(bound.minU, vertexUvs[i][j])
        bound.maxU = Math.max(bound.maxU, vertexUvs[i][j])
        bound.minV = Math.min(bound.minV, vertexUvs[i][j + 1])
        bound.maxV = Math.max(bound.maxV, vertexUvs[i][j + 1])
      }
      bounds.set(textureIndex, bound)
    }

    console.log(`== ${name}`)
    for (const [textureIndex, bound] of bounds) {
      console.log(
        `  tex${textureIndex}: U[${bound.minU.toFixed(3)},${bound.maxU.toFixed(3)}] ` +
        `V[${bound.minV.toFixed(3)},${bound.maxV.toFixed(3)}]`,
      )
    }
  }
}

// ---- parts：初始 part opacity 分布与 drawable 可见性 ----
async function parts(targets) {
  for (const { model, name } of await loadTargets(targets)) {
    const partIds = Array.from(model.parts.ids)
    const partOps = model.parts.opacities
    const zero = partIds.filter((_, i) => partOps[i] < 0.01)
    console.log(`== ${name}: parts ${partIds.length}, 初始 opacity=0 的部件 ${zero.length}`)
    if (zero.length) console.log('  零透明度部件:', zero.join(', '))
    // moc3 没有 drawable 到 part 的直接索引，因此这里只看 drawable 自身 opacity。
    const dOps = model.drawables.opacities
    const invis = dOps.reduce((count, opacity) => count + (opacity < 0.01 ? 1 : 0), 0)
    console.log(`  drawable 自身初始 opacity<0.01: ${invis}/${dOps.length}`)
  }
}

// ---- hitop：HitAreas drawable 的初始透明度与渲染顺序 ----
async function hitop(targets) {
  for (const { model, model3, name } of await loadTargets(targets)) {
    const drawables = model.drawables
    console.log(`== ${name}: hit-area drawable opacities`)
    for (const hitArea of model3?.HitAreas ?? []) {
      const index = drawables.ids.indexOf(hitArea.Id)
      if (index < 0) {
        console.log(`${hitArea.Name}: drawable 不存在`)
        continue
      }
      console.log(
        `${hitArea.Name.padEnd(16)} idx=${String(index).padStart(4)} ` +
        `opacity=${drawables.opacities[index]} renderOrder=${drawables.renderOrders[index]} ` +
        `flags=0b${drawables.constantFlags[index].toString(2).padStart(8, '0')}`,
      )
    }
    const zeroTop = drawables.opacities.reduce(
      (count, opacity, index) => count + (opacity < 0.01 && drawables.renderOrders[index] > 900 ? 1 : 0),
      0,
    )
    console.log(`zero-opacity drawables with renderOrder>900: ${zeroTop}`)
  }
}

// ---- hits：命中区解析 + 机器分区核对 + 姿态/参数覆盖下的判定框位移 ----
async function hits(rest) {
  const [target, list] = [rest[0], rest.slice(1)]
  // clip[@t]：该动作曲线 @t 秒的姿态
  const poses = []
  for (let i = 0; i < list.length; i++) if (list[i] === '--at') poses.push(list[++i] ?? '')
  // pid=v：参数覆盖（与各姿态叠加）
  const overrides = []
  for (let i = 0; i < list.length; i++) if (list[i] === '--param') overrides.push(list[++i] ?? '')

  const dir = resolveModelDir(target)
  const { model, model3, name } = await loadMocModel(dir)

  const ci = model.canvasinfo
  console.log(`${path.join(dir, name + '.moc3')} 画布 ${ci.CanvasWidth}x${ci.CanvasHeight}`)

  const hitAreas = model3?.HitAreas ?? []
  const drawableIds = model.drawables.ids
  const areas = hitAreas.map((h) => {
    const index = drawableIds.indexOf(h.Id)
    return { name: h.Name, id: h.Id, index }
  })

  console.log(`\n== HitAreas（model3.json ${areas.length} 条）==`)
  const boxes = new Map()
  for (const a of areas) {
    if (a.index < 0) {
      console.log(`✗ ${a.name} (${a.id}): drawable 不存在（网格缺失或 Id 拼写不符）`)
      continue
    }
    const { minX, minY, maxX, maxY } = drawableBounds(model.drawables, a.index)
    boxes.set(normalizeZone(a.name), a.name)
    console.log(
      `${a.name.padEnd(20)} drawable=${String(a.index).padStart(3)}  ` +
      `判定框(画布px) ${Math.round(maxX - minX)}×${Math.round(maxY - minY)}  ` +
      `范围 x[${Math.round(minX)},${Math.round(maxX)}] y[${Math.round(minY)},${Math.round(maxY)}]`,
    )
  }

  const l2dFile = path.join(dir, `${name}.l2d.json`)
  const l2d = fs.existsSync(l2dFile) ? readJson(l2dFile) : null
  if (!l2d) {
    console.log('\n（目录下无 l2d.json，跳过机器分区核对）')
    return
  }

  console.log('\n== 机器分区（l2d.json draw_able_name）vs HitAreas ==')
  let flagged = 0
  for (const e of l2d.entries) {
    const zone = normalizeZone(e.draw_able_name)
    if (!boxes.has(zone)) {
      flagged++
      console.log(`✗ ${e.draw_able_name} (${e.parameter}): HitAreas 无同名分区，机器路由不会命中`)
    }
  }
  for (const a of areas) {
    const hasMachine = l2d.entries.some((e) => normalizeZone(e.draw_able_name) === normalizeZone(a.name))
    if (!hasMachine) {
      // touch_head/body 等 C# 路径分区本就无机器，走 interaction.json 门控，非异常
      const isDragFamily = /^touch_(drag|idle|special)/i.test(a.name)
      console.log(`${isDragFamily ? '△' : '·'} ${a.name}: 无机器接管${isDragFamily ? '（触摸系分区却走状态机路径？）' : '（C# 路径分区，正常）'}`)
    }
  }
  if (!flagged) console.log('（机器分区与 HitAreas 全部对上）')

  // 姿态/参数覆盖下的判定框位移复核
  // keyform 开关参数会整体拽动判定面网格（如背景板 BANZI 弹出时热点整体跳到板位布局），点击路由随姿态变化——静态初始值之外按动作曲线/参数覆盖重算
  const P = model.parameters
  const idxOfId = new Map(P.ids.map((id, i) => [id, i]))
  function reevaluate(label, motionPairs) {
    for (let i = 0; i < P.count; i++) P.values[i] = P.defaultValues[i]
    for (const spec of overrides) {
      const [pid, v] = spec.split('=')
      const i = idxOfId.get(pid)
      if (i === undefined) {
        console.error(`✗ --param ${spec}: 参数不存在`)
        process.exit(1)
      }
      P.values[i] = Number(v)
    }
    for (const [pid, v] of Object.entries(motionPairs)) {
      const i = idxOfId.get(pid)
      if (i !== undefined) P.values[i] = v
    }
    model.update()
    console.log(`\n== 判定框 @ ${label} ==`)
    for (const a of areas) {
      if (a.index < 0) continue
      const { minX, minY, maxX, maxY } = drawableBounds(model.drawables, a.index)
      console.log(
        `${a.name.padEnd(20)} 范围 x[${Math.round(minX)},${Math.round(maxX)}] y[${Math.round(minY)},${Math.round(maxY)}]`,
      )
    }
  }

  if (overrides.length && !poses.length) reevaluate('default' + (overrides.length ? ` + ${overrides.join(' ')}` : ''), {})
  for (const spec of poses) {
    const [clip, t] = spec.split('@')
    const pairs = sampleMotionAt(loadMotion(dir, clip), t ? Number(t) : 0)
    const suffix = overrides.length ? ` + ${overrides.join(' ')}` : ''
    reevaluate(`${spec}${suffix}`, pairs)
  }
}

const SUB = { params, textures, uvs, parts, hitop, hits }
const USAGE = Object.keys(SUB).join(' | ')

// 子命令可在参数表任意位置（惯例放皮肤目录后），命中即从表里摘出
const subIndex = argv.findIndex((a) => SUB[a])
const subName = subIndex >= 0 ? argv[subIndex] : null
const subRest = argv.filter((_, i) => i !== subIndex)

if (!subName || !subRest.length) {
  console.error(`用法: node scripts/tests/probe/moc3.mjs <皮肤目录|moc3> ${USAGE} [子命令参数]`)
  process.exit(1)
}
await SUB[subName](subRest)
