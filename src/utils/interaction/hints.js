/**
 * 交互点可视化提示（测试用）：每个命中区一个半透明圆点标在其 drawable
 * 网格顶点质心，外加网格实际形状的绿框轮廓（= 游戏 CubismRaycaster
 * 的精确判定范围，与 meshHitTest 同一几何）——只画当前可交互的分区（绿）；
 * 被挡下（冷却/单触发已播/播放中）、未实现触发类型、隐藏网格（如菜单收起
 * 时的菜单项）一律不画，收束后满屏红点的噪音视图不再出现；位置每帧跟随
 * 模型，状态变化（冷却结束/变体切换）时点随之隐现。
 *
 * 可交互判定按真实路由分家：机器分区（ship_l2d 有 draw_able_name 匹配）由
 * 拖拽参数机接管，不查 interaction.json 的参数门控——可见性按机器自身的
 * 可触发条件（冷却/单触发/播放中/重复 idle 豁免/type 9 点参档位，取编排器
 * 路由到的那台，与游戏 GetDragPart 的"注册顺序第一台赢"一致）判定；无机器的分区
 * （touch_head/body 等 C# 路径）才按起播门控（canPlay）判定。两种判据
 * 混用会把"机器照样能拖"的分区误判成不可交互、"冷却中"的分区误判成可交互。
 *
 * 标签显示分区驱动的参数（编排器 l2d.json 的 draw_able_name -> parameter），
 * 不用网格自己的名字：部分皮肤的网格名与反应编号是错位的（shengluyisi_5:
 * TouchDrag23 网格驱动 touch_drag25、TouchDrag25 驱动 touch_drag29——
 * 游戏 sharecfg ship_l2d 原始数据即如此），按网格名标注会把 drag25 的
 * 范围/中心画到 TouchDrag25 网格上，与游戏内实际触发位置对不上。多个
 * 机器共用同一分区时参数用 "+" 连接；无机器的分区（摸头/普通触摸等）
 * 沿用网格名。标签整体走紧凑记法（hintText）：剥 touch_/Param 前缀、
 * 同族参数只写数字差——全名拼串动辄 40 字符，报告读数时没法转述。
 */
import { Container, Graphics, Text } from 'pixi.js'
import { boundaryEdges, boundaryLoops, meshHitTest } from './hitTest.js'

/**
 * @param app pixi Application（提示层挂到其 stage）
 * @param getRuntime () => InteractionRuntime | null，每帧取当前运行时
 * @param getVisible () => boolean，提示层开关
 * @param getOrch () => DragOrchestrator | null，拖拽参数机编排器
 * @returns {{ rebuild(model): void, destroy(): void, update(): {state: [string, number][], carried: [string, number][]} | null }}
 *   update 每帧调用，返回 HUD 读数（状态参数 + 非默认残留，供测试对照）；
 *   提示层未建/隐藏/无运行时时返回 null
 */
