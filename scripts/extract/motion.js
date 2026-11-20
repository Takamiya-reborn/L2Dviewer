// Unity AnimationClip -> Cubism motion3 曲线：流式/稠密/常量三段解码、CRC32 哈希绑定解析、
// 交互状态首末值提取。字段名与 Unity 序列化 typetree 一致（m_* 或绑定用平名）。

import zlib from "node:zlib";

// 曲线 attribute 也是 CRC32 哈希，本游戏用到三种：
//   Value         -> 参数曲线（Target: Parameter）
//   Opacity       -> 部件不透明度曲线（Target: PartOpacity；根对象 CubismRenderController 的整模型透明度单独特判）
//   MouthOpening  -> 根对象 CubismMouthController.MouthOpening，游戏 LateUpdate 按 BlendMode 覆写口参数，迁移为口参数的参数曲线
// 其余 attribute 视为未知，跳过并告警（原始绑定保留在 inventory.json）
export const CRC_VALUE = zlib.crc32(Buffer.from("Value")) >>> 0;
export const CRC_OPACITY = zlib.crc32(Buffer.from("Opacity")) >>> 0;
export const CRC_MOUTH = zlib.crc32(Buffer.from("MouthOpening")) >>> 0;

export function crc32(s) {
  return zlib.crc32(Buffer.from(s, "utf8")) >>> 0;
}

// ---------------------------------------------------------------- Unity 流式曲线解码
// 逐帧由后键计算本键 inSlope（Unity 原生算法）；stepped 曲线三系数全 0，返回 Infinity
function calculateNextInSlope(key, dx, rhs) {
  if (key.coeff[0] === 0 && key.coeff[1] === 0 && key.coeff[2] === 0)
    return Infinity;
  dx = Math.max(dx, 0.0001);
  const dy = rhs.value - key.value;
  const length = 1.0 / (dx * dx);
  const d1 = key.outSlope * dx;
  const d2 = dy + dy + dy - d1 - d1 - key.coeff[1] / length;
  return d2 / dx;
}

// 流式段原始 u32 数组 -> 帧列表 [{time, keys:[{index, value, outSlope, inSlope}]}]
export function readStreamedFrames(u32Data) {
  const buf = Buffer.alloc(u32Data.length * 4);
  for (let i = 0; i < u32Data.length; i++)
    buf.writeUInt32LE(u32Data[i] >>> 0, i * 4);
  const frames = [];
  let pos = 0;
  const f32 = () => {
    const v = buf.readFloatLE(pos);
    pos += 4;
    return v;
  };
  const i32 = () => {
    const v = buf.readInt32LE(pos);
    pos += 4;
    return v;
  };
  while (pos < buf.length) {
    const time = f32();
    const numKeys = i32();
    const keys = [];
    for (let i = 0; i < numKeys; i++) {
      const index = i32();
      const coeff = [f32(), f32(), f32(), f32()];
      keys.push({
        index,
        coeff,
        outSlope: coeff[2],
        value: coeff[3],
        inSlope: 0.0,
      });
    }
    frames.push({ time, keys });
  }
  for (let fi = 2; fi < frames.length; fi++) {
    const frame = frames[fi];
    for (const key of frame.keys) {
      let i = fi - 1;
      while (i >= 0) {
        const pre = frames[i];
        const match = pre.keys.find((x) => x.index === key.index);
        if (match) {
          key.inSlope = calculateNextInSlope(match, frame.time - pre.time, key);
          break;
        }
        i--;
      }
    }
  }
  return frames;
}

// 帧列表 -> 绑定序号 -> [(t, v, outSlope, inSlope)]；Unity 流式数据的起始标记帧（t < -1e30）剔除
export function collectStreamedKeys(frames) {
  const streamedKeys = new Map();
  if (!frames) return streamedKeys;
  for (const frame of frames) {
    const t = frame.time;
    if (t < -1e30) continue;
    for (const key of frame.keys) {
      if (!streamedKeys.has(key.index)) streamedKeys.set(key.index, []);
      streamedKeys
        .get(key.index)
        .push([t, key.value, key.outSlope, key.inSlope]);
    }
  }
  return streamedKeys;
}

