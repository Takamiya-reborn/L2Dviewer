/**
 * per-drawable multiply/screen 颜色渲染补丁（Cubism 4.2 语义，调色板换色的
 * 渲染侧）。
 *
 * moc3 v4 关键帧颜色（参数→ArtMesh multiply/screen 绑定）由 Core 在 update()
 * 时算入 model.drawables.multiplyColors/screenColors（本机探针证实 wuzang_3
 * 有 576 个件被 touch_drag11~14 等参数驱动颜色——调色板 RGB 变化的数据本体
 * 就在这）。pixi-live2d-display 0.4.0 内置的 Cubism 4.0 渲染器没有这组
 * uniform（官方 4.2 才加入），补丁三步：
 *   1. setGl 包装 gl.shaderSource——三个绘制片元着色器换成官方 4.2+ 源
 *      （u_multiplyColor/u_screenColor，公式逐字取自官方仓库
 *      Shaders/WebGL/fragshadersrc*.frag）；遮罩生成 shader 不需要色，不动。
 *   2. 复刻 doDrawModel 逐件循环（原实现加一行）记录当前 drawable 下标。
 *   3. setupShaderProgram 原实现以 useProgram 收尾、gl.drawElements 在
 *      drawMesh 里 setup 返回后才调用——补丁在原调用返回后补写两个
 *      uniform，程序仍在用，正好赶在绘制前。
 *
 * 无效色规则：multiply/screen 的 rgb 全 0 是编辑器"未设置"残留（wuzang_3
 * 约 300 个默认不可见的特效件烘焙值），官方语义会把它们渲成纯黑，动作
 * 中途显形会闪黑——这种组合回退默认色 (1,1,1)/(0,0,0)。
 */
import { CubismRenderer_WebGL, CubismShader_WebGL } from 'pixi-live2d-display/cubism4'

// 原始源（0.4.0 bundle 逐字）→ 官方 4.2+ 扩展源
const SHADER_REPLACEMENTS = new Map([
  [
    'precision mediump float;varying vec2       v_texCoord;uniform vec4       u_baseColor;uniform sampler2D  s_texture0;void main(){   gl_FragColor = texture2D(s_texture0 , v_texCoord) * u_baseColor;}',
    'precision mediump float;varying vec2       v_texCoord;uniform vec4       u_baseColor;uniform vec4       u_multiplyColor;uniform vec4       u_screenColor;uniform sampler2D  s_texture0;void main(){   vec4 texColor = texture2D(s_texture0, v_texCoord);   texColor.rgb = texColor.rgb * u_multiplyColor.rgb;   texColor.rgb = (texColor.rgb + u_screenColor.rgb * texColor.a) - (texColor.rgb * u_screenColor.rgb);   vec4 color = texColor * u_baseColor;   gl_FragColor = vec4(color.rgb, color.a);}',
  ],
  [
    'precision mediump float;varying vec2       v_texCoord;varying vec4       v_clipPos;uniform vec4       u_baseColor;uniform vec4       u_channelFlag;uniform sampler2D  s_texture0;uniform sampler2D  s_texture1;void main(){   vec4 col_formask = texture2D(s_texture0 , v_texCoord) * u_baseColor;   vec4 clipMask = (1.0 - texture2D(s_texture1, v_clipPos.xy / v_clipPos.w)) * u_channelFlag;   float maskVal = clipMask.r + clipMask.g + clipMask.b + clipMask.a;   col_formask = col_formask * maskVal;   gl_FragColor = col_formask;}',
    'precision mediump float;varying vec2       v_texCoord;varying vec4       v_clipPos;uniform vec4       u_baseColor;uniform vec4       u_channelFlag;uniform vec4       u_multiplyColor;uniform vec4       u_screenColor;uniform sampler2D  s_texture0;uniform sampler2D  s_texture1;void main(){   vec4 texColor = texture2D(s_texture0, v_texCoord);   texColor.rgb = texColor.rgb * u_multiplyColor.rgb;   texColor.rgb = (texColor.rgb + u_screenColor.rgb * texColor.a) - (texColor.rgb * u_screenColor.rgb);   vec4 col_formask = texColor * u_baseColor;   vec4 clipMask = (1.0 - texture2D(s_texture1, v_clipPos.xy / v_clipPos.w)) * u_channelFlag;   float maskVal = clipMask.r + clipMask.g + clipMask.b + clipMask.a;   col_formask = col_formask * maskVal;   gl_FragColor = col_formask;}',
  ],
  [
    'precision mediump float;varying vec2 v_texCoord;varying vec4 v_clipPos;uniform sampler2D s_texture0;uniform sampler2D s_texture1;uniform vec4 u_channelFlag;uniform vec4 u_baseColor;void main(){vec4 col_formask = texture2D(s_texture0, v_texCoord) * u_baseColor;vec4 clipMask = (1.0 - texture2D(s_texture1, v_clipPos.xy / v_clipPos.w)) * u_channelFlag;float maskVal = clipMask.r + clipMask.g + clipMask.b + clipMask.a;col_formask = col_formask * (1.0 - maskVal);gl_FragColor = col_formask;}',
    'precision mediump float;varying vec2 v_texCoord;varying vec4 v_clipPos;uniform sampler2D s_texture0;uniform sampler2D s_texture1;uniform vec4 u_channelFlag;uniform vec4 u_baseColor;uniform vec4 u_multiplyColor;uniform vec4 u_screenColor;void main(){vec4 texColor = texture2D(s_texture0, v_texCoord);texColor.rgb = texColor.rgb * u_multiplyColor.rgb;texColor.rgb = (texColor.rgb + u_screenColor.rgb * texColor.a) - (texColor.rgb * u_screenColor.rgb);vec4 col_formask = texColor * u_baseColor;vec4 clipMask = (1.0 - texture2D(s_texture1, v_clipPos.xy / v_clipPos.w)) * u_channelFlag;float maskVal = clipMask.r + clipMask.g + clipMask.b + clipMask.a;col_formask = col_formask * (1.0 - maskVal);gl_FragColor = col_formask;}',
  ],
])

