/**
 * 交互点可视化提示（测试用）：每个命中区一个半透明圆点标在其 drawable 网格顶点质心，外加网格实际形状的绿框轮廓（= 游戏 CubismRaycaster 的精确判定范围，与 meshHitTest 同一几何）。
 * 只画当前可交互的分区（绿）；被挡下（冷却/单触发已播/播放中）、未实现触发类型、无机器的隐藏网格一律不画；机器分区的隐藏网格照画（游戏路由纯几何射线，隐藏但在位的标记照样可触发）；画布内采不到落脚点的出画/被盖分区同样不画（出屏分区游戏里物理上点不到）；位置每帧跟随模型，状态变化（冷却结束/变体切换）时点随之隐现。
 * 可交互判定按真实路由分家：机器分区（ship_l2d 有 draw_able_name 匹配）由拖拽参数机接管，不查 interaction.json 的参数门控——可见性按机器自身的可触发条件（冷却/单触发/播放中/重复 idle 豁免/type 9 点参档位，取编排器路由到的那台，与游戏 GetDragPart 的"注册顺序第一台赢"一致）判定；无机器的分区（touch_head/body 等 C# 路径）才按起播门控（canPlay）判定。
 * 标签显示分区驱动的参数（编排器 l2d.json 的 draw_able_name -> parameter），不用网格自己的名字：部分皮肤的网格名与反应编号是错位的（shengluyisi_5: TouchDrag23 网格驱动 touch_drag25、TouchDrag25 驱动 touch_drag29——游戏 sharecfg ship_l2d 原始数据即如此），按网格名标注会把 drag25 的范围/中心画到 TouchDrag25 网格上，与实际驱动参数对不上。
 * 多台机器共用同一分区时参数用 "+" 连接，无机器的分区（摸头/普通触摸等）沿用网格名；标签整体走紧凑记法（hintText）：剥 touch_/Param 前缀、同族参数只写数字差。
 * 判定引导环：type 11 区间机的判定参数被在播动作扫描时，在判定分区质心叠两层背景圆盘——外盘静止、内盘随扫描值向中心芯收缩（游戏 UI 引导层的同角色复刻，常显不随"显示交互点"开关），内盘边色 = 现值所在区间段。
 */
import { Container, Graphics, Text } from 'pixi.js'
import { boundaryEdges, boundaryLoops, meshHitTest } from './hitTest.js'

/**
 * 交互点提示层工厂：update 每帧调用，返回 HUD 读数（状态参数 + 非默认残留，供测试对照）；提示层未建/隐藏/无运行时时返回 null
 * @param app pixi Application（提示层挂到其 stage）
 * @param getRuntime () => InteractionRuntime | null，每帧取当前运行时
 * @param getVisible () => boolean，提示层开关
 * @param getOrch () => DragOrchestrator | null，拖拽参数机编排器
 * @returns {{ rebuild(model): void, destroy(): void, update(): {state: [string, number][], carried: [string, number][]} | null }}
 */