export function createInteractionHints(app, getRuntime, getVisible, getOrch = null) {
  let layer = null
  let hints = []
  /** drawable 下标 -> 边界环拓扑（顶点下标序列），随模型切换在 rebuild 清空 */
  let loopCache = new Map()
  /** 环序号 -> 全局坐标扁平数组（每帧复用，只重写值） */
  let scratchPolys = new Map()
  /** 分区质心路由缓存：key = idle 变体|在播动作，变了才整体重算——meshHitTest
      全 drawable 遍历太重，不能每帧×每分区跑；姿态在变体间漂移小，够诊断用 */
  let routeKey = null
  const routeMap = new Map()

  /** 点 (x,y)（舞台坐标）按手势同款规则路由到的机器分区（= drawable 索引
      最大的命中，游戏 GetDragPart 反汇编语义：raycast 结果逐个查 dragParts
      命中即覆写 → 末位命中赢）：'' = 该点没有可交互机器分区 */
  function routeWinner(runtime, orch, x, y) {
    const hits = meshHitTest(runtime.model, x, y)
    const core = runtime.model.internalModel.coreModel
    const areas = runtime.model.internalModel.hitAreas ?? {}
    const hasOpacity = typeof core.getDrawableOpacity === 'function'
    let found = ''
    for (const name of hits) {
      if (!orch.machineByZone(name)) continue
      const area = areas[name]
      if (area?.index === undefined) continue
      if (!hasOpacity || core.getDrawableOpacity(area.index) > 0.001) found = name
    }
    return found
  }

  /** 质心路由 + 露出点重定位：质心被其它分区盖住（winner ≠ 本分区）或质心
      本身在画布外（背景板级网格只露一角，wuzang_3 的 touch_drag4 质心随
      网格出画）时，采样本分区网格上仍路由回本分区的点搬过去。候选两路：
      ① 边界环边中点（每环上限 24 点——必落在网格内，小网格的露出边靠它）；
      ② ①全军覆没时按画布 12×12 网格补采——巨大网格的边界环几乎整圈在画布
      外或整圈被盖，可视区内的露出区只有网格采样兜得住（背景板 4374×4000，
      边界中点全在画布外，按"离质心最远"挑中的是画布外的深露点，提示点整只
      消失）。两路候选都只收画布内的点：画布外的露出点物理上点不到，搬过去
      等于没搬。取最远而非首个，是为了让被盖分区的点尽量离开盖住它的热区
      （盖住者就环在质心附近，最远暴露边缘天然远离它们）。采样只在路由缓存
      重算时跑。返回 { winner, pt }（pt = 露出点全局坐标，null = 画布内整网
      格被盖死无露出区） */
  function resolveRoute(runtime, orch, name, loops, verts, g, W, H) {
    const inView = (p) => p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H
    const winner = routeWinner(runtime, orch, g.x, g.y)
    if (winner === name && inView(g)) return { winner, pt: null }
    const model = runtime.model
    let best = null
    let bestDist = -1
    const consider = (p) => {
      if (!inView(p) || routeWinner(runtime, orch, p.x, p.y) !== name) return
      const d = (p.x - g.x) ** 2 + (p.y - g.y) ** 2
      if (d > bestDist) {
        bestDist = d
        best = p
      }
    }
    if (loops) {
      for (const loop of loops) {
        const step = Math.max(1, Math.floor(loop.length / 24))
        for (let i = 0; i < loop.length; i += step) {
          const a = loop[i]
          const b = loop[(i + 1) % loop.length]
          consider(
            model.toGlobal({
              x: (verts[a * 2] + verts[b * 2]) / 2,
              y: (verts[a * 2 + 1] + verts[b * 2 + 1]) / 2,
            }),
          )
        }
      }
      if (!best) {
        const N = 12
        for (let i = 0; i <= N; i++) {
          for (let j = 0; j <= N; j++) {
            consider({ x: (W * i) / N, y: (H * j) / N })
          }
        }
      }
    }
    return { winner, pt: best }
  }

  /** 分区名（hitArea Name，如 touch_drag23）-> 驱动参数名（如 touch_drag25）。
      归一化规则与 DragOrchestrator.machineByZone 一致（剔大小写与分隔符）；
      无机器覆盖时返回 null，调用方回落到网格名 */
  function zoneParams(orch, zoneName) {
    if (!orch?.machines?.length) return null
    const key = String(zoneName).toLowerCase().replace(/[^a-z0-9]/g, '')
    const found = []
    for (const m of orch.machines) {
      if (String(m.drawAbleName).toLowerCase().replace(/[^a-z0-9]/g, '') !== key) continue
      // mode 2 联动机本机 parameter 为空串（动的是 relation 参数），不进标签，
      // 否则拼出 "touch_drag1++empty2" 这样的空档
      if (!m.parameterName) continue
      if (!found.includes(m.parameterName)) found.push(m.parameterName)
    }
    return found.length ? found.join('+') : null
  }

  /** 紧凑标签：完整名太长（touch_idle1 区三台机器拼 40+ 字符），报告时难
      转述。规则：剥 touch_/Param 前缀；参数与分区同族（同前缀纯数字编号，
      如 touch_drag14 区的 touch_drag21）只写数字差，跨族参数保留剥前缀全名：
      touch_drag1 -> "drag1"、TouchDrag14 -> "drag14:21"、TouchIdle1 ->
      "idle1:drag12+drag15+drag18"（跨族参数保留族名）、
      TouchDrag16(ParamLegLStretch+ParamCrusLStretch) ->
      "drag16:LegLStretch+CrusLStretch"。短名在模型内唯一（原名唯一且变换
      无损可逆），报读数时按短名即可对回 l2d.json 条目 */
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
      app.stage.addChild(layer)
    },

    destroy() {
      if (layer) {
        app.stage.removeChild(layer)
        layer.destroy({ children: true })
        layer = null
      }
      hints = []
      loopCache = new Map()
      scratchPolys = new Map()
      routeMap.clear()
      routeKey = null
    },

    update() {
      if (!layer) return null
      const runtime = getRuntime()
      if (!getVisible() || !runtime) {
        layer.visible = false
        return null
      }
      layer.visible = true
      const core = runtime.model.internalModel.coreModel
      const hasOpacity = typeof core.getDrawableOpacity === 'function'
      // 提示层直挂 stage，坐标 = 舞台全局 = 画布 CSS px；可视区即画布矩形
      const W = app.screen.width
      const H = app.screen.height
      // 越界点钳回画布内（12px 边距）：停机位/画外网格的质心常在画布外，
      // 点原样钉上去等于没画
      const clampToView = (p) => ({
        x: Math.min(Math.max(p.x, 12), W - 12),
        y: Math.min(Math.max(p.y, 12), H - 12),
      })
      for (const h of hints) {
        // 标签 = 分区驱动的参数（见函数注释）。逐帧解析：编排器随模型热切换。
        // 分区名与参数名错位的皮肤（shengluyisi_5 的 TouchDrag14 驱动
        // touch_drag21 等）只看标签会找不到分区——参数前带上分区名，
        // 名单排查与"点哪个分区"对得上号
        const orch = getOrch?.()
        const hasMachine = !!orch?.machinesForZone(h.name).length
        // 不可交互一律不画：隐藏网格（透明度归零）与被挡下/未实现触发类型
        // 的分区直接跳过（连路由采样都省掉），画面上只剩当前真能点的分区
        if (!hasOpacity || core.getDrawableOpacity(h.idx) <= 0.001) {
          h.dot.visible = h.label.visible = false
          continue
        }
        // 判定与颜色分家时的两套判据（见函数注释）：机器分区看参数机的
        // 可触发条件（type 9 点参机 parameter 为空、读的是他参，不能挂在
        // params 上判，wuzang_3 的 TouchDrag3/TouchIdle2 六档机曾因此漏判），
        // 无机器分区看 interaction.json 的起播门控
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
        // 真实网格形状（边界环，模型空间顶点转全局坐标）：与 meshHitTest 同一
        // 几何 = 游戏 CubismRaycaster 的精确判定范围；包围盒会多出凹形/镂空处
        // 的大片空白，画框才能对照出"游戏点不到但包围盒覆盖"的区域
        let loops = loopCache.get(h.idx)
        if (loops === undefined) {
          loops = boundaryLoops(core.getDrawableVertexIndices(h.idx) ?? [])
          loopCache.set(h.idx, loops)
        }
        // 遮挡/出画处理：质心处按手势同款规则路由到的不是本分区（如 TouchDrag1
        // 大网格盖住 drag13:19 的热区、末位命中赢下质心），或质心本身在画布外
        // （背景板级网格只露一角）时，把提示点/标签搬到本分区网格上画布内可
        // 点到的位置（resolveRoute）——钉在被盖住的质心上这个分区永远点不到；
        // 画布内整网格被盖死无露出区则整只隐藏（点了也是别人的，按只留可交互
        // 视图处理）。路由结果按 idle 变体/在播动作缓存，变了才重算。不再追加
        // ←胜者 文字标记：路由定案后它只剩噪音，点搬走+质心空心环已足以交代
        let spot = g
        let dotLost = false
        if (orch?.machineByZone(h.name)) {
          // 画布尺寸进键：resize 后搬点位置随可视区变化，旧值作废
          const key = `${orch.idleIndex}|${orch.playActionName ?? ''}|${W}x${H}`
          if (routeKey !== key) {
            routeKey = key
            routeMap.clear()
          }
          if (!routeMap.has(h.name)) {
            routeMap.set(h.name, resolveRoute(runtime, orch, h.name, loops, verts, g, W, H))
          }
          const r = routeMap.get(h.name)
          // pt 在场就用（winner 命中但质心出画同样要搬回画布内）；无 pt 且
          // 被别的分区盖死 → 该点画布内点不到，整只隐藏（只留可交互视图）
          if (r.pt) spot = r.pt
          else if (r.winner !== h.name) dotLost = true
        }
        if (dotLost) {
          h.dot.visible = h.label.visible = false
          continue
        }
        // 标签 = 分区驱动的参数（见 hintText 注释）：同名不重复、错位分区
        // 拼数字差（drag14:21），比全名短一个量级
        const text = hintText(h.name, params)
        if (h.label.text !== text) h.label.text = text
        h.dot.visible = true
        h.label.visible = true
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
          // 非流形网格连不成干净边界环：退化为逐条描边界边（boundaryEdges，
          // 只被一个三角形使用的边）——形状与环描边一致，只是没串成回路；
          // 不做形状填充，统一只画绿框
          const indices = core.getDrawableVertexIndices(h.idx) ?? []
          h.dot.lineStyle(1, color, 0.8)
          for (const [a, b] of boundaryEdges(indices)) {
            const pa = runtime.model.toGlobal({ x: verts[a * 2], y: verts[a * 2 + 1] })
            const pb = runtime.model.toGlobal({ x: verts[b * 2], y: verts[b * 2 + 1] })
            h.dot.moveTo(pa.x, pa.y)
            h.dot.lineTo(pb.x, pb.y)
          }
        }
        // 质心圆钉在 spot（露出点或质心，出画时钳回画布边缘留可视锚点）；
        // 重定位时在真实质心画一个空心小环留底；整网格被盖死的（dotLost）
        // 上面已整只隐藏
        if (!dotLost) {
          const spotC = clampToView(spot)
          h.dot.beginFill(color, 0.35)
          h.dot.drawCircle(spotC.x, spotC.y, 9)
          h.dot.endFill()
          if (spot !== g) {
            h.dot.lineStyle(1, color, 0.5)
            h.dot.drawCircle(g.x, g.y, 4)
          }
          h.label.position.set(spotC.x + 12, spotC.y - 7)
        }
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
      return { state, carried }
    },
  }
}
