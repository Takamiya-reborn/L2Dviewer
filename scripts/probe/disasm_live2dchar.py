# -*- coding: utf-8 -*-
"""Live2dChar 关键方法小窗口反汇编（arm64）。

从 dump.cs 解析 Live2dChar 类块内的方法名 + 文件偏移，窗口=本方法偏移到
下一方法偏移（上限 16KB），只用 capstone 反汇编这些区间——不做全量扫描。

用法: python -I scripts/probe/disasm_live2dchar.py > .tmp/cs/disasm_live2dchar.txt
"""
import re
import sys

DUMP = r"D:\Github\L2Dviewer\.tmp\cs\dump\dump.cs"
SO = r"D:\Github\L2Dviewer\.tmp\cs\libil2cpp.so"
MAX_WINDOW = 0x4000

from capstone import Cs, CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN

text = open(DUMP, encoding="utf-8", errors="replace").read()

# Live2dChar 类块：从 "public class Live2dChar : MonoBehaviour" 到下一个 "\n// Namespace:"
start = text.index("public class Live2dChar : MonoBehaviour")
end = text.index("\n// Namespace:", start)
block = text[start:end]

# 方法行: "// RVA: 0x.. Offset: 0x.. VA: 0x..\n\t<modifiers> <name>(...) { }"
pat = re.compile(
    r"// RVA: (0x[0-9A-Fa-f]+) Offset: (0x[0-9A-Fa-f]+).*?\n\t([^\n{]+?)\s*\{ \}",
    re.S,
)
methods = []
for m in pat.finditer(block):
    rva, off, sig = m.group(1), m.group(2), m.group(3).strip()
    name = sig.split("(")[0].split()[-1]
    methods.append((name, int(off, 16), sig))

# 按偏移排序，窗口=到下一个偏移
methods.sort(key=lambda t: t[1])
so = open(SO, "rb")
so.seek(0, 2)
so_size = so.tell()

md = Cs(CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN)

WANT = sys.argv[1].split(",") if len(sys.argv) > 1 else None

for i, (name, off, sig) in enumerate(methods):
    nxt = methods[i + 1][1] if i + 1 < len(methods) else off + MAX_WINDOW
    size = min(nxt - off, MAX_WINDOW)
    if WANT and not any(w in name or w in sig for w in WANT):
        continue
    print(f"\n===== {name} @ off=0x{off:X} size≈0x{size:X} =====")
    print(f"  // {sig}")
    so.seek(off)
    code = so.read(size)
    for ins in md.disasm(code, off):
        print(f"  0x{ins.address:X}:\t{ins.mnemonic}\t{ins.op_str}")
