// Texture2D 解码：unityfs-js 已路由非 ASTC 格式；ASTC 48-59 用 texture2ddecoder-wasm 自补分支。
// decode_astc 输出 BGRA -> 转 RGBA -> 垂直翻转 -> 手写 PNG 编码（零 PNG 依赖）。

import { deflateSync, crc32 as zlibCrc32 } from "node:zlib";
import Decoder from "texture2ddecoder-wasm";

const ASTC_BLOCKS = {
  ASTC_RGB_4x4: [4, 4],
  ASTC_RGB_5x5: [5, 5],
  ASTC_RGB_6x6: [6, 6],
  ASTC_RGB_8x8: [8, 8],
  ASTC_RGB_10x10: [10, 10],
  ASTC_RGB_12x12: [12, 12],
  ASTC_RGBA_4x4: [4, 4],
  ASTC_RGBA_5x5: [5, 5],
  ASTC_RGBA_6x6: [6, 6],
  ASTC_RGBA_8x8: [8, 8],
  ASTC_RGBA_10x10: [10, 10],
  ASTC_RGBA_12x12: [12, 12],
};

export function isAstcFormat(formatName) {
  return formatName in ASTC_BLOCKS;
}

// 流式贴图数据（bundle 内 .resS 段）就位；已内嵌数据的贴图原样返回
function resolveTextureData(tex, manager) {
  if (tex.data && tex.data.length) return tex.data;
  const s = tex.streamData;
  if (!s) throw new Error(`贴图 ${tex.name} 无图像数据`);
  const resolved = manager.resolveResource(s.path, s.offset, s.size);
  if (!resolved)
    throw new Error(`贴图 ${tex.name} 流式数据解析失败: ${s.path}`);
  return resolved;
}

// ASTC Texture2D -> { width, height, png: Uint8Array }
// 默认翻转为标准 top-down PNG（与 PNG 行序约定一致）；flip=false 保留 Unity
// 原始行序（自底向上）仅供特殊采样语义使用
export async function decodeAstcTexture(tex, manager, { flip = true } = {}) {
  const [blockWidth, blockHeight] = ASTC_BLOCKS[tex.textureFormat];
  const data = resolveTextureData(tex, manager);
  const bgra = await Decoder.decode_astc(
    data,
    tex.width,
    tex.height,
    blockWidth,
    blockHeight,
  );
  if (!bgra) throw new Error(`贴图 ${tex.name} ASTC 解码失败`);
  const { width, height } = tex;
  const rgba = new Uint8Array(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2];
    rgba[i + 1] = bgra[i + 1];
    rgba[i + 2] = bgra[i];
    rgba[i + 3] = bgra[i + 3];
  }
  // Unity 纹理行序自底向上，PNG 自顶向下
  const flipped = new Uint8Array(rgba.length);
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    const src = flip ? (height - 1 - y) * row : y * row;
    flipped.set(rgba.subarray(src, src + row), y * row);
  }
  return { width, height, png: encodePng(flipped, width, height) };
}

// RGBA8 -> PNG 字节流（IHDR/IDAT/IEND，filter 0 逐行直写，zlib deflate）
export function encodePng(rgba, width, height) {
  const chunk = (type, body) => {
    const buf = Buffer.alloc(12 + body.length);
    buf.writeUInt32BE(body.length, 0);
    buf.write(type, 4, "latin1");
    Buffer.from(body).copy(buf, 8);
    buf.writeUInt32BE(
      zlibCrc32(buf.subarray(4, 8 + body.length)) >>> 0,
      8 + body.length,
    );
    return buf;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // compression/filter/interlace 全 0
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * stride + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
