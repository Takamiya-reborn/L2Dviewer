"""碧蓝航线 Live2D 皮肤提取器：UnityFS bundle -> 标准 Cubism 4 模型。

用法（uv 与裸 python 二选一）:
    uv run scripts/extract.py <skin_id>
    python scripts/extract.py <skin_id>     # 裸 python，需先 pip install -r requirements.txt
    ... <bundle_path> <out_dir>             # 兼容旧用法

产物 (out_dir) —— 一次提取即完整模型资源，逆向无需再回头 dump:

    <id>.moc3 / <id>.model3.json / <id>.physics3.json / <id>.char.json
    <id>.interaction.json   （clips 交互状态数据 + animator 动作编号路由表）
    <id>.defaults.json      参数默认值/min/max（解析自 moc3 二进制，见下）
    <id>.inventory.json     bundle 全量参考：GameObject 表、全部组件 typetree
                            （CubismMoc._bytes 除外——.moc3 文件本身已落盘）、
                            AnimationClip 事件与绑定
    textures/texture_XX.png
    motions/<clip_name>.motion3.json

原理 (见 docs/azurlane.md):
    - CubismMoc._bytes 直接是 moc3 二进制
    - 贴图 Texture2D (ASTC 由 UnityPy 转码) -> PNG
    - TextAsset *.physics3 为 JSON 原文（非 UTF-8 的 TextAsset 落 .bin 原始字节）
    - Unity AnimationClip (streamed+constant 曲线, CRC32 哈希绑定) -> motion3.json
    - moc3 默认值：Cubism 4 (moc3 版本字节=4) 头部 0x40 起是节偏移表
      (递增 u32)；表[51]=参数 max、表[52]=min、表[53]=defaults，各为
      n_f32 数组、按 CubismParameter._unmanagedIndex 对位（字符串槽区
      顺序与此无关）。min<=default<=max 全程成立可作校验。
"""

import argparse
import json
import math
import re
import struct
import zlib
from pathlib import Path

import UnityPy

# 固定路径约定：bundle 由 pull_bundles.py 拉到 .tmp/bundles/<skin_id>，
# 产物按 models/<角色>/<skin_id>/ 归档（scan_models.mjs 按此路径生成清单）
ROOT = Path(__file__).resolve().parents[1]
BUNDLE_DIR = ROOT / ".tmp" / "bundles"
MODEL_ROOT = ROOT / "models"


def char_name(model_id: str) -> str:
    """模型 id -> 角色目录名：fulici_2 -> fulici，shengluyisi_2_hx -> shengluyisi"""
    base = re.sub(r"_hx$", "", model_id)
    return re.sub(r"_\d+$", "", base)


# ---------------------------------------------------------------- Unity 曲线解码
# 以下从 UnityPy 1.9.28 classes/AnimationClip.py 摘取所需部分 (MIT License)


class _Reader:
    """小端二进制读取垫片。"""

    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def read(self, n: int) -> bytes:
        v = self.data[self.pos : self.pos + n]
        self.pos += n
        return v

    def read_float(self) -> float:
        return struct.unpack("<f", self.read(4))[0]

    def read_int(self) -> int:
        return struct.unpack("<i", self.read(4))[0]

    def read_u_int(self) -> int:
        return struct.unpack("<I", self.read(4))[0]

    def read_float_array(self, n: int) -> list:
        return [self.read_float() for _ in range(n)]


class StreamedCurveKey:
    def __init__(self, reader: _Reader):
        self.index = reader.read_int()
        self.coeff = reader.read_float_array(4)
        self.outSlope = self.coeff[2]
        self.value = self.coeff[3]
        self.inSlope = 0.0

    def calculate_next_in_slope(self, dx: float, rhs: "StreamedCurveKey") -> float:
        # 逐帧由后键计算本键 inSlope (Unity 原生算法)
        if self.coeff[0] == 0 and self.coeff[1] == 0 and self.coeff[2] == 0:
            return math.inf  # stepped
        dx = max(dx, 0.0001)
        dy = rhs.value - self.value
        length = 1.0 / (dx * dx)
        d1 = self.outSlope * dx
        d2 = dy + dy + dy - d1 - d1 - self.coeff[1] / length
        return d2 / dx


class StreamedFrame:
    def __init__(self, reader: _Reader):
        self.time = reader.read_float()
        num_keys = reader.read_int()
        self.key_list = [StreamedCurveKey(reader) for _ in range(num_keys)]


class StreamedClip:
    def __init__(self, clip):
        self.data = clip.m_StreamedClip.data
        self.curve_count = clip.m_StreamedClip.curveCount

    def read_data(self) -> list:
        frame_list = []
        buf = b"".join(struct.pack("<I", v) for v in self.data)
        reader = _Reader(buf)
        while reader.pos < len(buf):
            frame_list.append(StreamedFrame(reader))

        for fi in range(2, len(frame_list)):
            frame = frame_list[fi]
            for key in frame.key_list:
                i = fi - 1
                while i >= 0:
                    pre = frame_list[i]
                    match = [x for x in pre.key_list if x.index == key.index]
                    if match:
                        key.inSlope = match[0].calculate_next_in_slope(
                            frame.time - pre.time, key
                        )
                        break
                    i -= 1
        return frame_list


# ---------------------------------------------------------------- 绑定解析


def crc32(s: str) -> int:
    return zlib.crc32(s.encode("utf-8")) & 0xFFFFFFFF


