/**
 * 交互点可视化提示（测试用）：每个命中区一个半透明圆点标在其 drawable
 * 网格顶点质心，外加网格实际形状的轮廓与淡填充（= 游戏 CubismRaycaster
 * 的精确判定范围，与 meshHitTest 同一几何）——绿 = 可交互、
 * 红 = 被挡下、橙 = 游戏配置了触发但查看器未实现该触发类型、隐藏网格
 * （如菜单收起时的菜单项）不显示；位置每帧跟随模型。
 *
 * 红绿判定按真实路由分家：机器分区（ship_l2d 有 draw_able_name 匹配）由
 * 拖拽参数机接管，不查 interaction.json 的参数门控——颜色按机器自身的
 * 可触发条件（冷却/单触发/播放中/重复 idle 豁免，取编排器路由到的那台，
 * 与游戏 GetDragPart 的"注册顺序第一台赢"一致）判定；无机器的分区
 * （touch_head/body 等 C# 路径）才按起播门控（canPlay）判定。两种判据
 * 混用会把"机器照样能拖"的分区画红、"未实现触发类型/冷却中"的分区画绿。
 *
 * 标签显示分区驱动的参数（编排器 l2d.json 的 draw_able_name -> parameter），
 * 不用网格自己的名字：部分皮肤的网格名与反应编号是错位的（shengluyisi_5:
 * TouchDrag23 网格驱动 touch_drag25、TouchDrag25 驱动 touch_drag29——
 * 游戏 sharecfg ship_l2d 原始数据即如此），按网格名标注会把 drag25 的
 * 范围/中心画到 TouchDrag25 网格上，与游戏内实际触发位置对不上。多个
 * 机器共用同一分区时参数用 "+" 连接；无机器的分区（摸头/普通触摸等）
 * 沿用网格名。
 */
import { Container, Graphics, Text } from 'pixi.js'
import { boundaryLoops } from './hitTest.js'

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

  /** 分区名（hitArea Name，如 touch_drag23）-> 驱动参数名（如 touch_drag25）。
      归一化规则与 DragOrchestrator.machineByZone 一致（剔大小写与分隔符）；
      无机器覆盖时返回 null，调用方回落到网格名 */
  function zoneParams(orch, zoneName) {
    if (!orch?.machines?.length) return null
    const key = String(zoneName).toLowerCase().replace(/[^a-z0-9]/g, '')
    const found = []
    for (const m of orch.machines) {
      if (String(m.drawAbleName).toLowerCase().replace(/[^a-z0-9]/g, '') !== key) continue
      if (!found.includes(m.parameterName)) found.push(m.parameterName)
    }
    return found.length ? found.join('+') : null
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
      for (const h of hints) {
        if (!hasOpacity || core.getDrawableOpacity(h.idx) <= 0.001) {
          h.dot.visible = h.label.visible = false
          continue
        }
        // 标签 = 分区驱动的参数（见函数注释）。逐帧解析：编排器随模型热切换
        const orch = getOrch?.()
        const params = zoneParams(orch, h.name)
        if (params && h.label.text !== params) h.label.text = params
        const verts = runtime.model.internalModel.getDrawableVertices(h.idx)
        let cx = 0
        let cy = 0
        for (let j = 0; j < verts.length; j += 2) {
          cx += verts[j]
          cy += verts[j + 1]
        }
        const n = verts.length / 2
        const g = runtime.model.toGlobal({ x: cx / n, y: cy / n })
        h.dot.visible = h.label.visible = true
        h.dot.position.set(0, 0)
        h.dot.clear()
        // 颜色按真实路由判定（见函数注释）：机器分区看参数机的可触发条件
        // （同名多机时任意一台可响应即绿），其余分区看 interaction.json 的
        // 起播门控；橙 = 触发类型未实现
        const hasMachine = params && orch?.machinesForZone(h.name).length
        const state = params ? orch?.zoneInteractable(h.name) : null
        const color =
          state === true || (!hasMachine && runtime.canPlay(h.name))
            ? 0x4fc08d
            : state === null
              ? 0xe0a03c
              : 0xe05555
        // 真实网格形状（边界环，模型空间顶点转全局坐标）：与 meshHitTest 同一
        // 几何 = 游戏 CubismRaycaster 的精确判定范围；包围盒会多出凹形/镂空处
        // 的大片空白，画形状才能对照出"游戏点不到但包围盒覆盖"的区域
        let loops = loopCache.get(h.idx)
        if (loops === undefined) {
          loops = boundaryLoops(core.getDrawableVertexIndices(h.idx) ?? [])
          loopCache.set(h.idx, loops)
        }
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
          h.dot.beginFill(color, 0.07)
          for (const pts of polys) h.dot.drawPolygon(pts)
          h.dot.endFill()
          h.dot.lineStyle(1, color, 0.8)
          for (const pts of polys) {
            h.dot.moveTo(pts[0], pts[1])
            for (let j = 1; j < pts.length / 2; j++) {
              h.dot.lineTo(pts[j * 2], pts[j * 2 + 1])
            }
            h.dot.lineTo(pts[0], pts[1])
          }
        } else {
          // 非流形网格连不成干净边界环：退化为逐三角形画三条边
          const indices = core.getDrawableVertexIndices(h.idx) ?? []
          for (let t = 0; t < indices.length; t += 3) {
            for (let e = 0; e < 3; e++) {
              const a = indices[t + e] * 2
              const b = indices[t + ((e + 1) % 3)] * 2
              const pa = runtime.model.toGlobal({ x: verts[a], y: verts[a + 1] })
              const pb = runtime.model.toGlobal({ x: verts[b], y: verts[b + 1] })
              h.dot.moveTo(pa.x, pa.y)
              h.dot.lineTo(pb.x, pb.y)
            }
          }
        }
        h.dot.beginFill(color, 0.35)
        h.dot.drawCircle(g.x, g.y, 9)
        h.dot.endFill()
        h.label.position.set(g.x + 12, g.y - 7)
      }
      const state = [...runtime.statePids].map((pid) => [
        pid,
        Math.round(runtime.paramValue(pid)),
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
