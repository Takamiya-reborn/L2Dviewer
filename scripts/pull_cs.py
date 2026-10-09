"""APK -> il2cpp 二进制 + global-metadata.dat 拉取器，并调用 Il2CppDumper。

用法（uv 与裸 python 二选一）:
    python scripts/pull_cs.py                  # 全流程：连设备拉 APK -> 提取 -> dump
    ... --host [host:port]                     # 先 adb connect（模拟器地址）
    ... --serial emulator-5556                 # 多设备时指定
    ... --extract-only D:/path/to/base.apk     # 只从本地 APK 提取（不连设备）
    ... --dump-only                            # 跳过拉取/提取，只重跑 dump
    ... --rm-apk                               # 提取成功后删除 APK（默认保留）

产物 .tmp/cs/:
    apk/base.apk（或 split 各分片）   设备原包
    libil2cpp.so                      il2cpp 原生库（arm64 优先，armv7 兜底）
    global-metadata.dat               il2cpp 元数据（与 so 必须同包同版本）
    dump/dump.cs                      C# 全量签名（类/字段/方法/偏移），逆向入口
    dump/script.json / stringliteral.json 等

说明:
    - Lua 控制层（.tmp/lua）之外的另一半真相在 C# 层：Live2dChar 的命中检测
      （GetDragPart）、参数叠加（AddParameterValue/ChangeParameterData）等都在
      dump.cs 里查签名，函数体按需小窗口反汇编（勿全量扫描）
    - Il2CppDumper 的 RequireAnyKey 会阻塞无头调用，跑 dump 前临时改写
      tools/Il2CppDumper/config.json、结束后还原
    - 包名自动匹配 pm list packages 里的 azurlane；split APK（base + 各 split）
      会逐个提取，需要的两个文件通常在 base 里
"""

import argparse
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ADB = ROOT / "tools" / "adb" / "adb.exe"
DUMPER = ROOT / "tools" / "Il2CppDumper" / "Il2CppDumper.exe"
DUMPER_CONFIG = ROOT / "tools" / "Il2CppDumper" / "config.json"

DEST = ROOT / ".tmp" / "cs"
APK_DIR = DEST / "apk"

# APK 内的目标条目：libil2cpp.so 架构按优先级取第一个命中的
SO_CANDIDATES = ["arm64-v8a", "armeabi-v7a"]
SO_NAME = "libil2cpp.so"
METADATA = "assets/bin/Data/Managed/Metadata/global-metadata.dat"


def die(msg):
    print(f"错误: {msg}", file=sys.stderr)
    sys.exit(1)


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


def find_package(serial):
    out = adb("shell", "pm", "list", "packages", serial=serial)
    hits = [
        line.split(":", 1)[1].strip()
        for line in out.replace("\r", "").splitlines()
        if line.startswith("package:") and "azurlane" in line.lower()
    ]
    if not hits:
        die("pm list packages 里没找到 azurlane 包（--serial 换设备或手动确认包名）")
    if len(hits) > 1:
        print(f"[warn] 匹配到多个包 {hits}，取第一个")
    return hits[0]


def pull_apks(serial, package):
    out = adb("shell", "pm", "path", package, serial=serial)
    paths = [
        line.split(":", 1)[1].strip()
        for line in out.replace("\r", "").splitlines()
        if line.startswith("package:")
    ]
    if not paths:
        die(f"pm path {package} 为空")
    APK_DIR.mkdir(parents=True, exist_ok=True)
    pulled = []
    for i, remote in enumerate(paths):
        name = Path(remote).name or f"split{i}.apk"
        dest = APK_DIR / name
        print(f"[pull] {remote} -> {dest}")
        adb("pull", remote, str(dest), serial=serial)
        pulled.append(dest)
    return pulled