// 常量段按绑定顺序隐式对位（m_IndexArray 恒 -1 死字段）：constant 第 k 项 = 第 k 个无 streamed/dense 数据的绑定
function constantKeys(cd, bindings, streamedKeys, curveMeta, cw) {
  const constant = cd.m_ConstantClip.data ?? [];
  const covered = new Set(streamedKeys.keys());
  const dense = cd.m_DenseClip;
  const denseN =
    dense.m_CurveCount > 0 && dense.m_SampleArray?.length
      ? dense.m_CurveCount
      : 0;
  for (let i = 0; i < denseN; i++) covered.add(i);
  const constantKeys = new Map();
  let k = 0;
  for (let i = 0; i < bindings.length; i++) {
    if (covered.has(i)) continue;
    if (k < constant.length && curveMeta.has(i)) {
      constantKeys.set(i, [[0.0, constant[k], 0.0, 0.0]]);
    }
    k += 1;
  }
  if (k !== constant.length) {
    cw(
      `常量段 ${constant.length} 值 vs 非流式绑定 ${k} 条，隐式对位假设可能失效`,
    );
  }
  return constantKeys;
}

// 稠密采样：curve_count x frame_count，曲线 i 的第 s 个采样在 samples[s*n + i]
function denseKeys(cd, bindings) {
  const dense = cd.m_DenseClip;
  const keys = new Map();
  if (dense.m_CurveCount > 0 && dense.m_SampleArray?.length) {
    const n = dense.m_CurveCount;
    const samples = dense.m_SampleArray;
    const step = 1.0 / dense.m_SampleRate;
    const frames = Math.floor(samples.length / n);
    for (let i = 0; i < n; i++) {
      const pts = [];
      for (let s = 0; s < frames; s++) {
        pts.push([s * step + dense.m_BeginTime, samples[s * n + i], 0.0, 0.0]);
      }
      keys.set(i, pts);
    }
  }
  return keys;
}