let installed = false

/**
 * 安装一次（幂等，原型级补丁跨模型共享）。*无需*每舞台调用——补丁读
 * setupShaderProgram 入参里的 renderer 取模型与当前下标，无舞台态。
 */
export function installColorPatch() {
  if (installed) return
  installed = true

  // ---- shader 源替换：包住 shader 管理器持有的 gl（单例，跨挂载同一份） ----
  const shaderProto = CubismShader_WebGL.prototype
  const origSetGl = shaderProto.setGl
  shaderProto.setGl = function (gl) {
    origSetGl.call(this, gl)
    if (!gl.__cubismColorPatch) {
      gl.__cubismColorPatch = true
      const origShaderSource = gl.shaderSource.bind(gl)
      gl.shaderSource = (shader, source) =>
        origShaderSource(shader, SHADER_REPLACEMENTS.get(source) ?? source)
    }
  }

  // ---- 逐件下标记录：复刻 0.4.0 的 doDrawModel，循环体里加一行 ----
  const rendererProto = CubismRenderer_WebGL.prototype
  rendererProto.doDrawModel = function () {
    this.preDraw()
    if (this._clippingManager != null) {
      this._clippingManager.setupClippingContext(this.getModel(), this)
    }
    const drawableCount = this.getModel().getDrawableCount()
    const renderOrder = this.getModel().getDrawableRenderOrders()
    for (let i = 0; i < drawableCount; ++i) {
      const order = renderOrder[i]
      this._sortedDrawableIndexList[order] = i
    }
    for (let i = 0; i < drawableCount; ++i) {
      const drawableIndex = this._sortedDrawableIndexList[i]
      if (!this.getModel().getDrawableDynamicFlagIsVisible(drawableIndex)) {
        continue
      }
      this.setClippingContextBufferForDraw(
        this._clippingManager != null
          ? this._clippingManager.getClippingContextListForDraw()[drawableIndex]
          : null,
      )
      this.setIsCulling(this.getModel().getDrawableCulling(drawableIndex))
      this.__drawableIndex = drawableIndex
      this.drawMesh(
        this.getModel().getDrawableTextureIndices(drawableIndex),
        this.getModel().getDrawableVertexIndexCount(drawableIndex),
        this.getModel().getDrawableVertexCount(drawableIndex),
        this.getModel().getDrawableVertexIndices(drawableIndex),
        this.getModel().getDrawableVertices(drawableIndex),
        this.getModel().getDrawableVertexUvs(drawableIndex),
        this.getModel().getDrawableOpacity(drawableIndex),
        this.getModel().getDrawableBlendMode(drawableIndex),
        this.getModel().getDrawableInvertedMaskBit(drawableIndex),
      )
    }
  }

  // ---- uniform 落笔：原 setup 收尾后补写（程序仍在用） ----
  const locCache = new WeakMap() // program -> { mul, scr } 位置缓存
  const origSetup = shaderProto.setupShaderProgram
  shaderProto.setupShaderProgram = function (renderer, textureId /*, ...rest */) {
    origSetup.apply(this, arguments)
    const idx = renderer.__drawableIndex
    if (idx == null) return
    const gl = this.gl
    const program = gl.getParameter(gl.CURRENT_PROGRAM)
    if (!program) return
    let locs = locCache.get(program)
    if (locs === undefined) {
      locs = {
        mul: gl.getUniformLocation(program, 'u_multiplyColor'),
        scr: gl.getUniformLocation(program, 'u_screenColor'),
      }
      locCache.set(program, locs)
    }
    if (!locs.mul && !locs.scr) return
    // Core 原始模型：框架包装层 4.0 没有 getDrawableMultiplyColor，直读
    // Core 暴露的 Float32Array（update() 已按当前参数算好关键帧色）
    const raw = renderer.getModel()?._model?.drawables
    if (!raw?.multiplyColors || !raw?.screenColors) return
    const mc = raw.multiplyColors
    const sc = raw.screenColors
    let m0 = mc[idx * 4]
    let m1 = mc[idx * 4 + 1]
    let m2 = mc[idx * 4 + 2]
    let s0 = sc[idx * 4]
    let s1 = sc[idx * 4 + 1]
    let s2 = sc[idx * 4 + 2]
    // 无效色规则（见模块头）：rgb 全 0 = 编辑器未设置残留
    if (m0 === 0 && m1 === 0 && m2 === 0 && s0 === 0 && s1 === 0 && s2 === 0) {
      m0 = m1 = m2 = 1
    }
    if (locs.mul) gl.uniform4f(locs.mul, m0, m1, m2, 1)
    if (locs.scr) gl.uniform4f(locs.scr, s0, s1, s2, 1)
  }
}