export function createInteractionHints(app, getRuntime, getVisible, getOrch = null) {
  let layer = null
  let hints = []
  /** drawable 下标 -> 边界环拓扑（顶点下标序列），随模型切换在 rebuild 清空 */
  let loopCache = new Map()
  /** 环序号 -> 全局坐标扁平数组（每帧复用，只重写值） */
  let scratchPolys = new Map()
  /** 分区质心路由缓存：key = idle 变体|在播动作，变了才整体重算——meshHitTest 全 drawable 遍历太重，不能每帧×每分区跑；姿态在变体间漂移小，够诊断用 */
  let routeKey = null
  const routeMap = new Map()
  /** 判定引导环图层（常显，挂 stage 不随"显示交互点"开关——是玩法引导不是诊断工具）与逐门动效状态（value/lastMoveT/alpha/color） */
  let ringG = null
  const ringState = new Map()
  let ringClock = 0
  /** 引导环逐门读数（HUD 诊断）：update 每帧重写，记录 α/锚点/未画原因 */
  let ringReads = []
  // 外盘半径（扫描起点）与中心芯半径（扫描终点），px；区间段序调色板（现值落在哪段就取哪段色）
  const RING_R0 = 84
  const RING_CORE = 16
  const RING_COLORS = [0x4fc08d, 0xe8b06f, 0x6fa8dc, 0xd98fb5]

  /** 点 (x,y)（舞台坐标）按手势同款规则路由到的机器分区：命中分区里 ship_l2d 名单序最大者胜（游戏 GetDragPart 反汇编语义：遍历 raycast 命中逐个 FindIndex 取 running max，同 gestures.js 的 machineZonesAt，纯几何无透明度过滤），并列取先遇者：'' = 该点没有可交互机器分区 */
  function routeWinner(runtime, orch, x, y) {
    const hits = meshHitTest(runtime.model, x, y)
    const areas = runtime.model.internalModel.hitAreas ?? {}
    let found = ''
    let bestOrder = -1
    for (const name of hits) {
      const order = orch.zoneOrder(name)
      if (order < 0) continue
      if (areas[name]?.index === undefined) continue
      if (order > bestOrder) {
        bestOrder = order
        found = name
      }
    }
    return found
  }

  /** 点 (x,y) 是否在三角形内（含边界，同号判定）：本分区网格点测用 */
  function pointInTri(px, py, ax, ay, bx, by, cx, cy) {
    const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
    const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
    const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
  }

  /** 点 p 在三角形 (a,b,c) 里的重心坐标 [α,β,γ]（α 对应 a），退化三角形返回 null */
  function baryOf(px, py, ax, ay, bx, by, cx, cy) {
    const e1x = bx - ax
    const e1y = by - ay
    const e2x = cx - ax
    const e2y = cy - ay
    const det = e1x * e2y - e2x * e1y
    if (Math.abs(det) < 1e-9) return null
    const ex = px - ax
    const ey = py - ay
    const beta = (ex * e2y - e2x * ey) / det
    const gamma = (e1x * ey - ex * e1y) / det
    return [1 - beta - gamma, beta, gamma]
  }

  /** 落点挂载：找包含它的三角形记重心坐标（边界点取首个命中），挂不上（凹形网格质心落在网格外等）返回 null，调用方退化为每帧钉质心 */
  function attachTri(lp, verts, indices) {
    for (let t = 0; t < indices.length; t += 3) {
      const ax = verts[indices[t] * 2]
      const ay = verts[indices[t] * 2 + 1]
      const bx = verts[indices[t + 1] * 2]
      const by = verts[indices[t + 1] * 2 + 1]
      const cx = verts[indices[t + 2] * 2]
      const cy = verts[indices[t + 2] * 2 + 1]
      if (pointInTri(lp.x, lp.y, ax, ay, bx, by, cx, cy)) {
        const bary = baryOf(lp.x, lp.y, ax, ay, bx, by, cx, cy)
        return bary ? { t: t / 3, bary } : null
      }
    }
    return null
  }

  /** 露出点重定位：提示点钉到"按下去真能触发本分区"的画布内位置。
   * 巨大网格（如 4374×4000 的背景板）顶点稀疏，全顶点质心会落在画布边缘的露出死角，不代表实际交互区，锚点按"画布内可见网格区"取：
   * ① 画布 12×12 采样点做本分区三角形的点测（只遍历本分区三角形），命中的 = 可见网格区，其质心即锚点；
   * ② 采样网格会漏低细露出区（细条带），边界环边中点兜底（必在网格上）。
   * 完全可见（全部顶点在画布内）且质心可路由的分区免采样，直接钉全顶点质心（位置精确）。
   * 候选按离锚点距离升序逐个做路由验证（机器分区：名单序路由回本分区；无机器分区：落在网格上即可点），第一个通过即返回——最近的可触发点，可路由区全被盖死才扫完。
   * 候选只收画布内的点：画布外的露出点物理上点不到，搬过去等于没搬。
   * 逐顶点变换与路由采样只在路由缓存重算时跑。返回落脚点的挂载信息：{ t, bary } = 三角形 t 的重心坐标（调用方每帧按当前顶点插值，点随呼吸/动作形变走）；{ centroid: true } = 每帧钉全顶点质心；null = 画布内采不到（整网格出画/可路由区全被盖死） */
  function resolveRoute(runtime, orch, name, loops, verts, indices, g, W, H, byRoute) {
    const inView = (p) => p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H
    const model = runtime.model
    // 全顶点转全局（缓存重算时一次，巨大网格可接受），顺带统计画布内顶点数
    const nv = verts.length / 2
    const gv = new Array(nv)
    let nIn = 0
    for (let j = 0; j < nv; j++) {
      const p = model.toGlobal({ x: verts[j * 2], y: verts[j * 2 + 1] })
      gv[j] = p
      if (inView(p)) nIn++
    }
    if (!nIn) return null
    // 完全可见：质心可路由就钉质心（免采样，每帧重算跟随形变）；质心被盖（名单序被压过）走下面的采样
    if (nIn === nv && (!byRoute || routeWinner(runtime, orch, g.x, g.y) === name)) {
      return { centroid: true }
    }
    // 候选：画布采样点里落在本分区网格上的（可见网格区，记命中三角形下标）
    const pts = []
    const N = 12
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N; j++) {
        const x = (W * i) / N
        const y = (H * j) / N
        for (let t = 0; t < indices.length; t += 3) {
          const a = gv[indices[t]]
          const b = gv[indices[t + 1]]
          const c = gv[indices[t + 2]]
          if (pointInTri(x, y, a.x, a.y, b.x, b.y, c.x, c.y)) {
            pts.push({ x, y, t: t / 3 })
            break
          }
        }
      }
    }
    // 采样网格漏掉的低细露出区：边界环边中点兜底（必在网格上），记模型空间坐标供挂载
    if (loops) {
      for (const loop of loops) {
        const step = Math.max(1, Math.floor(loop.length / 24))
        for (let i = 0; i < loop.length; i += step) {
          const va = loop[i]
          const vb = loop[(i + 1) % loop.length]
          const p = {
            x: (gv[va].x + gv[vb].x) / 2,
            y: (gv[va].y + gv[vb].y) / 2,
            lp: {
              x: (verts[va * 2] + verts[vb * 2]) / 2,
              y: (verts[va * 2 + 1] + verts[vb * 2 + 1]) / 2,
            },
          }
          if (inView(p)) pts.push(p)
        }
      }
    }
    if (!pts.length) return null
    // 锚点 = 可见网格区质心；候选按离锚点升序逐个路由验证，第一个通过即返回
    let sx = 0
    let sy = 0
    for (const p of pts) {
      sx += p.x
      sy += p.y
    }
    const ax = sx / pts.length
    const ay = sy / pts.length
    pts.sort((a, b) => (a.x - ax) ** 2 + (a.y - ay) ** 2 - ((b.x - ax) ** 2 + (b.y - ay) ** 2))
    for (const p of pts) {
      if (byRoute && routeWinner(runtime, orch, p.x, p.y) !== name) continue
      // 挂到三角形上（模型空间定住重心坐标，形变由插值吸收）；挂不上（凹形网格落点在网格外等）退化为每帧钉质心
      const lp = p.lp ?? model.toLocal(p)
      return attachTri(lp, verts, indices) ?? { centroid: true }
    }
    return null
  }

  /** 分区名（hitArea Name，如 touch_drag23）-> 驱动参数名（如 touch_drag25）。
   * 归一化规则与 DragOrchestrator.machineByZone 一致（剔大小写与分隔符）；无机器覆盖时返回 null，调用方回落到网格名 */
  function zoneParams(orch, zoneName) {
    if (!orch?.machines?.length) return null
    const key = String(zoneName).toLowerCase().replace(/[^a-z0-9]/g, '')
    const found = []
    for (const m of orch.machines) {
      if (String(m.drawAbleName).toLowerCase().replace(/[^a-z0-9]/g, '') !== key) continue
      // mode 2 联动机本机 parameter 为空串（动的是 relation 参数），不进标签，否则拼出 "touch_drag1++empty2" 这样的空档
      if (!m.parameterName) continue
      if (!found.includes(m.parameterName)) found.push(m.parameterName)
    }
    return found.length ? found.join('+') : null
  }

  /** 紧凑标签：完整名太长（touch_idle1 区三台机器拼 40+ 字符）。
   * 规则：剥 touch_/Param 前缀；参数与分区同族（同前缀纯数字编号，如 touch_drag14 区的 touch_drag21）只写数字差，跨族参数保留剥前缀全名。
   * 例：touch_drag1 -> "drag1"、TouchDrag14 -> "drag14:21"、TouchIdle1 -> "idle1:drag12+drag15+drag18"（跨族参数保留族名）、TouchDrag16(ParamLegLStretch+ParamCrusLStretch) -> "drag16:LegLStretch+CrusLStretch"。
   * 短名在模型内唯一（原名唯一且变换无损可逆），按短名即可对回 l2d.json 条目 */
  function hintText(zone, params) {
    const short = (s) => String(s).replace(/^touch_/, '').replace(/^Param/, '')
    if (!params || params === zone) return short(zone)
    const family = /^(touch_[a-z]+?)(\d+)$/.exec(zone)
    const items = params.split('+').map((p) => {
      if (family) {
        const m = new RegExp(`^${family[1]}(\\d+)$`).exec(p)
        if (m) return m[1]
      }
      return short(p)
    })
    return `${short(zone)}:${items.join('+')}`
  }

  /** 判定引导环（游戏 UI 引导层的同角色复刻，常显不随"显示交互点"开关——是玩法引导不是诊断工具）：两层背景圆盘 + 中心芯，叠在判定分区网格质心。
   * 外盘静止在扫描起点半径；内盘随门参数现值从外盘半径向芯收缩，玩家按内盘沿的收紧节奏点判定分区；段界另画细环；内盘边色 = 现值所在区间段（段序调色板）；扫描停 ~0.25s 淡出。
   * 半径对值线性（lo→外盘、hi→芯）；门数据取编排器 gateInfo 的归并门；锚 = 分区 drawable 顶点质心（单网格逐帧变换，中心出画跳过）。 */
  function drawJudgeRings(runtime) {
    ringReads = []
    const gates = getOrch?.()?.gateInfo?.() ?? []
    if (!gates.length) {
      ringReads.push({ zone: '-', why: '无type11门' })
      ringG.visible = false
      return
    }
    const now = performance.now() / 1000
    const dt = Math.min(0.1, Math.max(0, now - ringClock)) || 0.016
    ringClock = now
    const W = app.screen.width
    const H = app.screen.height
    ringG.visible = true
    ringG.clear()
    for (const g of gates) {
      const key = `${g.zone}|${g.param}`
      const st = ringState.get(key) ?? { lastValue: null, lastMoveT: 0, alpha: 0, color: RING_COLORS[0] }
      ringState.set(key, st)
      if (g.value == null) {
        ringReads.push({ zone: g.zone, why: '无值' })
        continue
      }
      if (st.lastValue != null && Math.abs(g.value - st.lastValue) > 1e-4) st.lastMoveT = now
      st.lastValue = g.value
      const active = now - st.lastMoveT < 0.25
      st.alpha += ((active ? 1 : 0) - st.alpha) * Math.min(1, dt * 8)
      if (st.alpha < 0.02) {
        ringReads.push({ zone: g.zone, v: g.value, a: st.alpha, why: '停扫' })
        continue
      }
      const h = hints.find((e) => e.name === g.zone)
      if (!h) {
        ringReads.push({ zone: g.zone, why: '无分区' })
        continue
      }
      const verts = runtime.model.internalModel.getDrawableVertices(h.idx)
      let cx = 0
      let cy = 0
      for (let j = 0; j < verts.length; j += 2) {
        cx += verts[j]
        cy += verts[j + 1]
      }
      const p = runtime.model.toGlobal({ x: cx / (verts.length / 2), y: cy / (verts.length / 2) })
      if (p.x < 0 || p.y < 0 || p.x > W || p.y > H) {
        ringReads.push({ zone: g.zone, v: g.value, a: st.alpha, x: p.x, y: p.y, why: '锚点出画' })
        continue
      }
      ringReads.push({ zone: g.zone, v: g.value, a: st.alpha, x: p.x, y: p.y, why: null })
      const span = g.hi - g.lo
      const k = span > 0 ? Math.max(0, Math.min(1, (g.value - g.lo) / span)) : 0
      const hit = g.bands.findIndex((b) => g.value >= b.lo && g.value < b.hi)
      if (hit >= 0) st.color = RING_COLORS[hit % RING_COLORS.length]
      const r = RING_R0 + (RING_CORE - RING_R0) * k
      // 外盘（静止背景层）：扫描起点半径
      ringG.beginFill(0xffffff, 0.1 * st.alpha)
      ringG.drawCircle(p.x, p.y, RING_R0)
      ringG.endFill()
      ringG.lineStyle(1, 0xffffff, 0.25 * st.alpha)
      ringG.drawCircle(p.x, p.y, RING_R0)
      // 段界细环：内盘沿收进哪段一目了然
      ringG.lineStyle(1, 0xffffff, 0.3 * st.alpha)
      for (const b of g.bands) {
        if (b.lo <= g.lo) continue
        ringG.drawCircle(p.x, p.y, RING_R0 + (RING_CORE - RING_R0) * ((b.lo - g.lo) / span))
      }
      // 内盘（收缩层）：现值所在半径，边色取段色
      ringG.beginFill(0xffffff, 0.16 * st.alpha)
      ringG.drawCircle(p.x, p.y, r)
      ringG.endFill()
      ringG.lineStyle(2, st.color, 0.9 * st.alpha)
      ringG.drawCircle(p.x, p.y, r)
      // 中心芯（静止）：扫描终点
      ringG.beginFill(0x86e3de, 0.85 * st.alpha)
      ringG.drawCircle(p.x, p.y, RING_CORE)
      ringG.endFill()
    }
  }

  return {
    rebuild(model) {
      this.destroy()
      layer = new Container()
      const areas = model.internalModel.hitAreas ?? {}
      hints = Object.entries(areas).map(([name, area]) => {
        const dot = new Graphics()
        const label = new Text(name, {
          fontSize: 10,
          fill: 0xffffff,
          letterSpacing: 0.5,
        })
        label.alpha = 0.85
        layer.addChild(dot, label)
        return { name, idx: area.index, dot, label }
      })
      ringG = new Graphics()
      app.stage.addChild(layer)
      app.stage.addChild(ringG)
    },

    destroy() {
      if (layer) {
        app.stage.removeChild(layer)
        layer.destroy({ children: true })
        layer = null
      }
      if (ringG) {
        app.stage.removeChild(ringG)
        ringG.destroy()
        ringG = null
      }
      hints = []
      loopCache = new Map()
      scratchPolys = new Map()
      routeMap.clear()
      routeKey = null
      ringState.clear()
    },

    update() {
      if (!layer) return null
      const runtime = getRuntime()
      if (!runtime) {
        if (ringG) ringG.visible = false
        layer.visible = false
        return null
      }
      drawJudgeRings(runtime)
      if (!getVisible()) {
        layer.visible = false
        return null
      }
      layer.visible = true
      const core = runtime.model.internalModel.coreModel
      const hasOpacity = typeof core.getDrawableOpacity === 'function'
      // 提示层直挂 stage，坐标 = 舞台全局 = 画布 CSS px；可视区即画布矩形
      const W = app.screen.width
      const H = app.screen.height
      for (const h of hints) {
        // 标签 = 分区驱动的参数（见函数注释），逐帧解析：编排器随模型热切换
        // 网格名与反应编号错位的皮肤（shengluyisi_5 的 TouchDrag14 驱动 touch_drag21 等）标签里参数前带上分区名，才对得回分区
        const orch = getOrch?.()
        const hasMachine = !!orch?.machinesForZone(h.name).length
        // 不可交互一律不画：机器分区不按透明度跳过（游戏路由是纯几何射线，隐藏但在位的标记照样可触发，见 gestures.js machineZonesAt 注释），被挡下/未实现触发类型的分区跳过；无机器分区才按隐藏网格跳过（C# 路径的命中层恒可见，此分支兜底摆位零件等）
        if (!hasMachine && (!hasOpacity || core.getDrawableOpacity(h.idx) <= 0.001)) {
          h.dot.visible = h.label.visible = false
          continue
        }
        // 判定与颜色分家时的两套判据（见函数注释）：机器分区看参数机的可触发条件（type 9 点参机 parameter 为空、读的是他参，不能挂在 params 上判），无机器分区看 interaction.json 的起播门控
        const state = hasMachine ? orch.zoneInteractable(h.name) : null
        const interactable = hasMachine ? state === true : runtime.canPlay(h.name)
        if (!interactable) {
          h.dot.visible = h.label.visible = false
          continue
        }
        h.label.alpha = 0.85
        const params = zoneParams(orch, h.name)
        const verts = runtime.model.internalModel.getDrawableVertices(h.idx)
        let cx = 0
        let cy = 0
        for (let j = 0; j < verts.length; j += 2) {
          cx += verts[j]
          cy += verts[j + 1]
        }
        const n = verts.length / 2
        const g = runtime.model.toGlobal({ x: cx / n, y: cy / n })
        // 真实网格形状（边界环，模型空间顶点转全局坐标）：与 meshHitTest 同一几何 = 游戏 CubismRaycaster 的精确判定范围；包围盒会多出凹形/镂空处的大片空白，画框才能对照出"游戏点不到但包围盒覆盖"的区域
        let loops = loopCache.get(h.idx)
        if (loops === undefined) {
          loops = boundaryLoops(core.getDrawableVertexIndices(h.idx) ?? [])
          loopCache.set(h.idx, loops)
        }
        // 网格三角形下标：重定位的可见区点测与非流形网格的逐边描边共用
        const indices = core.getDrawableVertexIndices(h.idx) ?? []
        // 遮挡/出画处理：提示点只钉在画布内的可触发位置（resolveRoute，锚点 = 画布内可见部分质心）。
        // 机器分区一律重定位——巨大网格的全顶点质心可能落在画布边缘的露出死角，不代表实际交互区；质心被其它分区盖住（名单序被压过）时同样靠它搬点
        // 无机器分区（摸头/普通触摸等 C# 路径，网格都在角色身上）只在质心出画时重定位，质心在画布内就钉质心
        // 出屏分区游戏里物理上点不到（C# GetDragPart 的射线恒过 Input.mousePosition，屏幕内坐标），画布内采不到落脚点（整网格出画/可路由区全被盖死/非流形网格连不成环）则藏点与标签，绿框照画（画布内的露出部分仍可见）
        // 路由结果按 idle 变体/在播动作缓存，变了才重算：缓存的是挂载信息（三角形重心坐标或质心锚），全局位置每帧随当前顶点重算，呼吸/动作形变时点跟着网格走；不追加"←胜者"文字标记：路由定案后点已搬走
        let spot = g
        let dotLost = false
        const isMachine = !!orch?.machineByZone(h.name)
        const offView = g.x < 0 || g.y < 0 || g.x > W || g.y > H
        if (isMachine || offView) {
          // 画布尺寸进键：resize 后搬点位置随可视区变化，旧值作废
          const key = `${orch?.idleIndex ?? ''}|${orch?.playActionName ?? ''}|${W}x${H}`
          if (routeKey !== key) {
            routeKey = key
            routeMap.clear()
          }
          if (!routeMap.has(h.name)) {
            routeMap.set(h.name, resolveRoute(runtime, orch, h.name, loops, verts, indices, g, W, H, isMachine))
          }
          const r = routeMap.get(h.name)
          if (!r) {
            dotLost = true
          } else if (r.bary) {
            // 钉在网格面上（三角形重心坐标）：每帧按当前顶点插值，随呼吸/动作形变走，与绿框同一几何
            const i3 = r.t * 3
            const a = runtime.model.toGlobal({ x: verts[indices[i3] * 2], y: verts[indices[i3] * 2 + 1] })
            const b = runtime.model.toGlobal({ x: verts[indices[i3 + 1] * 2], y: verts[indices[i3 + 1] * 2 + 1] })
            const c = runtime.model.toGlobal({ x: verts[indices[i3 + 2] * 2], y: verts[indices[i3 + 2] * 2 + 1] })
            spot = {
              x: r.bary[0] * a.x + r.bary[1] * b.x + r.bary[2] * c.x,
              y: r.bary[0] * a.y + r.bary[1] * b.y + r.bary[2] * c.y,
            }
          } else {
            // 质心锚（完全可见且可路由/落点挂不上三角形）：每帧用当前顶点重算，同样跟随
            spot = g
          }
        }
        // 标签 = 分区驱动的参数（见 hintText 注释）：同名不重复、错位分区拼数字差（drag14:21），比全名短一个量级
        const text = hintText(h.name, params)
        if (h.label.text !== text) h.label.text = text
        // 绿框恒画（含 dotLost）：出画/被盖只藏点与标签，网格露在画布内的部分仍是真实判定范围（= 游戏 CubismRaycaster 的判定几何），框必须可见；整网格出画时框画在画布外自然不可见
        h.dot.visible = true
        h.dot.position.set(0, 0)
        h.dot.clear()
        // 走到这里的都是当前可交互的分区，恒绿
        const color = 0x4fc08d
        if (loops) {
          // 顶点下标序列 -> 全局坐标扁平数组（缓存复用，每帧只重写值）
          const polys = loops.map((loop, li) => {
            let pts = scratchPolys.get(li)
            if (!pts || pts.length !== loop.length * 2) {
              pts = new Array(loop.length * 2)
              scratchPolys.set(li, pts)
            }
            for (let j = 0; j < loop.length; j++) {
              const p = runtime.model.toGlobal({
                x: verts[loop[j] * 2],
                y: verts[loop[j] * 2 + 1],
              })
              pts[j * 2] = p.x
              pts[j * 2 + 1] = p.y
            }
            return pts
          })
          h.dot.lineStyle(1, color, 0.8)
          for (const pts of polys) {
            h.dot.moveTo(pts[0], pts[1])
            for (let j = 1; j < pts.length / 2; j++) {
              h.dot.lineTo(pts[j * 2], pts[j * 2 + 1])
            }
            h.dot.lineTo(pts[0], pts[1])
          }
        } else {
          // 非流形网格连不成干净边界环：退化为逐条描边界边（boundaryEdges，只被一个三角形使用的边）——形状与环描边一致，只是没串成回路
          // 不做形状填充，统一只画绿框
          h.dot.lineStyle(1, color, 0.8)
          for (const [a, b] of boundaryEdges(indices)) {
            const pa = runtime.model.toGlobal({ x: verts[a * 2], y: verts[a * 2 + 1] })
            const pb = runtime.model.toGlobal({ x: verts[b * 2], y: verts[b * 2 + 1] })
            h.dot.moveTo(pa.x, pa.y)
            h.dot.lineTo(pb.x, pb.y)
          }
        }
        // 质心圆钉在 spot（画布内的可点位置，出画/被盖时已搬走）；真实质心不留痕（空心环会被当成第二个交互点的"幽灵点"），网格本尊的位置看绿框即可
        // dotLost（出画/被盖且画布内采不到落脚点）只藏点与标签：物理上点不到的位置不画误导性的点，绿框上面已照画
        if (dotLost) {
          h.label.visible = false
          continue
        }
        h.label.visible = true
        h.dot.beginFill(color, 0.35)
        h.dot.drawCircle(spot.x, spot.y, 9)
        h.dot.endFill()
        h.label.position.set(spot.x + 12, spot.y - 7)
      }
      const state = [...runtime.statePids].map((pid) => [
        pid,
        Number(runtime.paramValue(pid).toFixed(2)),
      ])
      // 连续摆位只报节点里的非默认残留（实时值被逐帧曲线扰动，不适合读数）
      const carried = [...runtime.carryPids]
        .filter(
          (pid) =>
            Math.abs((runtime.node.get(pid) ?? 0) - runtime.paramDefault(pid)) >
            runtime.eps,
        )
        .map((pid) => [pid, runtime.node.get(pid)])
      return { state, carried, rings: ringReads }
    },
  }
}