// AnimationClip -> motion3 曲线列表 [{id, target, segments}]。
// rootTargets: 根对象(path=0) attribute -> (迁移目标 id, target)。
// clipName 只用于告警消息。返回 { curves, duration, unresolvedHashes }。
export function convertClip(
  cd,
  mc,
  bindings,
  pathHash,
  clipName,
  warn,
  rootTargets,
) {
  const cw = (msg) => warn(`${clipName}: ${msg}`);
  const streamedFrames = cd.m_StreamedClip.data?.length
    ? readStreamedFrames(cd.m_StreamedClip.data)
    : null;
  const streamedKeys = collectStreamedKeys(streamedFrames);

  // 绑定 index -> (id, target)；同时统计静默丢失来源，收尾统一告警
  const curveMeta = new Map();
  const lateNames = new Set(); // 根对象迁移曲线（游戏侧 LateUpdate 覆写语义），排序须落在同目标组末位
  let unresolved = 0;
  const unresolvedHashes = [];
  const unknownAttr = new Map();
  for (let i = 0; i < bindings.length; i++) {
    const b = bindings[i];
    const rel = pathHash.get(b.path);
    if (rel === undefined) {
      // 根对象(path=0)的 CubismRenderController.Opacity 绑定：游戏用整模型透明度做动作内淡入淡出/防渐变残留钉 1。
      // motion3 官方规范有模型级曲线槽位（Target="Model"，Id 固定 "Opacity"），原值照录不丢。
      if (b.path === 0 && b.attribute === CRC_OPACITY) {
        curveMeta.set(i, ["Opacity", "Model"]);
      } else if (b.path === 0 && rootTargets && rootTargets.has(b.attribute)) {
        // 其余根对象绑定按迁移表翻成参数曲线（如 MouthOpening -> 口参数）
        const [name, target] = rootTargets.get(b.attribute);
        curveMeta.set(i, [name, target]);
        lateNames.add(name);
      } else {
        unresolved += 1;
        unresolvedHashes.push(b.path);
      }
      continue;
    }
    const name = rel.split("/").pop();
    if (b.attribute === CRC_VALUE) {
      curveMeta.set(i, [name, "Parameter"]);
    } else if (b.attribute === CRC_OPACITY) {
      curveMeta.set(i, [name, "PartOpacity"]);
    } else {
      unknownAttr.set(b.attribute, (unknownAttr.get(b.attribute) ?? 0) + 1);
    }
  }

  const cKeys = constantKeys(cd, bindings, streamedKeys, curveMeta, warn);
  const dKeys = denseKeys(cd, bindings);

  // 常量曲线的持续范围：Unity 里常量在整支动作内生效（m_StopTime 封顶）。
  // Cubism 官方解析不接受零段曲线——单关键帧曲线一律表达为 stepped 段铺满时长。
  const stopTime = mc.m_StopTime || 0.0;
  let keyMaxT = 0.0;
  for (const ks of [...streamedKeys.values(), ...dKeys.values()]) {
    if (ks.length) keyMaxT = Math.max(keyMaxT, ks[ks.length - 1][0]);
  }
  const clipDur = Math.max(keyMaxT, stopTime);

  const curves = [];
  const metaIndices = [...curveMeta.keys()].sort((a, b) => a - b);
  for (const i of metaIndices) {
    const [name, target] = curveMeta.get(i);
    const keys = streamedKeys.get(i) || cKeys.get(i) || dKeys.get(i);
    if (!keys) continue;
    keys.sort((a, b) => a[0] - b[0]);
    const segs = [keys[0][0], keys[0][1]];
    if (keys.length === 1) {
      // 单关键帧 = 常量：stepped 段铺满动作时长（clipDur=0 的极端场合才退化为裸单点）
      if (clipDur > keys[0][0]) segs.push(2, clipDur, keys[0][1]);
    }
    for (let j = 0; j < keys.length - 1; j++) {
      const [t0, v0, out0] = keys[j];
      const [t1, v1, , in1] = keys[j + 1];
      const dt = t1 - t0;
      if (dt <= 0) continue;
      if (!Number.isFinite(in1)) {
        // stepped
        segs.push(2, t1, v1);
      } else {
        const c1t = t0 + dt / 3.0;
        const c1v = v0 + (out0 * dt) / 3.0;
        const c2t = t1 - dt / 3.0;
        const c2v = v1 - (in1 * dt) / 3.0;
        // Cubism 段类型: 0=Linear 1=Bezier 2=Stepped 3=InverseStepped
        segs.push(1, c1t, c1v, c2t, c2v, t1, v1);
      }
    }
    curves.push({ Id: name, Target: target, Segments: segs });
  }

  if (unresolved) {
    // 告警带哈希样本：拿哈希对参数/部件名暴力撞库即可定案该曲线是否模型对象（inventory.json 同存原始绑定）
    const sample = unresolvedHashes
      .slice(0, 6)
      .map((h) => h.toString(16).padStart(8, "0"))
      .join(" ");
    const more = unresolved > 6 ? ` ...共${unresolved}条` : "";
    warn(
      `${clipName}: ${unresolved} 条绑定路径哈希未解析(${sample}${more})，曲线被跳过`,
    );
  }
  for (const [h, n] of unknownAttr) {
    warn(
      `${clipName}: ${n} 条未知 attribute 0x${h.toString(16).padStart(8, "0")}，曲线被跳过`,
    );
  }

  // Cubism 内核按曲线类型顺序求值（Model→Parameter→PartOpacity 三段循环，遇类型切换即停），目标混排会让其后同型曲线整体失效，按官方约定分组排序（稳定排序，同目标内相对次序不变）
  // 根对象迁移曲线（如口参数）排参数组末位：游戏侧是 LateUpdate 覆写，须晚于动作对口参数的直接写入
  const targetRank = { Model: 0, Parameter: 1, PartOpacity: 2 };
  curves.sort((a, b) => {
    const ra = targetRank[a.Target] ?? 1;
    const rb = targetRank[b.Target] ?? 1;
    if (ra !== rb) return ra - rb;
    return (lateNames.has(a.Id) ? 1 : 0) - (lateNames.has(b.Id) ? 1 : 0);
  });

  let duration = 0.0;
  for (const c of curves) {
    duration = Math.max(
      duration,
      c.Segments[0],
      c.Segments[c.Segments.length - 2],
    );
  }
  return { curves, duration };
}

