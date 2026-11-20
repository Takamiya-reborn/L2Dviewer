// moc3 二进制参数表解析：Cubism 4/5 头部节偏移表 -> 参数 max/min/default 三张 f32 数组。

// 从 moc3 二进制解析参数 (max, min, default) 三张表。
// Cubism 4/5（版本字节=4/5，两者节表布局一致，表项数 117/129）头部 0x40 起为节偏移表（递增 u32，直到不再递增），表[51]=max、表[52]=min、表[53]=defaults，各 n_f32，按 CubismParameter._unmanagedIndex 对位。
// 校验 min<=default<=max，不满足（moc 版本不同/对位错）则返回 null。
export function moc3ParamTables(moc3Bytes, nParams) {
  if (moc3Bytes.length < 0x240 || (moc3Bytes[4] !== 4 && moc3Bytes[4] !== 5))
    return null;
  const tbl = [];
  let prev = 0;
  let off = 0x40;
  while (off < 0x400) {
    const u = moc3Bytes.readUInt32LE(off);
    if (u <= prev || u >= moc3Bytes.length) break;
    tbl.push(u);
    prev = u;
    off += 4;
  }
  if (tbl.length < 54) return null;
  const n = nParams;
  const section = (base) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(moc3Bytes.readFloatLE(base + i * 4));
    return out;
  };
  const maxs = section(tbl[51]);
  const mins = section(tbl[52]);
  const defs = section(tbl[53]);
  for (let i = 0; i < n; i++) {
    if (!(mins[i] <= defs[i] && defs[i] <= maxs[i])) return null;
  }
  return { maxs, mins, defs };
}
