/**
 * 触点涟漪：按下出现、lerp 跟随指针、抬起消散的全局触摸反馈，与交互判定
 * 无关。三层粒子（菱环扩张 / 辉光弹出 / 菱形飞散），开关在 HUD 工具栏，
 * localStorage 持久化。
 */
import { Container, Rectangle, Sprite, Texture, BLEND_MODES } from 'pixi.js'

// 大小、浓度、跟随手感、拖动沿途补发涟漪的间距
const UNIT_PX = 1.5
const FAINT = 0.55
const LERP_SPEED = 12
const LERP_DIS_LIMIT = 40
const DRAG_SPACING = 110

const TAU = Math.PI * 2

/** 线性插值折线键值 */
function evalKeys(keys, t) {
  if (t <= keys[0].t) return keys[0].v
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1]
      const b = keys[i]
      return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t)
    }
  }
  return keys[keys.length - 1].v
}

const rand = (a, b) => a + Math.random() * (b - a)

/** 图集两帧（256×128，各 128×128）：0=菱环 1=实心菱 */
function buildTextures() {
  const base = Texture.from(`${import.meta.env.BASE_URL}effects/click/click.png`).baseTexture
  return {
    ring: new Texture(base, new Rectangle(0, 0, 128, 128)),
    gem: new Texture(base, new Rectangle(128, 0, 128, 128)),
  }
}

/**
 * @param app pixi Application（涟漪层挂其 stage 顶层）
 * @param view canvas 元素（原生 pointer 事件源，与 gestures 同一路径）
 * @param getVisible () => boolean，开关
 * @returns {{update(dt): void, destroy(): void}} update 由 ticker 每帧调（dt 秒）
 */