# 曲线 attribute 也是 CRC32 哈希（fulici_2 实测仅两种）：
#   Value   -> 参数曲线（Target: Parameter）
#   Opacity -> 部件不透明度曲线（Target: PartOpacity）
# 其余 attribute 视为未知，跳过并告警（原始绑定保留在 inventory.json）
CRC_VALUE = zlib.crc32(b"Value") & 0xFFFFFFFF
CRC_OPACITY = zlib.crc32(b"Opacity") & 0xFFFFFFFF


def build_hierarchy(env):
    """返回 {transform_path_id: (go_name, path_from_root, go_path_id)} 与根列表。

    path_from_root 含根名，形如 root/Parameters/ParamAngleX。
    """
    go_by_pid = {}
    tr_by_pid = {}
    for obj in env.objects:
        if obj.type.name == "GameObject":
            go_by_pid[obj.path_id] = obj.read()
        elif obj.type.name == "Transform":
            tr_by_pid[obj.path_id] = obj.read()

    # transform -> gameobject path_id
    tr_go_pid = {}
    for tr_pid, tr in tr_by_pid.items():
        tr_go_pid[tr_pid] = tr.m_GameObject.m_PathID

    infos = {}
    roots = []
    for tr_pid, tr in tr_by_pid.items():
        father = tr.m_Father.m_PathID
        if father not in tr_by_pid:
            roots.append(tr_pid)

    def visit(tr_pid, path):
        tr = tr_by_pid[tr_pid]
        go = go_by_pid[tr_go_pid[tr_pid]]
        name = go.m_Name
        full = f"{path}/{name}" if path else name
        infos[tr_pid] = (name, full, tr_go_pid[tr_pid])
        for child in tr.m_Children:
            cpid = child.m_PathID
            if cpid in tr_by_pid:
                visit(cpid, full)

    for r in roots:
        visit(r, "")
    return infos, roots


def resolve_hash_bindings(env, param_cls_names=("CubismParameter",)):
    """收集游戏对象路径的 CRC32 -> 名称映射, 以及 script 类名表。"""
    scripts = {}
    for obj in env.objects:
        if obj.type.name == "MonoScript":
            scripts[obj.path_id] = obj.read().m_ClassName

    infos, _roots = build_hierarchy(env)
    path_hash = {}
    for name, full, _gopid in infos.values():
        # 绑定路径相对 Animator 根, 通常不含根对象名
        if "/" in full:
            rel = full.split("/", 1)[1]
            path_hash[crc32(rel)] = rel
            path_hash[crc32(rel.lower())] = rel
        path_hash[crc32(full)] = full
        path_hash[crc32(name)] = name
    return scripts, path_hash, infos


# ---------------------------------------------------------------- moc3 参数默认值


def moc3_param_tables(moc3_bytes: bytes, n_params: int):
    """从 moc3 二进制解析参数 (max, min, default) 三张表。

    Cubism 4 (版本字节=4) 头部 0x40 起为节偏移表（递增 u32，直到不再递增），
    表[51]=max、表[52]=min、表[53]=defaults，各 n_f32，按
    CubismParameter._unmanagedIndex 对位。校验 min<=default<=max，
    不满足（moc 版本不同/对位错）则返回 None。
    """
    if len(moc3_bytes) < 0x240 or moc3_bytes[4] != 4:
        return None
    tbl, prev, off = [], 0, 0x40
    while off < 0x400:
        (u,) = struct.unpack_from("<I", moc3_bytes, off)
        if u <= prev or u >= len(moc3_bytes):
            break
        tbl.append(u)
        prev = u
        off += 4
    if len(tbl) < 54:
        return None
    n = n_params

    def section(base: int) -> list:
        return list(struct.unpack_from(f"<{n}f", moc3_bytes, base))

    maxs, mins, defs = section(tbl[51]), section(tbl[52]), section(tbl[53])
    for mn, dv, mx in zip(mins, defs, maxs):
        if not (mn <= dv <= mx):
            return None
    return maxs, mins, defs


# ---------------------------------------------------------------- 提取


