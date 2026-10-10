"""社区明文 Lua 快照拉取器：AzurLaneLuaScripts 仓库 -> .tmp/lua/<服务器>/。

用法（uv 与裸 python 二选一）:
    uv run scripts/pull_lua.py              # 拉取 CN 必需文件（extract.py 用）
    python scripts/pull_lua.py              # 同上，裸 python（仅标准库，无需装依赖）
    ... --server JP                         # 拉日本服务器（可逗号分隔多个：JP,KR）
    ... --all                               # 连同控制层参照文件一起拉（字段语义参照）
    ... --force                             # 本地已存在也重拉（默认跳过）

选项:
    --server LIST 服务器目录，可逗号分隔多个（默认 CN；可选 CN/EN/JP/KR/TW）
    --proxy [http://proxy:port] HTTP(S) 代理（默认读 HTTPS_PROXY 环境变量）

说明:
    - 文件清单即 docs/azurlane.md 记录的子集，各服务器目录结构一致
        - 落点固定在 .tmp/lua/（无路径参数）；extract.py 从同一位置读取
    - 上游仓库停更不影响快照有效性，拉一次即可
"""

import argparse
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / ".tmp" / "lua"

REPO = "AzurLaneTools/AzurLaneLuaScripts"
BRANCH = "main"
RAW = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}"

# 上游按服务器分目录，结构一致（CN/EN/JP/KR/TW）
SERVERS = ["CN", "EN", "JP", "KR", "TW"]

# 必需：extract.py 的直接输入（相对服务器目录）
REQUIRED = [
    "sharecfg/ship_l2d.lua",
    "sharecfgdata/ship_skin_template.lua",
]
# 参照：控制层，仅字段语义参考用（--all）
REFERENCE = [
    "view/ship/live2d.lua",
    "view/ship/live2dconst.lua",
    "view/ship/live2ddrag.lua",
    "view/ship/live2dextend.lua",
    "view/ship/live2dpainting.lua",
    "mgr/live2dmgr.lua",
]


def die(msg):
    print(f"错误: {msg}", file=sys.stderr)
    sys.exit(1)


def fetch(url, proxy):
    handlers = (
        [urllib.request.ProxyHandler({"http": proxy, "https": proxy})] if proxy else []
    )
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(url, headers={"User-Agent": "l2dviewer-pull_lua"})
    with opener.open(req, timeout=60) as r:
        return r.read()


def pull(rel, dest_root, proxy, force):
    dest = dest_root / rel
    if dest.exists() and not force:
        print(f"[skip] {rel}（已存在，--force 重拉）")
        return False
    data = fetch(f"{RAW}/{rel}", proxy)
    if not data:
        die(f"空响应: {rel}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    print(f"[ok]   {rel}（{len(data) / 1e6:.1f} MB）")
    return True


def main():
    ap = argparse.ArgumentParser(description="拉取社区明文 Lua 快照到 .tmp/lua/")
    ap.add_argument(
        "--server",
        default="CN",
        help="服务器目录，可逗号分隔多个（默认 CN；可选 " + "/".join(SERVERS) + "）",
    )
    ap.add_argument("--all", action="store_true", help="连同控制层参照文件一起拉")
    ap.add_argument("--force", action="store_true", help="已存在也重拉")
    ap.add_argument(
        "--proxy", default=None, help="HTTP(S) 代理 URL（也可设 HTTPS_PROXY 环境变量）"
    )
    args = ap.parse_args()

    servers = [s.strip().upper() for s in args.server.split(",")]
    bad = [s for s in servers if s not in SERVERS]
    if bad:
        die(f"未知服务器: {','.join(bad)}（可选 {'/'.join(SERVERS)}）")

    files = REQUIRED + (REFERENCE if args.all else [])
    ok = 0
    for srv in servers:
        print(f"目标: {DEST / srv}（{len(files)} 个文件）\n")
        for rel in files:
            try:
                ok += pull(f"{srv}/{rel}", DEST, args.proxy, args.force)
            except Exception as e:  # noqa: BLE001 — 单文件失败不中断整批
                print(f"[fail] {srv}/{rel}: {e}", file=sys.stderr)
        print()
    if ok == 0 and not args.force:
        print("全部已存在，无需更新。")
    print("完成，下一步: python scripts/extract.py <skin_id> [--server JP]")


if __name__ == "__main__":
    main()