export function createClickEffect(app, view, getVisible) {
  const layer = new Container()
  layer.visible = false
  app.stage.addChild(layer)
  const textures = buildTextures()
  const particles = []
  /** 按压会话：{x,y 当前位, tx,ty 指针位, t, fired, stopped, sx,sy 上次沿途 spawn 位} */
  let active = null

  // 按下后按时间表补发的粒子（ring=扩张菱环 glow=辉光 spark=飞散菱形）
  const BURSTS = [
    { t: 0, kind: 'ring' },
    { t: 0, kind: 'glow' },
    { t: 0, kind: 'glow' },
    { t: 0, kind: 'spark', n: 3 },
    { t: 0.05, kind: 'spark', n: 2 },
    { t: 0.1, kind: 'ring' },
  ]

  function spawn(kind, x, y, scale = 1, faint = 1) {
    const s = new Sprite(kind === 'ring' ? textures.ring : textures.gem)
    s.anchor.set(0.5)
    s.blendMode = BLEND_MODES.ADD
    s.position.set(x, y)
    layer.addChild(s)
    const p = { sprite: s, kind, age: 0, faint: faint * FAINT }
    if (kind === 'ring') {
      p.life = 0.35
      p.size = 2.25 * 40 * UNIT_PX * scale
      p.rot = Math.PI / 4
      p.spin = 0
      p.vx = p.vy = 0
    } else if (kind === 'glow') {
      p.life = 0.2
      p.size = 1.5 * 40 * UNIT_PX * scale
      p.rot = rand(0, TAU)
      p.spin = 0
      p.vx = p.vy = 0
    } else {
      p.life = rand(0.35, 0.5)
      p.size = rand(0.5, 1.5) * 40 * UNIT_PX * scale
      p.rot = rand(-Math.PI, Math.PI)
      p.spin = rand(-TAU, TAU)
      const ang = rand(0, TAU)
      const v = rand(3, 5) * 40 * UNIT_PX * scale
      p.vx = Math.cos(ang) * v
      p.vy = Math.sin(ang) * v
    }
    particles.push(p)
  }

  function updateParticle(p, dt) {
    p.age += dt
    const t = p.age / p.life
    if (t >= 1) {
      p.sprite.destroy()
      return false
    }
    // 飞散粒子带阻尼（射出后急刹车）
    if (p.vx || p.vy) {
      const damp = Math.exp(-4 * dt)
      p.vx *= damp
      p.vy *= damp
      p.sprite.x += p.vx * dt
      p.sprite.y += p.vy * dt
    }
    p.sprite.rotation = p.rot + p.spin * p.age
    let alpha = 1
    if (p.kind === 'ring') {
      // 扩张 0.2→1，色青→蓝，α 1→0
      p.sprite.scale.set((p.size * (0.2 + 0.8 * t)) / 128)
      const c = evalKeys(
        [
          { t: 0, v: 0 },
          { t: 0.25, v: 0 },
          { t: 0.75, v: 0.5 },
          { t: 1, v: 0.5 },
        ],
        t,
      )
      p.sprite.tint = (0 << 16) | (Math.round(255 - c * 508) << 8) | 0xff
      alpha = 1 - t
    } else if (p.kind === 'glow') {
      // 弹出 0→0.8→1，白×灰 0.5，α 0→1@0.25→0
      const k = evalKeys(
        [
          { t: 0, v: 0 },
          { t: 0.2, v: 0.8 },
          { t: 1, v: 1 },
        ],
        t,
      )
      p.sprite.scale.set((p.size * k) / 128)
      p.sprite.tint = 0x808080
      alpha = evalKeys(
        [
          { t: 0, v: 0 },
          { t: 0.25, v: 1 },
          { t: 1, v: 0 },
        ],
        t,
      )
    } else {
      // 缩小 1→0，α 0→1@0.25→0，两帧半程切换
      p.sprite.scale.set((p.size * (1 - t)) / 128)
      p.sprite.texture = t < 0.5 ? textures.ring : textures.gem
      alpha = evalKeys(
        [
          { t: 0, v: 0 },
          { t: 0.25, v: 1 },
          { t: 1, v: 0 },
        ],
        t,
      )
    }
    p.sprite.alpha = alpha * p.faint
    return true
  }

  function update(dt) {
    if (!getVisible()) {
      layer.visible = false
      return
    }
    layer.visible = true
    if (active) {
      active.t += dt
      // 补发时刻表内的粒子；抬起后不再补发
      for (const b of BURSTS) {
        if (b.t > active.fired && b.t <= active.t && !active.stopped) {
          const n = b.n ?? 1
          for (let i = 0; i < n; i++) spawn(b.kind, active.x, active.y)
        }
      }
      active.fired = active.t
      if (!active.stopped) {
        // lerp 贴向指针，贴近则吸附
        const dx = active.tx - active.x
        const dy = active.ty - active.y
        const d = Math.hypot(dx, dy)
        if (d < LERP_DIS_LIMIT) {
          active.x = active.tx
          active.y = active.ty
        } else {
          const k = Math.min(1, LERP_SPEED * dt)
          active.x += dx * k
          active.y += dy * k
        }
        // 拖动沿途小涟漪
        if (Math.hypot(active.x - active.sx, active.y - active.sy) > DRAG_SPACING) {
          spawn('ring', active.x, active.y, 0.55, 0.5)
          spawn('spark', active.x, active.y, 0.55, 0.5)
          active.sx = active.x
          active.sy = active.y
        }
      }
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      if (!updateParticle(particles[i], dt)) particles.splice(i, 1)
    }
  }

  /** 画布内坐标（同 gestures：clientX/Y - canvas rect） */
  function canvasPos(e) {
    const rect = view.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function onDown(e) {
    if (!getVisible()) return
    const { x, y } = canvasPos(e)
    // 提到 stage 顶层（模型/提示层 rebuild 后会插到本层之上）
    app.stage.addChild(layer)
    active = { x, y, tx: x, ty: y, t: 0, fired: -1, stopped: false, sx: x, sy: y }
  }
  function onMove(e) {
    if (!active || active.stopped) return
    const { x, y } = canvasPos(e)
    active.tx = x
    active.ty = y
  }
  function onUp() {
    if (active) active.stopped = true
  }

  view.addEventListener('pointerdown', onDown)
  view.addEventListener('pointermove', onMove)
  view.addEventListener('pointerup', onUp)
  view.addEventListener('pointercancel', onUp)
  view.addEventListener('pointerleave', onUp)

  return {
    update,
    destroy() {
      view.removeEventListener('pointerdown', onDown)
      view.removeEventListener('pointermove', onMove)
      view.removeEventListener('pointerup', onUp)
      view.removeEventListener('pointercancel', onUp)
      view.removeEventListener('pointerleave', onUp)
      for (const p of particles) p.sprite.destroy()
      particles.length = 0
      active = null
      layer.destroy({ children: true })
      textures.ring.baseTexture.destroy() // 两帧共用一个 base
    },
  }
}