def convert_clip(clip, bindings, path_hash, duration_hint=None):
    """AnimationClip -> motion3 曲线列表 [{id, target, segments}]。"""
    mc = clip.m_MuscleClip
    clip_data = mc.m_Clip.data

    streamed_frames = None
    if clip_data.m_StreamedClip.data:
        streamed_frames = StreamedClip(clip_data).read_data()

    dense = clip_data.m_DenseClip
    constant = clip_data.m_ConstantClip.data

    # 绑定 index -> (id, target)；同时统计静默丢失来源，收尾统一告警
    curve_meta = {}
    unresolved = 0
    unknown_attr = {}
    for i, b in enumerate(bindings):
        rel = path_hash.get(b.path)
        if rel is None:
            unresolved += 1
            continue
        name = rel.split("/")[-1]
        if b.attribute == CRC_VALUE:
            curve_meta[i] = (name, "Parameter")
        elif b.attribute == CRC_OPACITY:
            curve_meta[i] = (name, "PartOpacity")
        else:
            unknown_attr[b.attribute] = unknown_attr.get(b.attribute, 0) + 1

    # streamed: key.index 即绑定序号
    streamed_keys = {}  # idx -> [(t, v, outSlope, inSlope)]
    if streamed_frames:
        for frame in streamed_frames:
            t = frame.time
            if t < -1e30:  # Unity 流式数据的起始标记帧, 非真实关键帧
                continue
            for key in frame.key_list:
                streamed_keys.setdefault(key.index, []).append(
                    (t, key.value, key.outSlope, key.inSlope)
                )

    # constant: 本 Unity 版本的 m_IndexArray 恒为 -1（死字段），常量段按绑定
    # 顺序隐式对位——constant.data 第 k 项 = 第 k 个无 streamed 关键帧的绑定。
    # 实测全部 clip 满足 len(constant) == 绑定数 - streamed 绑定数（见
    # docs/azurlane.md 常量段一节）。被压成常量的曲线同样是被动画的：值为 0
    # 但模型默认值非 0 的参数（如氛围球 0.7）必须钉到 0，不能漏。
    covered = set(streamed_keys)
    dense_n = (
        dense.m_CurveCount if dense.m_CurveCount > 0 and dense.m_SampleArray else 0
    )
    covered.update(range(dense_n))
    constant_keys = {}
    k = 0
    for i in range(len(bindings)):
        if i in covered:
            continue
        if k < len(constant) and i in curve_meta:
            constant_keys[i] = [(0.0, constant[k], 0.0, 0.0)]
        k += 1
    if k != len(constant):
        print(
            f"[warn] {clip.m_Name}: 常量段 {len(constant)} 值 vs 非流式绑定 {k} 条，"
            f"隐式对位假设可能失效"
        )

    # dense: 稠密采样, curve_count x frame_count
    dense_keys = {}
    if dense.m_CurveCount > 0 and dense.m_SampleArray:
        n = dense.m_CurveCount
        samples = dense.m_SampleArray
        step = 1.0 / dense.m_SampleRate
        for i in range(n):
            pts = [
                (s * step + dense.m_BeginTime, samples[s * n + i])
                for s in range(len(samples) // n)
            ]
            dense_keys[i] = [(t, v, 0.0, 0.0) for (t, v) in pts]

    # 常量曲线的持续范围：Unity 里常量在整支动作内生效（m_StopTime 封顶）。
    # 播放器（Cubism 官方解析）不接受零段曲线——读基点后会对 undefined 段类型
    # 空转一圈并多耗一个段配额，totalSegmentCount 超出 Meta 分配即解析崩溃
    # （表现：动作全部无法播放）。故单关键帧曲线一律表达为 stepped 段铺满时长。
    stop_time = getattr(mc, "m_StopTime", 0.0) or 0.0
    key_max_t = max(
        (
            ks[-1][0]
            for ks in list(streamed_keys.values()) + list(dense_keys.values())
            if ks
        ),
        default=0.0,
    )
    clip_dur = max(key_max_t, stop_time)

    curves = []
    for i in sorted(curve_meta):
        name, target = curve_meta[i]
        keys = streamed_keys.get(i) or constant_keys.get(i) or dense_keys.get(i)
        if not keys:
            continue
        keys.sort(key=lambda k: k[0])
        segs = [keys[0][0], keys[0][1]]
        if len(keys) == 1:
            # 单关键帧 = 常量：stepped 段铺满动作时长（clip_dur=0 的极端场合
            # 才退化为裸单点）
            if clip_dur > keys[0][0]:
                segs += [2, clip_dur, keys[0][1]]
        for k0, k1 in zip(keys, keys[1:]):
            t0, v0, out0, _in0 = k0
            t1, v1, _o, in1 = k1
            dt = t1 - t0
            if dt <= 0:
                continue
            if math.isinf(in1):  # stepped
                segs += [2, t1, v1]
            else:
                c1t, c1v = t0 + dt / 3.0, v0 + out0 * dt / 3.0
                c2t, c2v = t1 - dt / 3.0, v1 - in1 * dt / 3.0
                # Cubism 段类型: 0=Linear 1=Bezier 2=Stepped 3=InverseStepped
                segs += [1, c1t, c1v, c2t, c2v, t1, v1]
        curves.append({"Id": name, "Target": target, "Segments": segs})

    if unresolved:
        print(f"[warn] {clip.m_Name}: {unresolved} 条绑定路径哈希未解析，曲线被跳过")
    for h, n in unknown_attr.items():
        print(f"[warn] {clip.m_Name}: {n} 条未知 attribute 0x{h:08x}，曲线被跳过")

    duration = max(
        (max(c["Segments"][0], c["Segments"][-2]) for c in curves), default=0.0
    )
    if duration_hint:
        duration = max(duration, duration_hint)
    return curves, duration


def motion3_json(curves, duration, loop):
    # 段消耗: Linear=3 值, Bezier=7 值, Stepped/InverseStepped=3 值
    # 点数: 每段 1 个点, 贝塞尔额外含 2 个控制点 (共 3)
    total_seg = total_pt = 0
    for c in curves:
        segs = c["Segments"]
        i = 2
        while i < len(segs):
            typ = int(segs[i])
            i += {0: 3, 1: 7, 2: 3, 3: 3}.get(typ, 3)
            total_seg += 1
            total_pt += 3 if typ == 1 else 1
        total_pt += 1  # 曲线首点
    return {
        "Version": 3,
        "Meta": {
            "Duration": round(duration, 6),
            "Fps": 30.0,
            "Loop": loop,
            "CurveCount": len(curves),
            "TotalSegmentCount": total_seg,
            "TotalPointCount": total_pt,
            "Curves": [
                {"Id": c["Id"], "Segments": c["Segments"], "Target": c["Target"]}
                for c in curves
            ],
        },
        "Curves": curves,
    }


def clip_events(clip) -> list:
    """AnimationEvent 列表 -> [{time, function, int}]。

    游戏交互状态机的载体之一：OnAnimEvent(0) 在动作开头触发（配音/语音钩子），
    OnFinishAnim(N) 在动作结尾上报状态编号（N 与动作一一对应：2=main_1、
    3=main_2、4=main_3、5=complete、6=login、7=home、8=mail、9=mission、
    10=mission_complete、11=wedding、12=touch_head、13=touch_body、
    14=touch_special；0=touch_idle*/touch_drag 类反应）。游戏控制器据此决定
    动作结束后回到哪个状态。
    """
    return [
        {"time": round(e.time, 3), "function": e.functionName, "int": e.intParameter}
        for e in clip.m_Events
    ]


def _default_switch_like(rng) -> bool:
    """moc 默认值贴 0/±1 的参数才可能是开关。默认值落在量程中间（如氛围球
    MB_fenweiqiu* 的 0.7）说明参数是连续量旋钮：某支动作的边界值恰好等于 1
    （常值 1 的曲线更会整条过 _all_switch_like）不改变其性质，误判成开关会
    造出"自己要求自己产出"的死锁门控——touch_special 以 fenweiqiu4/5=1 起
    播且自己是唯一 end=1 的动作，节点从 moc 默认 0.7 起步永无对上 1 的机会，
    分支从 t0 起被 canPlay 拦死。rng 为 None（量程缺失）时退回旧行为。"""
    if rng is None:
        return True
    d = rng.get("default")
    if d is None:
        return True
    return min(abs(d), abs(d - 1.0), abs(d + 1.0)) <= 0.02


def _all_switch_like(values: list) -> bool:
    """图层/道具开关型参数：全部采样值都贴着 0/1/-1。
    连续 pose 参数（视线、嘴形等）取值虽也在 [-1,1]，但中间值会落选。"""
    for v in values:
        if min(abs(v), abs(v - 1.0), abs(v + 1.0)) > 0.02:
            return False
    return True


def _boundary_switch_like(values: list, rng) -> bool:
    """带弹性过冲的开关曲线：首末采样贴 0/±1，全程不越出 moc 量程
    （容差 0.05），且量程宽度 ≤1.25。

    典型如 uicaidan（菜单 UI 开关，量程 [0,1.1]）：摊开动画带 0.32/1.1
    的过冲中间值，_all_switch_like 会整条落选，导致该开关不进状态表——
    运行时复位会把摊开的菜单抹掉、分支门控也失去这项前置状态。
    量程宽度是反向保险：姿态移动件（ParamAngleZ ±30、jianX ±10 等）
    即便首末值恰好贴 0/±1 也不得入选，否则会被拿去做点击门控。
    """
    if rng is None or rng["max"] - rng["min"] > 1.25:
        return False
    if min(abs(values[0]), abs(values[0] - 1.0), abs(values[0] + 1.0)) > 0.02:
        return False
    if min(abs(values[-1]), abs(values[-1] - 1.0), abs(values[-1] + 1.0)) > 0.02:
        return False
    return all(rng["min"] - 0.05 <= v <= rng["max"] + 0.05 for v in values)


def clip_boundary_state(clip, path_hash, ranges=None) -> tuple[dict, dict]:
    """每支动作的首/末参数值，供还原跨动作交互状态。返回 (state, carry)：

    - state（开关型）：游戏不在动作间复位参数，touch_idle1 结束时 caidan=1
      （菜单摊开）、dianjikyc=1（菜单可点），该状态跨动作持续；
      touch_idle2/4/7 以 caidan=1 起播（菜单摊开时的分支动作）。由此可推出
      "打开器/分支"的点击门控协议。
    - carry（连续型）：菜单摊开同时位移整个场景（touch_idle1 结束时
      All_X=2.34，idle1 变体不复写该参数），位移量是姿态状态的一部分，
      复位会当场回正。凡首/末值非零的连续参数一律落盘，运行时按"结束值
      即当前状态"跨动作保留；收尾分支把它带回 0 时同样落盘，节点随之清零。
      ranges 是 moc3 参数量程（pid -> min/max），供 _boundary_switch_like
      识别带过冲的开关曲线；缺省时只走严格判据。
    """
    mc = clip.m_MuscleClip
    cd = mc.m_Clip.data
    bindings = clip.m_ClipBindingConstant.genericBindings

    # 逐绑定收集全部采样值与首/末值
    series = {}  # 绑定序号 -> [(t, v)]
    if cd.m_StreamedClip.data:
        for frame in StreamedClip(cd).read_data():
            if frame.time < -1e30:  # Unity 起始标记帧
                continue
            for key in frame.key_list:
                series.setdefault(key.index, []).append((frame.time, key.value))
    # constant 段与 convert_clip 同一解码：m_IndexArray 死字段，按绑定顺序
    # 隐式对位（第 k 项 = 第 k 个无 streamed/dense 数据的绑定）
    constant = cd.m_ConstantClip.data
    covered = set(series)
    dense = cd.m_DenseClip
    if dense.m_CurveCount > 0 and dense.m_SampleArray:
        covered.update(range(dense.m_CurveCount))
    k = 0
    for i in range(len(bindings)):
        if i in covered:
            continue
        if k < len(constant):
            series.setdefault(i, []).append((0.0, constant[k]))
        k += 1
    dense = cd.m_DenseClip
    if dense.m_CurveCount > 0 and dense.m_SampleArray:
        n = dense.m_CurveCount
        step = 1.0 / dense.m_SampleRate
        for i in range(min(n, len(bindings))):
            for s in range(len(dense.m_SampleArray) // n):
                series.setdefault(i, []).append(
                    (s * step + dense.m_BeginTime, dense.m_SampleArray[s * n + i])
                )

    state = {}
    carry = {}
    for i, pts in series.items():
        if i >= len(bindings):
            continue
        rel = path_hash.get(bindings[i].path)
        if rel is None:
            continue
        pts.sort()
        values = [v for _, v in pts]
        pid = rel.split("/")[-1]
        rng = ranges.get(pid) if ranges else None
        if _default_switch_like(rng) and (
            _all_switch_like(values) or _boundary_switch_like(values, rng)
        ):
            if pts[0][1] == 0.0 and pts[-1][1] == 0.0:
                continue  # 首末均为 0，不含边界信息
            state[pid] = [round(pts[0][1], 4), round(pts[-1][1], 4)]
        elif abs(pts[0][1]) > 1e-4 or abs(pts[-1][1]) > 1e-4:
            # 连续参数只要首/末残留非零就记：收尾动作把它带回 0 的（末=0 首
            # 非 0）也必须记，否则节点里的旧残留永远清不掉
            carry[pid] = [round(pts[0][1], 4), round(pts[-1][1], 4)]
    return state, carry


LOOP_GROUPS = {"idle"}  # 循环播放的动作组（login 播完一次后由运行时切回 idle）


def clip_group(name: str) -> str:
    if name.startswith("touch_idle"):
        return "touch_idle"
    if name.startswith("touch_drag"):
        return "touch_drag"
    if name.startswith("idle"):
        return "idle"
    return name


def animator_routing(env) -> dict | None:
    """解包 AnimatorController 的状态路由表（交互动作的播放入口）。

    游戏不直接 Play 动画，而是 C# 控制器对 Animator SetInteger + SetTrigger，
    经 AnyState 转移进入目标状态。转移条件只有三类参数：主 int（Equals）
    即"动作编号"，其值域与状态一一对应——1~19=系统动作（idle/main_*/login/
    home/mail/mission/wedding…）、101~110=touch_drag 系、201~221=touch_idle
    系；次 int 是 idle 变体号（主 int=1 时选中 idle_list.idle<N>）；触发器
    （If 条件）每次手势时置位。动作里嵌的 OnFinishAnim(N) 事件即结束时
    SetInteger(主 int, N)：系统动作 N=自身编号（自循环），触摸反应 N=0
    （无状态匹配，回落默认 idle）——这正是交互状态机"播完落节点"的数据源。

    状态→clip 对应与动作编号只存在于本序列化数据，是"状态编号 -> 动作"
    的权威表。某皮肤未携带某状态的动作时该状态为空跳板（进入后保持当前
    姿态），实际行为由游戏 C# 决定（如 TouchDrag 分区是否改映射到
    touch_idle 分支、或直接切换图层参数，均不在 bundle 数据内）。

    产物结构：
        paramKinds: 条件参数哈希 -> "int"/"trigger"（mode 6=Equals, 1=If）
        states:     [{name, actionId, subIndex, clip}]，clip=null 表示该皮肤
                    未携带此动作
    """
    ctrl = None
    clip_names = {}
    for obj in env.objects:
        if obj.type.name == "AnimatorController":
            ctrl = obj.read_typetree()
        elif obj.type.name == "AnimationClip":
            clip_names[obj.path_id] = obj.read().m_Name
    if ctrl is None:
        return None
    tos = {h: n for h, n in ctrl["m_TOS"]}
    clip_refs = ctrl["m_AnimationClips"]

    entries = []  # (state_name, conditions[[hash,mode,threshold]...], clip)
    for sm in ctrl["m_Controller"]["m_StateMachineArray"]:
        smd = sm["data"] if "data" in sm else sm
        # AnyState 转移与状态按下标对位（m_DestinationState 即状态数组下标）
        any_trans = {
            t["data"]["m_DestinationState"]: t["data"]
            for t in smd.get("m_AnyStateTransitionConstantArray", [])
        }
        for i, st in enumerate(smd.get("m_StateConstantArray", [])):
            sd = st["data"] if "data" in st else st
            name = tos.get(sd.get("m_FullPathID"), f"state{i}").split(".")[-1]
            conds = []
            td = any_trans.get(i)
            if td:
                conds = [
                    [
                        c["data"]["m_EventID"],
                        c["data"]["m_ConditionMode"],
                        c["data"]["m_EventThreshold"],
                    ]
                    for c in td.get("m_ConditionConstantArray", [])
                ]
            clip = None
            for bti in sd.get("m_BlendTreeConstantIndexArray", []):
                if bti is None or bti < 0:
                    continue
                bt = sd["m_BlendTreeConstantArray"][bti]["data"]
                for node in bt.get("m_NodeArray", []):
                    cid = node["data"]["m_ClipID"]
                    if 0 <= cid < len(clip_refs):
                        pid = clip_refs[cid].get("m_PathID", 0)
                        clip = clip_names.get(pid)  # 外部引用/空动作解析为 null
            entries.append((name, conds, clip))

    # 主 int = 出现在 Equals 条件里最多的参数（每个状态一条编号）
    int_count = {}
    trigger_hashes = set()
    for _, conds, _ in entries:
        for h, mode, _ in conds:
            if mode == 6:
                int_count[h] = int_count.get(h, 0) + 1
            elif mode == 1:
                trigger_hashes.add(h)
    main_hash = max(int_count, key=int_count.get) if int_count else None

    states = []
    for name, conds, clip in entries:
        action_id = sub_index = None
        for h, mode, thr in conds:
            if mode != 6:
                continue
            if h == main_hash:
                action_id = int(thr)
            else:
                sub_index = int(thr)
        states.append(
            {"name": name, "actionId": action_id, "subIndex": sub_index, "clip": clip}
        )
    states.sort(
        key=lambda s: (
            s["actionId"] is None,
            s["actionId"] or 0,
            s["subIndex"] is None,
            s["subIndex"] or 0,
        )
    )
    param_kinds = {
        str(h): ("trigger" if h in trigger_hashes else "int")
        for h in set(int_count) | trigger_hashes
    }
    return {"paramKinds": param_kinds, "states": states}


LUA_ENTRY_RE = re.compile(r"^\tpg\.base\.ship_l2d\[(\d+)\] = \{$", re.MULTILINE)
LUA_TEMPLATE_RE = re.compile(
    r"^_G\.pg\.base\.ship_skin_template\[(\d+)\] = \{$", re.MULTILINE
)
LUA_IDENT_RE = re.compile(r"[A-Za-z_]\w*")


class _LuaParser:
    """解析社区快照中的规范 Lua 表。"""

    def __init__(self, text: str):
        self.text = text
        self.pos = 0

    def parse(self):
        return self._value()

    def _skip(self):
        while self.pos < len(self.text) and self.text[self.pos] in " \t\r\n":
            self.pos += 1

    def _value(self):
        self._skip()
        char = self.text[self.pos]
        if char == "{":
            return self._table()
        if char == '"':
            end = self.text.index('"', self.pos + 1)
            value = self.text[self.pos + 1 : end]
            self.pos = end + 1
            return value
        number = re.match(r"[-+0-9.eE]+", self.text[self.pos :])
        if number:
            value = number.group(0)
            self.pos += len(value)
            return float(value) if "." in value or "e" in value.lower() else int(value)
        for word, value in (("true", True), ("false", False), ("nil", None)):
            if self.text.startswith(word, self.pos):
                self.pos += len(word)
                return value
        raise ValueError(f"无法解析 Lua 值: {self.text[self.pos : self.pos + 40]!r}")

    def _table(self):
        self.pos += 1
        table, array = {}, []
        while True:
            self._skip()
            if self.pos >= len(self.text):
                raise ValueError("Lua 表在闭合前结束")
            if self.text[self.pos] == "}":
                self.pos += 1
                return array if array else table
            ident = LUA_IDENT_RE.match(self.text, self.pos)
            if ident:
                save = self.pos
                self.pos = ident.end()
                self._skip()
                if self.pos < len(self.text) and self.text[self.pos] == "=":
                    self.pos += 1
                    table[ident.group(0)] = self._value()
                    self._comma()
                    continue
                self.pos = save
            array.append(self._value())
            self._comma()

    def _comma(self):
        self._skip()
        if self.pos < len(self.text) and self.text[self.pos] == ",":
            self.pos += 1


def _lua_block(text: str, matches: list, index: int) -> dict:
    end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
    return _LuaParser("{" + text[matches[index].end() : end]).parse()


def _read_skin_template(text: str, skin_id: int) -> dict:
    matches = list(LUA_TEMPLATE_RE.finditer(text))
    for index, match in enumerate(matches):
        if int(match.group(1)) == skin_id:
            return _lua_block(text, matches, index)
    raise ValueError(f"ship_skin_template 中没有皮肤 {skin_id}")


def _read_template_by_painting(text: str, painting: str) -> dict:
    matches = list(LUA_TEMPLATE_RE.finditer(text))
    for line in re.finditer(
        rf'^\tpainting = "{re.escape(painting)}",$', text, re.MULTILINE
    ):
        owners = [match for match in matches if match.start() < line.start()]
        if owners:
            owner = owners[-1]
            return _lua_block(text, matches, matches.index(owner))
    raise ValueError(f"ship_skin_template 中没有 painting {painting}")


def _parse_ship_l2d(text: str, skin_id: int) -> list:
    matches = list(LUA_ENTRY_RE.finditer(text))
    entries = []
    for index, match in enumerate(matches):
        key = int(match.group(1))
        if key // 100 == skin_id:
            entries.append({"key": key, **_lua_block(text, matches, index)})
    return entries


def _idle_index(model_dir: Path) -> dict:
    path = model_dir / f"{model_dir.name}.interaction.json"
    if not path.exists():
        return {}
    states = (
        json.loads(path.read_text(encoding="utf-8"))
        .get("animator", {})
        .get("states", [])
    )
    return dict(
        sorted(
            (state["subIndex"], state["clip"])
            for state in states
            if state.get("actionId") == 1 and state.get("clip")
        )
    )


def bake_l2d(model_dir: Path, model_id: str, server: str, skin_ref: str) -> bool:
    """把本地 Lua 快照烘焙为模型目录内的 l2d.json。"""
    lua_root = ROOT / ".tmp" / "lua" / server
    lua_path = lua_root / "sharecfg" / "ship_l2d.lua"
    template_path = lua_root / "sharecfgdata" / "ship_skin_template.lua"
    if not lua_path.exists() or not template_path.exists():
        print(f"[warn] Lua 快照不存在，跳过 l2d.json（服务器: {server}）")
        return False

    template_text = template_path.read_text(encoding="utf-8")
    if skin_ref.isdigit():
        skin_id = int(skin_ref)
        template = _read_skin_template(template_text, skin_id)
        painting = template["painting"]
    else:
        painting = skin_ref
        template = _read_template_by_painting(template_text, painting)
        skin_id = int(template["id"])

    l2d_ids = template.get("ship_l2d_id")
    if not isinstance(l2d_ids, list) or not l2d_ids:
        print(f"[warn] 皮肤 {skin_id}（{painting}）没有 ship_l2d_id，跳过 l2d.json")
        return False
    by_key = {
        entry["key"]: entry
        for entry in _parse_ship_l2d(lua_path.read_text(encoding="utf-8"), skin_id)
    }
    missing = [key for key in l2d_ids if key not in by_key]
    if missing:
        raise ValueError(f"ship_l2d.lua 缺少条目: {missing}")

    product = {
        "skin_id": skin_id,
        "name": template.get("name"),
        "ship_group": template.get("ship_group"),
        "live2d_offset": template.get("live2d_offset"),
        "idle_index": _idle_index(model_dir),
        "entries": [by_key[key] for key in l2d_ids],
    }
    dest = model_dir / f"{model_id}.l2d.json"
    dest.write_text(json.dumps(product, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  l2d: {dest}（{len(product['entries'])} 台机器）")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="提取并重组碧蓝航线 Live2D 皮肤")
    parser.add_argument("source", help="skin_id、painting 名或 bundle 路径")
    parser.add_argument("out_dir", nargs="?", help="兼容旧用法：显式输出目录")
    parser.add_argument("--server", default="CN", help="Lua 快照服务器目录（默认 CN）")
    parser.add_argument("--painting", help="显式指定 Lua 模板 painting 名")
    parser.add_argument("--no-lua", action="store_true", help="跳过 ship_l2d 配置烘焙")
    args = parser.parse_args()

    # 只传 skin_id/painting 时 bundle 与输出目录按固定约定推导；传完整路径则沿用旧用法。
    bundle = Path(args.source)
    if not bundle.is_file():
        bundle = BUNDLE_DIR / args.source
    model_id = bundle.stem  # 如 fulici_2
    if args.out_dir:
        out_dir = Path(args.out_dir)
    else:
        out_dir = MODEL_ROOT / char_name(model_id) / model_id
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "textures").mkdir(exist_ok=True)
    (out_dir / "motions").mkdir(exist_ok=True)

    env = UnityPy.load(str(bundle))

    scripts, path_hash, infos = resolve_hash_bindings(env)
    go_names = {}
    for obj in env.objects:
        if obj.type.name == "GameObject":
            go_names[obj.path_id] = obj.read().m_Name

    # --- moc3 / 贴图 / physics / Live2dChar（同时收集全量 inventory 记录）
    textures, text_assets, moc_bytes = [], {}, None
    live2d_char = None
    raycastables = []
    param_names = []
    mono_records = []  # inventory: 全部 MonoBehaviour (path_id, 脚本类名, typetree)
    params_ui = {}  # CubismParameter _unmanagedIndex -> 参数 id（GO 名即参数 id）
    for obj in env.objects:
        tname = obj.type.name
        if tname == "Texture2D":
            d = obj.read()
            img = d.image
            p = out_dir / "textures" / f"{d.m_Name}.png"
            img.save(p)
            textures.append(d.m_Name)
        elif tname == "TextAsset":
            d = obj.read()
            raw = d.m_Script
            # 统一存原始字节，落盘时按可否严格解码决定 .json/.bin，保证无损
            if isinstance(raw, str):
                raw = raw.encode("utf-8", "surrogateescape")
            text_assets[d.m_Name] = raw
        elif tname == "MonoBehaviour":
            try:
                tree = obj.read_typetree()
            except Exception as e:  # typetree 缺失/解析失败，inventory 记录原因
                mono_records.append({"path_id": obj.path_id, "error": str(e)})
                continue
            cls = scripts.get(tree.get("m_Script", {}).get("m_PathID"))
            mono_records.append({"path_id": obj.path_id, "script": cls, "tree": tree})
            if cls == "CubismMoc" and moc_bytes is None:
                moc_bytes = bytes(tree["_bytes"])
            elif cls == "Live2dChar" and live2d_char is None:
                live2d_char = {k: v for k, v in tree.items() if not k.startswith("m_")}
            elif cls == "CubismRaycastable":
                gid = tree["m_GameObject"]["m_PathID"]
                raycastables.append(go_names.get(gid, f"mesh_{obj.path_id}"))
            elif cls == "CubismDisplayInfoParameterName":
                param_names.append(tree.get("m_Name"))
            elif cls == "CubismParameter":
                gid = tree["m_GameObject"]["m_PathID"]
                pid = go_names.get(gid)
                if pid is not None:
                    params_ui[tree["_unmanagedIndex"]] = pid

    assert moc_bytes and moc_bytes[:4] == b"MOC3", "未找到 CubismMoc 数据"
    (out_dir / f"{model_id}.moc3").write_bytes(moc_bytes)

    # --- moc3 参数默认值/min/max（逆向状态机的初始态 = 默认态）
    tables = moc3_param_tables(moc_bytes, max(params_ui) + 1) if params_ui else None
    if tables:
        maxs, mins, defs = tables
        defaults = {
            params_ui[i]: {"default": defs[i], "min": mins[i], "max": maxs[i]}
            for i in sorted(params_ui)
        }
        (out_dir / f"{model_id}.defaults.json").write_text(
            json.dumps(defaults, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    else:
        print("[warn] moc3 参数表(min/max/defaults)解析失败，跳过 defaults.json")
    param_ranges = defaults if tables else None

    for name, raw in text_assets.items():
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            (out_dir / f"{name}.bin").write_bytes(raw)  # 非 UTF-8 资产存原始字节
            continue
        (out_dir / f"{name}.json").write_text(text, encoding="utf-8")

    if live2d_char:
        (out_dir / f"{model_id}.char.json").write_text(
            json.dumps(live2d_char, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    # --- 动画
    motion_groups = {}
    interaction_clips = {}
    inv_clips = []  # inventory: 每个 AnimationClip 的事件与原始绑定
    for obj in env.objects:
        if obj.type.name != "AnimationClip":
            continue
        clip = obj.read()
        bindings = clip.m_ClipBindingConstant.genericBindings
        curves, duration = convert_clip(clip, bindings, path_hash)
        # 交互状态机数据：AnimationEvent + 开关型/连续型参数的首末值（见函数注释）
        events = clip_events(clip)
        boundary, carry = clip_boundary_state(clip, path_hash, param_ranges)
        inv_clips.append(
            {
                "name": clip.m_Name,
                "events": events,
                "bindings": [
                    {"path": b.path, "attribute": b.attribute, "typeID": b.typeID}
                    for b in bindings
                ],
            }
        )
        if events or boundary or carry:
            interaction_clips[clip.m_Name] = {
                "duration": round(duration, 3),
                "events": events,
                "state": boundary,
                "carry": carry,
            }
        if not curves:
            print(f"[warn] {clip.m_Name}: 无可解析曲线")
            continue
        group = clip_group(clip.m_Name)
        loop = group in LOOP_GROUPS
        data = motion3_json(curves, duration, loop)
        (out_dir / "motions" / f"{clip.m_Name}.motion3.json").write_text(
            json.dumps(data, ensure_ascii=False), encoding="utf-8"
        )
        motion_groups.setdefault(group, []).append(
            {"File": f"motions/{clip.m_Name}.motion3.json"}
        )

    # --- model3.json
    # Raycastable 网格名即原版点击分区 (TouchHead/TouchBody/TouchIdle3/...),
    # 加下划线、保留序号后作为命中区名 = 对应动作文件名 (TouchIdle3 -> touch_idle3):
    # 分区与动作一一对应, 点哪个部位播哪支; 不能剥掉序号归组, 否则同名命中区
    # 在 pixi-live2d-display 里会互相覆盖, 且无法定位到具体动作
    def hit_area_name(mesh: str) -> str:
        name = mesh.lower()
        return f"touch_{name[5:]}" if name.startswith("touch") else name

    hit_areas = [{"Id": mesh, "Name": hit_area_name(mesh)} for mesh in raycastables]

    model3 = {
        "Version": 3,
        "FileReferences": {
            "Moc": f"{model_id}.moc3",
            "Textures": [f"textures/{n}.png" for n in sorted(textures)],
            "Physics": (
                f"{model_id}.physics3.json"
                if f"{model_id}.physics3" in text_assets
                else None
            ),
            "Motions": motion_groups,
        },
        "HitAreas": hit_areas,
    }
    model3["FileReferences"] = {
        k: v for k, v in model3["FileReferences"].items() if v is not None
    }
    (out_dir / f"{model_id}.model3.json").write_text(
        json.dumps(model3, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # --- 交互状态机数据（本项目扩展文件，标准运行时忽略）
    # clips: 每支动作的 AnimationEvent（OnAnimEvent/OnFinishAnim 状态编号）
    #        与开关型参数的首/末值（[起, 止]，跨动作持续的菜单/道具开关）。
    # animator: AnimatorController 状态路由表（状态 -> 动作编号 -> clip），
    #           OnFinishAnim(N) 即结束时回写的动作编号（见函数注释）。
    # 运行时据此实现：点击门控（仅菜单摊开时可点菜单分支）、跨动作保留
    # 状态参数、动作结束上报状态编号。
    interaction_data = {"clips": interaction_clips}
    routing = animator_routing(env)
    if routing:
        interaction_data["animator"] = routing
    else:
        print("[warn] 未找到 AnimatorController，跳过路由表")
    (out_dir / f"{model_id}.interaction.json").write_text(
        json.dumps(interaction_data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # --- bundle 全量参考数据（逆向用；CubismMoc._bytes 已是 .moc3 文件，剔除避免重复）
    for rec in mono_records:
        if rec["script"] == "CubismMoc":
            rec["tree"] = {k: v for k, v in rec["tree"].items() if k != "_bytes"}
    inventory = {
        "bundle": (
            bundle.relative_to(ROOT).as_posix()
            if bundle.is_relative_to(ROOT)
            else str(bundle)
        ),
        "objects": dict(
            sorted(
                (typ, sum(1 for o in env.objects if o.type.name == typ))
                for typ in {o.type.name for o in env.objects}
            )
        ),
        "gameobjects": {str(pid): name for pid, name in go_names.items()},
        "monobehaviours": mono_records,
        "animationclips": sorted(inv_clips, key=lambda c: c["name"]),
    }
    (out_dir / f"{model_id}.inventory.json").write_text(
        json.dumps(inventory, ensure_ascii=False), encoding="utf-8"
    )

    if not args.no_lua:
        skin_ref = args.painting
        if skin_ref is None:
            skin_ref = args.source if not Path(args.source).is_file() else model_id
        try:
            bake_l2d(out_dir, model_id, args.server, skin_ref)
        except (OSError, ValueError, KeyError) as exc:
            print(f"[warn] l2d.json 烘焙失败，基础模型已完成: {exc}")

    print(f"完成: {model_id}")
    print(
        f"  贴图 {len(textures)}, 动作组 "
        f"{ {k: len(v) for k, v in motion_groups.items()} }"
    )
    print(f"  Live2dChar: {json.dumps(live2d_char, ensure_ascii=False)[:200]}")


if __name__ == "__main__":
    main()
