"""小窗口反汇编工具：libil2cpp.so 的指定 Offset 起反汇编 N 字节（ARM64）。

只做定点小窗口（勿全量扫描），供人读汇编语义用：
    uv run scripts/disasm_window.py 0x391F018 0x1DC
    python scripts/disasm_window.py 0x391F018 0x1DC

运行前请先安装 requirements.txt；python 可以是全局解释器，也可以是
venv/virtualenv 等虚拟环境中的解释器。若使用虚拟环境，请用同一个解释器
安装依赖并执行脚本，例如：
    .venv/Scripts/python.exe -m pip install -r requirements.txt
    .venv/Scripts/python.exe scripts/disasm_window.py 0x391F018 0x1DC
"""

import sys
from pathlib import Path

import capstone

SO = Path(__file__).resolve().parent.parent / ".tmp/cs/libil2cpp.so"


def main():
    off = int(sys.argv[1], 0)
    size = int(sys.argv[2], 0)
    data = SO.read_bytes()[off : off + size]
    md = capstone.Cs(capstone.CS_ARCH_ARM64, capstone.CS_MODE_LITTLE_ENDIAN)
    md.detail = False
    for ins in md.disasm(data, off):
        print(f"0x{ins.address:x}:\t{ins.mnemonic}\t{ins.op_str}")


if __name__ == "__main__":
    main()
