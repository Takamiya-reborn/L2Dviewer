# -*- coding: utf-8 -*-
"""script.json 地址 -> 方法名 查询（Il2CppDumper ScriptMethod 表）。"""
import json
import sys

data = json.load(open(r"D:\Github\L2Dviewer\.tmp\cs\dump\script.json", encoding="utf-8"))
methods = data.get("ScriptMethod", [])
by_addr = {m["Address"]: m["Name"] for m in methods}
addrs = sorted(by_addr)
for a in sys.argv[1:]:
    addr = int(a, 16)
    name = by_addr.get(addr)
    if not name:
        lo = [x for x in addrs if x <= addr]
        hi = [x for x in addrs if x > addr]
        near = ""
        if lo and hi and addr - lo[-1] < 0x200:
            near = f"  (前一个方法: {by_addr[lo[-1]]} @0x{lo[-1]:X}, 距离 {addr - lo[-1]:#x})"
        name = f"<未知>{near}"
    print(f"0x{addr:X} -> {name}")