export function motion3Json(curves, duration, loop) {
  // 段消耗: Linear=3 值, Bezier=7 值, Stepped/InverseStepped=3 值
  // 点数: 每段 1 个点, 贝塞尔额外含 2 个控制点 (共 3)
  let totalSeg = 0;
  let totalPt = 0;
  for (const c of curves) {
    const segs = c.Segments;
    let i = 2;
    while (i < segs.length) {
      const typ = Math.trunc(segs[i]);
      i += [3, 7, 3, 3][typ] ?? 3;
      totalSeg += 1;
      totalPt += typ === 1 ? 3 : 1;
    }
    totalPt += 1; // 曲线首点
  }
  return {
    Version: 3,
    Meta: {
      Duration: roundTo(duration, 6),
      Fps: 30.0,
      Loop: loop,
      CurveCount: curves.length,
      TotalSegmentCount: totalSeg,
      TotalPointCount: totalPt,
      Curves: curves.map((c) => ({
        Id: c.Id,
        Segments: c.Segments,
        Target: c.Target,
      })),
    },
    Curves: curves,
  };
}

export function clipEvents(clip) {
  // AnimationEvent 列表 -> [{time, function, int}]。
  // 游戏交互状态机的载体之一：OnAnimEvent(0) 在动作开头触发（配音/语音钩子），OnFinishAnim(N) 在动作结尾上报状态编号，
  // 游戏控制器据此决定动作结束后回到哪个状态。
  return (clip.m_Events ?? []).map((e) => ({
    time: roundTo(e.time, 3),
    function: e.functionName,
    int: e.intParameter,
  }));
}

// 按小数位取整：10^digits 缩放后取整（实际数据无 .5 平局）
function roundTo(v, digits) {
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}

// ---------------------------------------------------------------- 交互状态首末值

function defaultSwitchLike(rng) {
  // moc 默认值贴 0/±1 的参数才可能是开关。
  // 默认值落在量程中间（如氛围球 0.7）说明参数是连续量旋钮：按开关处理会造出"自己要求自己产出"的死锁门控。
  if (!rng) return true;
  const d = rng.default;
  if (d === undefined) return true;
  return Math.min(Math.abs(d), Math.abs(d - 1.0), Math.abs(d + 1.0)) <= 0.02;
}

function allSwitchLike(values) {
  // 图层/道具开关型参数：全部采样值都贴着 0/1/-1。
  // 连续 pose 参数（视线、嘴形等）取值虽也在 [-1,1]，但中间值会落选。
  return values.every(
    (v) => Math.min(Math.abs(v), Math.abs(v - 1.0), Math.abs(v + 1.0)) <= 0.02,
  );
}

function boundarySwitchLike(values, rng) {
  // 带弹性过冲的开关曲线：首末采样贴 0/±1，全程不越出 moc 量程（容差 0.05），且量程宽度 ≤1.25。
  // 量程宽度是反向保险：姿态移动件即便首末值恰好贴 0/±1 也不得入选，否则会被拿去做点击门控。
  if (!rng || rng.max - rng.min > 1.25) return false;
  const v0 = values[0];
  const vN = values[values.length - 1];
  if (Math.min(Math.abs(v0), Math.abs(v0 - 1.0), Math.abs(v0 + 1.0)) > 0.02)
    return false;
  if (Math.min(Math.abs(vN), Math.abs(vN - 1.0), Math.abs(vN + 1.0)) > 0.02)
    return false;
  return values.every((v) => rng.min - 0.05 <= v && v <= rng.max + 0.05);
}

