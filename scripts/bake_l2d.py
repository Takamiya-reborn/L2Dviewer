"""把游戏 Lua 的 ship_l2d 交互配置烘焙进模型目录（<id>.l2d.json）。

用法（uv 与裸 python 二选一）:
    uv run python -I scripts/bake_l2d.py fulici_2     # 按 painting 名烘焙
    python -I scripts/bake_l2d.py 407041              # 或直接用数字皮肤 id
    ... --server JP                                   # 换服务器快照
    ... --out <模型目录>                              # 显式指定输出目录

产物 <id>.l2d.json 落在模型目录内（与 interaction.json 等扩展文件同惯例，
目录自包含），内容:
    skin_id     数字皮肤 id
    name        游戏内皮肤名（ship_skin_template.name，查看器侧栏显示名）
    ship_group  舰船组 id（皮肤所属角色的 ship_group）
    entries     该皮肤的 ship_l2d 条目列表（顺序 = 游戏配置的 ship_l2d_id
                列表，即控制层的机器注册顺序），字段原样保留——未在本查看器
                实现的触发类型也全部带上，供后续扩展直接使用
    idle_index  {"0": "idle", "1": "idle1", ...} idle 变体号 -> 动作 clip 名
                （取自同目录 <id>.interaction.json 的 animator.states：
                actionId=1 的状态，subIndex 即变体号；motions.idle 组内顺序
                是 bundle 对象序，不能当下标用）

数据来历与字段语义见 azurlane.md 第 3 节；运行时消费方式见 src/utils/
dragmachine.js 头注。读取路径固定 .tmp/lua/<服务器>/，与 pull_lua.py 的
落点硬编码对齐，改动须同步。
"""

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from parse_ship_l2d import ROOT, lua_table_to_json, parse_skin

# ship_skin_template.lua 的条目块：`_G.pg.base.ship_skin_template[<id>] = {` 起，
# 到行首无缩进的 `}` 止（机器生成的规范格式）
TEMPLATE_RE = re.compile(
    r"^_G\.pg\.base\.ship_skin_template\[(\d+)\] = \{$", re.MULTILINE
)


def lua_path(server):
    return ROOT / ".tmp/lua" / server / "sharecfg/ship_l2d.lua"


def template_path(server):
    return ROOT / ".tmp/lua" / server / "sharecfgdata/ship_skin_template.lua"


def read_template(text: str, skin_id: int) -> dict:
    """取 ship_skin_template[skin_id] 条目块文本并解析为对象。"""
    matches = list(TEMPLATE_RE.finditer(text))
    for i, m in enumerate(matches):
        if int(m.group(1)) != skin_id:
            continue
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        return lua_table_to_json(text[start:end])
    raise SystemExit(f"ship_skin_template 中没有皮肤 {skin_id}")


def read_template_by_painting(text: str, painting: str) -> dict:
    """按 painting 名反查条目（先定位 `painting = "..."` 行，再回找所属块，
    避免全文件跑字符解析器）。"""
    lines = re.finditer(rf'^\tpainting = "{re.escape(painting)}",$', text, re.MULTILINE)
    hits = list(TEMPLATE_RE.finditer(text))
    for line in lines:
        owner = [m for m in hits if m.start() < line.start()]
        if not owner:
            continue
        m = owner[-1]
        i = hits.index(m)
        end = hits[i + 1].start() if i + 1 < len(hits) else len(text)
        return lua_table_to_json(text[m.end() : end])
    raise SystemExit(f"ship_skin_template 中没有 painting {painting}")


def char_dir_of(painting: str) -> str:
    """角色目录名 = painting 名去掉 _hx / _N 后缀（与 extract.py 落盘规则一致）。"""
    name = re.sub(r"_hx$", "", painting)
    name = re.sub(r"_\d+$", "", name)
    return name


def build_idle_index(model_dir: Path) -> dict:
    """从 interaction.json 的 Animator 路由表构建 idle 变体号 -> clip 名映射。

    游戏里 changeIdleIndex(N) 就是 Animator SetInteger("idle", N)，N 即
    actionId=1 状态的 subIndex；该皮肤未携带的变体（clip=null）不收录。
    """
    path = model_dir / f"{model_dir.name}.interaction.json"
    if not path.exists():
        print(f"[warn] {path} 不存在，idle_index 留空（重跑 extract.py 可得）")
        return {}
    states = (
        json.loads(path.read_text(encoding="utf-8"))
        .get("animator", {})
        .get("states", [])
    )
    index = {}
    for s in states:
        if s.get("actionId") == 1 and s.get("clip"):
            index[s["subIndex"]] = s["clip"]
    return dict(sorted(index.items()))


def main():
    ap = argparse.ArgumentParser(description="烘焙 ship_l2d 交互配置到模型目录")
    ap.add_argument("skin", help="painting 名（fulici_2）或数字皮肤 id（407041）")
    ap.add_argument(
        "--server", default="CN", help="服务器目录（默认 CN，需先 pull_lua.py）"
    )
    ap.add_argument(
        "--out",
        default=None,
        help="模型目录（默认 models/<角色>/<painting名>/）",
    )
    args = ap.parse_args()

    template_text = template_path(args.server).read_text(encoding="utf-8")
    if re.fullmatch(r"\d+", args.skin):
        skin_id = int(args.skin)
        entry = read_template(template_text, skin_id)
        painting = entry["painting"]
    else:
        entry = read_template_by_painting(template_text, args.skin)
        painting = args.skin
        skin_id = entry["id"]

    l2d_ids = entry.get("ship_l2d_id")
    if not l2d_ids or not isinstance(l2d_ids, list):
        raise SystemExit(f"皮肤 {skin_id}（{painting}）没有 ship_l2d_id，不是 L2D 皮肤")

    # 按游戏配置的注册顺序取条目（parse_skin 返回按键序，这里对齐 ship_l2d_id 序）
    by_key = {e["key"]: e for e in parse_skin(skin_id, args.server)}
    entries = []
    missing = [k for k in l2d_ids if k not in by_key]
    if missing:
        raise SystemExit(f"ship_l2d.lua 缺少条目: {missing}")
    entries = [by_key[k] for k in l2d_ids]

    out_dir = (
        Path(args.out)
        if args.out
        else ROOT / "models" / char_dir_of(painting) / painting
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    product = {
        "skin_id": skin_id,
        # 游戏内皮肤名（ship_skin_template.name）与舰船组 id，查看器侧栏
        # 显示名取 name；ship_group 留作按角色聚合/查角色名用
        "name": entry.get("name"),
        "ship_group": entry.get("ship_group"),
        # 母港摆位（live2dpainting.lua）：模型根节点=画布原点、恒定缩放 52，
        # localPosition = live2d_offset（UI 点，y 向上）。查看器按此复现取景，
        # 4 元素时 [3] 覆盖默认缩放
        "live2d_offset": entry.get("live2d_offset"),
        "idle_index": build_idle_index(out_dir),
        "entries": entries,
    }
    dest = out_dir / f"{painting}.l2d.json"
    dest.write_text(json.dumps(product, ensure_ascii=False, indent=2), encoding="utf-8")
    types = sorted(
        {
            (e.get("action_trigger") or {}).get("type")
            for e in entries
            if isinstance(e.get("action_trigger"), dict)
        }
    )
    print(f"[ok] {dest}")
    print(f"     皮肤 {skin_id}（{painting}），{len(entries)} 台机器，触发类型 {types}")
    print(f"     idle 变体: {product['idle_index']}")


if __name__ == "__main__":
    sys.exit(main())
