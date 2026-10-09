"""碧蓝航线 L2D 资源 adb 拉取器：设备 files/AssetBundles/live2d -> .tmp/bundles/。

用法（uv 与裸 python 二选一）:
    uv run scripts/pull_bundles.py <skin_id>...       # 按皮肤 id 拉取（_hx 为改造/婚变体）
    python scripts/pull_bundles.py <skin_id>...       # 同上，裸 python（仅标准库，无需装依赖）
    ... --all                                         # 拉取全部 bundle（先预览总量，需确认）
    ... --list [关键词]                               # 只列出远端 bundle（可按关键词过滤）
    ... --index                                       # 只更新 .tmp/ 下的索引缓存

选项:
    --host [host:port] 先 adb connect（模拟器地址）
    --serial ADDR   指定 adb -s 设备（多设备时用）
    --package PKG   手动指定游戏包名（默认从 pm list packages 里自动匹配 azurlane）
    --dest DIR      bundle 落盘目录（默认 .tmp/bundles/）
    --force         本地已存在也重拉（默认大小一致即跳过，可断点续传）

说明:
    - 索引文件 hashes-live2d.csv / version-live2d.txt 随任何拉取动作一并更新到
      .tmp/（--list 除外），其他资源类别（语音、立绘等）同构清单换 --package 外的
            类别名不在本脚本范围，按 docs/azurlane.md 手动 pull 即可
    - 从 Python subprocess 调 adb 无 MSYS 路径转换问题，不需要 Git Bash 的 `//` 前缀
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ADB = ROOT / "tools" / "adb" / "adb.exe"

REMOTE_FILES_DIR = "files/AssetBundles/live2d"
INDEX_FILES = ("hashes-live2d.csv", "version-live2d.txt")

# ls -l 行：权限 开头，倒数第 3/4 列附近是大小与日期；用日期 token 定位大小
LSL_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def adb(*args, serial=None):
    cmd = [str(ADB)]
    if serial:
        cmd += ["-s", serial]
    cmd += list(args)
    r = subprocess.run(cmd, capture_output=True, text=False)
    out = r.stdout.decode("utf-8", "replace")
    err = r.stderr.decode("utf-8", "replace")
    if r.returncode != 0:
        die(f"adb {' '.join(args)} 失败:\n{err.strip() or out.strip()}")
    return out


def die(msg):
    print(f"错误: {msg}", file=sys.stderr)
    sys.exit(1)


def remote_size(adb_out_lsl_line):
    """从 `ls -l` 一行解析字节大小，解析失败返回 None。"""
    tokens = adb_out_lsl_line.split()
    for i, tok in enumerate(tokens):
        if LSL_DATE.fullmatch(tok) and i >= 1:
            return int(tokens[i - 1]) if tokens[i - 1].isdigit() else None
    return None


def list_remote_bundles(serial, package, keyword=None):
    """返回 [(name, size_bytes_or_None)]。"""
    remote = f"/sdcard/Android/data/{package}/{REMOTE_FILES_DIR}"
    out = adb("shell", "ls", "-l", remote, serial=serial)
    bundles = []
    for line in out.replace("\r", "").splitlines():
        name = line.split()[-1] if line.split() else ""
        if not name or name.startswith("total"):
            continue
        if keyword and keyword.lower() not in name.lower():
            continue
        bundles.append((name, remote_size(line)))
    return bundles


def detect_package(serial, override=None):
    if override:
        return override
    out = adb("shell", "pm", "list", "packages", serial=serial)
    pkgs = [
        ln.split(":", 1)[1]
        for ln in out.replace("\r", "").splitlines()
        if ln.startswith("package:") and "azurlane" in ln.lower()
    ]
    if not pkgs:
        die("未在 pm list packages 中找到 azurlane 相关包名，请用 --package 手动指定")
    if len(pkgs) > 1:
        die(f"找到多个候选包名 {pkgs}，请用 --package 指定其一")
    return pkgs[0]


def pull_one(remote, local, serial):
    adb("pull", remote, str(local), serial=serial)


def sync_index(serial, package, tmp):
    for name in INDEX_FILES:
        local = tmp / name
        try:
            pull_one(f"/sdcard/Android/data/{package}/files/{name}", local, serial)
            print(f"索引 {name} -> {local}")
        except SystemExit:
            print(
                f"警告: 索引 {name} 拉取失败（可能设备上不存在），跳过", file=sys.stderr
            )


def main():
    ap = argparse.ArgumentParser(
        description="碧蓝航线 L2D 资源 adb 拉取器（详见文件头 docstring）",
        epilog="示例: uv run scripts/pull_bundles.py <skin_id>... --host [host:port]",
    )
    ap.add_argument("skin_ids", nargs="*", help="皮肤 id（即远端 bundle 文件名）")
    ap.add_argument("--all", action="store_true", help="拉取全部 bundle")
    ap.add_argument(
        "--list",
        nargs="?",
        const="",
        default=None,
        metavar="关键词",
        help="只列出远端 bundle，可选关键词过滤",
    )
    ap.add_argument("--index", action="store_true", help="只更新索引缓存，不拉 bundle")
    ap.add_argument("--host", help="先 adb connect 到该地址")
    ap.add_argument("--serial", help="adb -s 指定设备")
    ap.add_argument("--package", help="游戏包名（默认自动匹配 azurlane）")
    ap.add_argument(
        "--dest", default=str(ROOT / ".tmp" / "bundles"), help="bundle 落盘目录"
    )
    ap.add_argument("--force", action="store_true", help="已存在也重拉")
    args = ap.parse_args()

    if not ADB.exists():
        die(f"未找到 {ADB}")
    if args.host:
        print(adb("connect", args.host, serial=args.serial).strip())
    if not any([args.skin_ids, args.all, args.list is not None, args.index]):
        ap.error("需要皮肤 id 或 --all / --list / --index 之一")

    package = detect_package(args.serial, args.package)
    print(f"包名: {package}")

    tmp = ROOT / ".tmp"
    tmp.mkdir(exist_ok=True)
    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)

    if args.list is not None:
        bundles = list_remote_bundles(args.serial, package, args.list or None)
        for name, size in bundles:
            print(f"{size:>12}  {name}" if size is not None else f"{'?':>12}  {name}")
        print(f"-- 共 {len(bundles)} 个", file=sys.stderr)
        return

    if not args.index:
        bundles = list_remote_bundles(args.serial, package)
        by_name = dict(bundles)
        if args.all:
            targets = sorted(by_name)
            total = sum(s or 0 for _, s in bundles)
            print(f"远端共 {len(targets)} 个 bundle，合计 {total / 1e6:.1f} MB")
            if total > 100e6 and input("确认全部拉取? [y/N] ").strip().lower() != "y":
                die("已取消")
        else:
            missing = [n for n in args.skin_ids if n not in by_name]
            if missing:
                die(f"远端不存在: {missing}（用 --list 查看可用皮肤 id）")
            targets = args.skin_ids

        ok = fail = skip = 0
        for name in targets:
            local = dest / name
            rsize = by_name.get(name)
            if (
                not args.force
                and local.exists()
                and (rsize is None or local.stat().st_size == rsize)
            ):
                skip += 1
                continue
            try:
                pull_one(
                    f"/sdcard/Android/data/{package}/{REMOTE_FILES_DIR}/{name}",
                    local,
                    args.serial,
                )
                ok += 1
                print(f"拉取 {name} ({local.stat().st_size / 1e6:.1f} MB)")
            except SystemExit:
                fail += 1
                print(f"失败 {name}", file=sys.stderr)
        print(f"完成: 拉取 {ok}，跳过 {skip}，失败 {fail} -> {dest}")

    sync_index(args.serial, package, tmp)


if __name__ == "__main__":
    main()