// 每支动作的首/末参数值，供还原跨动作交互状态。返回 { state, carry }：
// state（开关型）：该状态跨动作持续，由此可推出"打开器/分支"的点击门控协议。
// carry（连续型）：凡首/末值非零的连续参数一律落盘，运行时按"结束值即当前状态"跨动作保留。
// ranges 是 moc3 参数量程（pid -> {min,max,default}），供 boundarySwitchLike 识别带过冲的开关曲线。
export function clipBoundaryState(cd, bindings, pathHash, ranges) {
  // 逐绑定收集全部采样值与首/末值
  const series = new Map(); // 绑定序号 -> [(t, v)]
  if (cd.m_StreamedClip.data?.length) {
    for (const frame of readStreamedFrames(cd.m_StreamedClip.data)) {
      if (frame.time < -1e30) continue;
      for (const key of frame.keys) {
        if (!series.has(key.index)) series.set(key.index, []);
        series.get(key.index).push([frame.time, key.value]);
      }
    }
  }
  // constant 段与 convertClip 同一解码：m_IndexArray 死字段，按绑定顺序隐式对位
  const constant = cd.m_ConstantClip.data ?? [];
  const covered = new Set(series.keys());
  const dense = cd.m_DenseClip;
  if (dense.m_CurveCount > 0 && dense.m_SampleArray?.length) {
    for (let i = 0; i < dense.m_CurveCount; i++) covered.add(i);
  }
  let k = 0;
  for (let i = 0; i < bindings.length; i++) {
    if (covered.has(i)) continue;
    if (k < constant.length) {
      if (!series.has(i)) series.set(i, []);
      series.get(i).push([0.0, constant[k]]);
    }
    k += 1;
  }
  if (dense.m_CurveCount > 0 && dense.m_SampleArray?.length) {
    const n = dense.m_CurveCount;
    const samples = dense.m_SampleArray;
    const step = 1.0 / dense.m_SampleRate;
    const frames = Math.floor(samples.length / n);
    for (let i = 0; i < Math.min(n, bindings.length); i++) {
      for (let s = 0; s < frames; s++) {
        if (!series.has(i)) series.set(i, []);
        series.get(i).push([s * step + dense.m_BeginTime, samples[s * n + i]]);
      }
    }
  }

  const state = {};
  const carry = {};
  for (const [i, pts] of series) {
    if (i >= bindings.length) continue;
    const rel = pathHash.get(bindings[i].path);
    if (rel === undefined) continue;
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const values = pts.map(([, v]) => v);
    const pid = rel.split("/").pop();
    const rng = ranges ? ranges.get(pid) : null;
    if (
      defaultSwitchLike(rng) &&
      (allSwitchLike(values) || boundarySwitchLike(values, rng))
    ) {
      // 首末均为 0 也必须记（[0, 0]）——这是有向图的回零边；剔除会让节点学不到"已归零"
      state[pid] = [roundTo(pts[0][1], 4), roundTo(pts[pts.length - 1][1], 4)];
    } else if (
      Math.abs(pts[0][1]) > 1e-4 ||
      Math.abs(pts[pts.length - 1][1]) > 1e-4
    ) {
      // 连续参数只要首/末残留非零就记：收尾动作把它带回 0 的（末=0 首非 0）也必须记
      carry[pid] = [roundTo(pts[0][1], 4), roundTo(pts[pts.length - 1][1], 4)];
    }
  }
  return { state, carry };
}

export const LOOP_GROUPS = new Set(["idle"]); // 循环播放的动作组（login 播完一次后由运行时切回 idle）

export function clipGroup(name) {
  if (name.startsWith("touch_idle")) return "touch_idle";
  if (name.startsWith("touch_drag")) return "touch_drag";
  if (name.startsWith("idle")) return "idle";
  return name;
}
