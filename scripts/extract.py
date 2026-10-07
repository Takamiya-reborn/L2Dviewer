"""碧蓝航线 Live2D 皮肤提取器：UnityFS bundle -> 标准 Cubism 4 模型。

用法:
    uv run scripts/extract.py <skin_id>     # 如 fulici_2
    uv run scripts/extract.py <bundle_path> <out_dir>   # 兼容旧用法

产物 (out_dir) —— 一次提取即完整模型资源，逆向无需再回头 dump:

    <id>.moc3 / <id>.model3.json / <id>.physics3.json / <id>.char.json
    <id>.interaction.json
    <id>.defaults.json      参数默认值/min/max（解析自 moc3 二进制，见下）
    <id>.inventory.json     bundle 全量参考：GameObject 表、全部组件 typetree
                            （CubismMoc._bytes 除外——.moc3 文件本身已落盘）、
                            AnimationClip 事件与绑定
    textures/texture_XX.png
    motions/<clip_name>.motion3.json

原理 (见 azurlane.md):
    - CubismMoc._bytes 直接是 moc3 二进制
    - 贴图 Texture2D (ASTC 由 UnityPy 转码) -> PNG
    - TextAsset *.physics3 为 JSON 原文（非 UTF-8 的 TextAsset 落 .bin 原始字节）
    - Unity AnimationClip (streamed+constant 曲线, CRC32 哈希绑定) -> motion3.json
    - moc3 默认值：Cubism 4 (moc3 版本字节=4) 头部 0x40 起是节偏移表
      (递增 u32)；表[51]=参数 max、表[52]=min、表[53]=defaults，各为
      n_f32 数组、按 CubismParameter._unmanagedIndex 对位（字符串槽区
      顺序与此无关）。min<=default<=max 全程成立可作校验。
"""

import json
import math
import re
import struct
import sys
import zlib
from pathlib import Path

import UnityPy

# 固定路径约定：bundle 由 pull_bundles.py 拉到 .tmp/bundles/<skin_id>，
# 产物按 public/models/<角色>/<skin_id>/ 归档（前端 models.js 按此路径引用）
ROOT = Path(__file__).resolve().parents[1]
BUNDLE_DIR = ROOT / ".tmp" / "bundles"
MODEL_ROOT = ROOT / "public" / "models"


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

    # constant: m_IndexArray[绑定序号] -> constant.data 下标
    index_array = list(mc.m_IndexArray)
    constant_keys = {}
    for i, v in enumerate(index_array):
        if v >= 0 and v < len(constant) and i in curve_meta:
            constant_keys[i] = [(0.0, constant[v], 0.0, 0.0)]

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

    curves = []
    for i in sorted(curve_meta):
        name, target = curve_meta[i]
        keys = streamed_keys.get(i) or constant_keys.get(i) or dense_keys.get(i)
        if not keys:
            continue
        keys.sort(key=lambda k: k[0])
        segs = [keys[0][0], keys[0][1]]
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


def _all_switch_like(values: list) -> bool:
    """图层/道具开关型参数：全部采样值都贴着 0/1/-1。
    连续 pose 参数（视线、嘴形等）取值虽也在 [-1,1]，但中间值会落选。"""
    for v in values:
        if min(abs(v), abs(v - 1.0), abs(v + 1.0)) > 0.02:
            return False
    return True


def clip_boundary_state(clip, path_hash) -> dict:
    """每支动作的首/末参数值（仅开关型），供还原跨动作交互状态。

    游戏不在动作间复位参数：touch_idle1 结束时 caidan=1（菜单摊开）、
    dianjikyc=1（菜单可点），该状态跨动作持续；touch_idle2/4/7 以
    caidan=1 起播（菜单摊开时的分支动作）。由此可推出"打开器/分支"
    的点击门控协议。默认值不在 bundle 里（在 moc3），由运行时
    getParameterDefaultValue 比对。
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
    constant = cd.m_ConstantClip.data
    for i, v in enumerate(mc.m_IndexArray):
        if 0 <= v < len(constant):
            series.setdefault(i, []).append((0.0, constant[v]))
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
    for i, pts in series.items():
        if i >= len(bindings):
            continue
        rel = path_hash.get(bindings[i].path)
        if rel is None:
            continue
        pts.sort()
        values = [v for _, v in pts]
        if not _all_switch_like(values):
            continue
        pid = rel.split("/")[-1]
        if pts[0][1] == 0.0 and pts[-1][1] == 0.0:
            continue  # 首末均为 0，不含边界信息
        state[pid] = [round(pts[0][1], 4), round(pts[-1][1], 4)]
    return state


LOOP_GROUPS = {"idle"}  # 循环播放的动作组（login 播完一次后由运行时切回 idle）


def clip_group(name: str) -> str:
    if name.startswith("touch_idle"):
        return "touch_idle"
    if name.startswith("touch_drag"):
        return "touch_drag"
    if name.startswith("idle"):
        return "idle"
    return name


def main() -> None:
    # 只传 skin_id 时 bundle/输出目录按固定约定推导；传完整路径则沿用旧用法
    bundle = Path(sys.argv[1])
    if not bundle.is_file():
        bundle = BUNDLE_DIR / sys.argv[1]
    model_id = bundle.stem  # 如 fulici_2
    if len(sys.argv) > 2:
        out_dir = Path(sys.argv[2])
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
        # 交互状态机数据：AnimationEvent + 开关型参数的首末值（见函数注释）
        events = clip_events(clip)
        boundary = clip_boundary_state(clip, path_hash)
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
        if events or boundary:
            interaction_clips[clip.m_Name] = {
                "duration": round(duration, 3),
                "events": events,
                "state": boundary,
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
    # 运行时据此实现：点击门控（仅菜单摊开时可点菜单分支）、跨动作保留
    # 状态参数、动作结束上报状态编号。
    (out_dir / f"{model_id}.interaction.json").write_text(
        json.dumps({"clips": interaction_clips}, ensure_ascii=False, indent=2),
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

    print(f"完成: {model_id}")
    print(
        f"  贴图 {len(textures)}, 动作组 "
        f"{ {k: len(v) for k, v in motion_groups.items()} }"
    )
    print(f"  Live2dChar: {json.dumps(live2d_char, ensure_ascii=False)[:200]}")


if __name__ == "__main__":
    main()
