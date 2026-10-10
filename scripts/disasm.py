"""Il2Cpp ARM64 反汇编与地址查询工具。

用法:
    uv run scripts/disasm.py 0x391F018 0x1DC
    uv run scripts/disasm.py window 0x391F018 0x1DC
    uv run scripts/disasm.py addr 0x1234 0x5678
    uv run scripts/disasm.py live2dchar
    uv run scripts/disasm.py live2dchar Drag,Get

默认读取 .tmp/cs/libil2cpp.so、.tmp/cs/dump/dump.cs 和
.tmp/cs/dump/script.json。相关文件由 pull_cs.py 生成。
"""

import argparse
import json
import re
import sys
from pathlib import Path

import capstone

ROOT = Path(__file__).resolve().parent.parent
SO = ROOT / ".tmp/cs/libil2cpp.so"
DUMP = ROOT / ".tmp/cs/dump/dump.cs"
SCRIPT_JSON = ROOT / ".tmp/cs/dump/script.json"
MAX_WINDOW = 0x4000


def disassemble(data, address):
    md = capstone.Cs(capstone.CS_ARCH_ARM64, capstone.CS_MODE_LITTLE_ENDIAN)
    md.detail = False
    return "\n".join(
        f"0x{ins.address:x}:\t{ins.mnemonic}\t{ins.op_str}"
        for ins in md.disasm(data, address)
    )


def disassemble_window(offset, size):
    data = SO.read_bytes()[offset : offset + size]
    output = disassemble(data, offset)
    if output:
        print(output)


def lookup_addresses(addresses):
    data = json.loads(SCRIPT_JSON.read_text(encoding="utf-8"))
    methods = data.get("ScriptMethod", [])
    by_addr = {}
    for method in methods:
        raw_address = method["Address"]
        address = int(raw_address, 0) if isinstance(raw_address, str) else raw_address
        by_addr[address] = method["Name"]
    sorted_addresses = sorted(by_addr)

    for address in addresses:
        name = by_addr.get(address)
        if not name:
            lower = [value for value in sorted_addresses if value <= address]
            higher = [value for value in sorted_addresses if value > address]
            near = ""
            if lower and higher and address - lower[-1] < 0x200:
                near = (
                    f"  (前一个方法: {by_addr[lower[-1]]} "
                    f"@0x{lower[-1]:X}, 距离 {address - lower[-1]:#x})"
                )
            name = f"<未知>{near}"
        print(f"0x{address:X} -> {name}")


def parse_live2dchar_methods():
    text = DUMP.read_text(encoding="utf-8", errors="replace")
    marker = "public class Live2dChar : MonoBehaviour"
    start = text.index(marker)
    end = text.index("\n// Namespace:", start)
    block = text[start:end]
    pattern = re.compile(
        r"// RVA: (0x[0-9A-Fa-f]+) Offset: (0x[0-9A-Fa-f]+).*?\n"
        r"\t([^\n{]+?)\s*\{ \}",
        re.DOTALL,
    )
    methods = []
    for match in pattern.finditer(block):
        rva, offset, signature = match.groups()
        name = signature.strip().split("(")[0].split()[-1]
        methods.append((name, int(offset, 16), signature.strip(), rva))
    return sorted(methods, key=lambda method: method[1])


def disassemble_live2dchar(wanted):
    methods = parse_live2dchar_methods()
    so = SO.read_bytes()
    for index, (name, offset, signature, _rva) in enumerate(methods):
        next_offset = (
            methods[index + 1][1] if index + 1 < len(methods) else offset + MAX_WINDOW
        )
        size = min(next_offset - offset, MAX_WINDOW)
        if wanted and not any(term in name or term in signature for term in wanted):
            continue
        print(f"\n===== {name} @ off=0x{offset:X} size≈0x{size:X} =====")
        print(f"  // {signature}")
        output = disassemble(so[offset : offset + size], offset)
        if output:
            print(output)


def build_parser():
    parser = argparse.ArgumentParser(description="Il2Cpp ARM64 反汇编与地址查询")
    subparsers = parser.add_subparsers(dest="command")

    window = subparsers.add_parser("window", help="反汇编指定 Offset 起的 N 字节")
    window.add_argument("offset", type=lambda value: int(value, 0))
    window.add_argument("size", type=lambda value: int(value, 0))

    address = subparsers.add_parser("addr", help="script.json 地址查询")
    address.add_argument("addresses", nargs="+", type=lambda value: int(value, 0))

    live2dchar = subparsers.add_parser(
        "live2dchar", help="反汇编 dump.cs 中 Live2dChar 的方法"
    )
    live2dchar.add_argument(
        "wanted",
        nargs="?",
        help="逗号分隔的名称过滤条件，例如 Drag,Get",
    )
    return parser


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] not in {"window", "addr", "live2dchar", "-h", "--help"}:
        argv.insert(0, "window")
    args = build_parser().parse_args(argv)
    if args.command == "window":
        disassemble_window(args.offset, args.size)
    elif args.command == "addr":
        lookup_addresses(args.addresses)
    elif args.command == "live2dchar":
        wanted = args.wanted.split(",") if args.wanted else None
        disassemble_live2dchar(wanted)
    else:
        build_parser().print_help()


if __name__ == "__main__":
    main()