def extract(apks, force=False):
    """从 APK 列表里提取 libil2cpp.so（按架构优先级）与 global-metadata.dat。"""
    so_dest = DEST / SO_NAME
    meta_dest = DEST / "global-metadata.dat"
    if so_dest.exists() and meta_dest.exists() and not force:
        print(f"[skip] {SO_NAME} / global-metadata.dat 已存在（--dump-only 可直接用）")
        return
    so_found = meta_found = None
    for apk in apks:
        if not apk.exists():
            continue
        with zipfile.ZipFile(apk) as z:
            names = set(z.namelist())
            if not so_found:
                for arch in SO_CANDIDATES:
                    entry = f"lib/{arch}/{SO_NAME}"
                    if entry in names:
                        z.extract(entry, DEST)
                        (DEST / entry).rename(so_dest)
                        (DEST / "lib").rmdir() if (DEST / "lib").is_dir() and not any(
                            (DEST / "lib").iterdir()
                        ) else None
                        so_found = arch
                        print(
                            f"[ok]   {entry}（{so_dest.stat().st_size / 1e6:.1f} MB）"
                        )
                        break
            if not meta_found and METADATA in names:
                z.extract(METADATA, DEST)
                (DEST / METADATA).rename(meta_dest)
                meta_found = True
                print(f"[ok]   {METADATA}（{meta_dest.stat().st_size / 1e6:.1f} MB）")
        if so_found and meta_found:
            break
    if not so_found:
        die(f"APK 里没找到 {SO_NAME}（试过 {SO_CANDIDATES}；确认拉到的是完整包）")
    if not meta_found:
        die(f"APK 里没找到 {METADATA}（元数据通常在 base 包）")


def run_dump():
    if not DUMPER.exists():
        die(f"找不到 {DUMPER}")
    so = DEST / SO_NAME
    meta = DEST / "global-metadata.dat"
    out_dir = DEST / "dump"
    out_dir.mkdir(parents=True, exist_ok=True)
    # RequireAnyKey 会等按键，无头调用前临时关掉，结束后还原
    cfg = json.loads(DUMPER_CONFIG.read_text(encoding="utf-8"))
    orig_key = cfg.get("RequireAnyKey")
    if orig_key:
        cfg["RequireAnyKey"] = False
        DUMPER_CONFIG.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    try:
        print("[dump] Il2CppDumper 运行中…")
        r = subprocess.run(
            [str(DUMPER), str(so), str(meta), str(out_dir)],
            capture_output=True,
            text=True,
            cwd=str(DUMPER.parent),
        )
        print(r.stdout[-4000:] if r.stdout else "", end="")
        if r.returncode != 0:
            die(f"Il2CppDumper 退出码 {r.returncode}:\n{r.stderr[-2000:]}")
    finally:
        if orig_key:
            cfg["RequireAnyKey"] = orig_key
            DUMPER_CONFIG.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    dump_cs = out_dir / "dump.cs"
    if not dump_cs.exists():
        die("dump 结束但没有 dump.cs，查看上方输出排查")
    print(f"[ok]   {dump_cs}（{dump_cs.stat().st_size / 1e6:.1f} MB）")


def main():
    ap = argparse.ArgumentParser(description="拉取 APK 提取 il2cpp 并调用 Il2CppDumper")
    ap.add_argument("--host", help="先 adb connect（模拟器地址）")
    ap.add_argument("--serial", help="指定 adb -s 设备（多设备时）")
    ap.add_argument("--package", help="手动指定包名（默认自动匹配 azurlane）")
    ap.add_argument("--extract-only", metavar="APK", help="只从本地 APK 提取，不连设备")
    ap.add_argument("--dump-only", action="store_true", help="跳过拉取/提取，只跑 dump")
    ap.add_argument("--rm-apk", action="store_true", help="提取成功后删除 APK")
    ap.add_argument("--force", action="store_true", help="so/metadata 已存在也重新提取")
    args = ap.parse_args()

    DEST.mkdir(parents=True, exist_ok=True)

    if args.dump_only:
        run_dump()
        return

    if args.extract_only:
        extract([Path(args.extract_only)], force=True)
    else:
        if args.host:
            print(adb("connect", args.host).strip())
        serial = args.serial
        if not serial:
            out = adb("devices")
            devs = [
                line.split()[0]
                for line in out.replace("\r", "").splitlines()[1:]
                if line.strip() and line.split()[1] == "device"
            ]
            if not devs:
                die(
                    "没有可用设备：先开模拟器，或 --host 连接，或 --extract-only 用本地 APK"
                )
            serial = devs[0]
            print(f"[dev]  {serial}")
        package = args.package or find_package(serial)
        print(f"[pkg]  {package}")
        apks = pull_apks(serial, package)
        extract(apks, force=args.force)
        if args.rm_apk:
            shutil.rmtree(APK_DIR, ignore_errors=True)
            print("[rm]   apk/ 已清理")

    run_dump()
    print(f"\n完成。入口: {DEST / 'dump/dump.cs'}（grep Live2dChar / CubismParameter）")


if __name__ == "__main__":
    main()
