"""解析社区明文 Lua 的 ship_l2d 交互配置（.tmp/lua/<服务器>/sharecfg/ship_l2d.lua）。

用法（uv 与裸 python 二选一）:
    uv run python -I scripts/parse_ship_l2d.py <skin_id>       # 数字皮肤 id
    python -I scripts/parse_ship_l2d.py <skin_id>              # 同上，默认 CN
    ... --server JP                                            # 换服务器快照
    ... --raw                                                  # 输出完整 JSON 而非摘要

ship_l2d 条目键 = 皮肤 id*100 + 序号（如 40704101），每条描述一个可交互区
（draw_able_name）绑定的拖拽/反应参数机。字段语义见 docs/unpack.md。

数据来历：github.com/AzurLaneTools/AzurLaneLuaScripts（社区自动解密的明文
游戏 Lua，不入库），由 pull_lua.py 拉取到 .tmp/lua/（gitignore）；
本脚本读取路径固定于此，与 pull_lua.py 的落点硬编码对齐，改动须同步。
"""

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent

# 皮肤 id 映射：painting 名（fulici_2）-> 数字皮肤 id（407041）


def lua_path(server):
    return ROOT / ".tmp/lua" / server / "sharecfg/ship_l2d.lua"


def skin_template_path(server):
    return ROOT / ".tmp/lua" / server / "sharecfgdata/ship_skin_template.lua"

# 条目块从 `pg.base.ship_l2d[<key>] = {` 起，到行首一个制表符的 `}` 止
ENTRY_RE = re.compile(r"^\tpg\.base\.ship_l2d\[(\d+)\] = \{$", re.MULTILINE)

IDENT_RE = re.compile(r"[A-Za-z_]\w*")


class _Parser:
    """字符级 Lua 表解析器。文件是机器生成的规范格式：字符串无转义、
    值只有 number/string/true/false/nil、表为键值式或数组式（含空表）。"""

    def __init__(self, text: str):
        self.s = text
        self.i = 0

    def _skip(self):
        while self.i < len(self.s) and self.s[self.i] in " \t\r\n":
            self.i += 1

    def parse(self):
        return self._value()

    def _value(self):
        self._skip()
        c = self.s[self.i]
        if c == "{":
            return self._table()
        if c == '"':
            end = self.s.index('"', self.i + 1)
            text = self.s[self.i + 1 : end]
            self.i = end + 1
            return text
        m = re.match(r"[-+0-9.eE]+", self.s[self.i :])
        if m:
            text = m.group(0)
            self.i += len(text)
            if "." in text or "e" in text.lower():
                return float(text)
            return int(text)
        for word, value in (("true", True), ("false", False), ("nil", None)):
            if self.s.startswith(word, self.i):
                self.i += len(word)
                return value
        raise ValueError(f"无法解析值: {self.s[self.i : self.i + 40]!r}")

    def _table(self):
        self.i += 1  # {
        table, array = {}, []
        while True:
            self._skip()
            if self.i >= len(self.s):
                raise ValueError("表在闭合前结束")
            if self.s[self.i] == "}":
                self.i += 1
                return array if array else table
            # 试探 `key = value`：标识符后紧跟 = 才算键，否则是数组元素
            m = IDENT_RE.match(self.s, self.i)
            if m:
                save = self.i
                self.i = m.end()
                self._skip()
                if self.s[self.i] == "=":
                    self.i += 1
                    table[m.group(0)] = self._value()
                    self._skip_comma()
                    continue
                self.i = save
            array.append(self._value())
            self._skip_comma()

    def _skip_comma(self):
        self._skip()
        if self.i < len(self.s) and self.s[self.i] == ",":
            self.i += 1


def lua_table_to_json(text: str):
    """把单个条目的 Lua 表文本转成 Python 对象。

    条目正则已消费外层 `= {`，这里补回开括号；闭括号由文本自身的块尾提供。
    """
    return _Parser("{" + text).parse()


def parse_skin(skin_id: int, server: str = "CN"):
    lua = lua_path(server).read_text(encoding="utf-8")
    entries = []
    matches = list(ENTRY_RE.finditer(lua))
    for i, m in enumerate(matches):
        key = int(m.group(1))
        if key // 100 != skin_id:
            continue
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(lua)
        entry = lua_table_to_json(lua[start:end])
        entries.append({"key": key, **entry})
    return entries


SUMMARY_FIELDS = [
    "id",
    "draw_able_name",
    "parameter",
    "range",
    "start_value",
    "mode",
    "smooth",
    "revert",
    "revert_smooth",
    "drag_direct",
    "range_abs",
    "ignore_action",
    "ignore_react",
    "action_trigger",
    "action_trigger_active",
    "react_condition",
    "listener_data",
    "relation_parameter",
    "parts_data",
    "revert_idle_index",
    "revert_action_index",
]


def main():
    ap = argparse.ArgumentParser(description="解析 ship_l2d 交互配置")
    ap.add_argument("skin_id", type=int, help="数字皮肤 id")
    ap.add_argument("--server", default="CN", help="服务器目录（默认 CN，需先 pull_lua.py）")
    ap.add_argument("--raw", action="store_true", help="输出完整 JSON 而非摘要")
    args = ap.parse_args()

    entries = parse_skin(args.skin_id, args.server)
    if not entries:
        sys.exit(f"ship_l2d 中没有皮肤 {skin_id} 的条目")
    if args.raw:
        print(json.dumps(entries, ensure_ascii=False, indent=2))
        return
    for e in entries:
        print(f"== ship_l2d[{e['key']}] ==")
        for f in SUMMARY_FIELDS:
            if f in e and e[f] not in ("", None, [], {}):
                v = json.dumps(e[f], ensure_ascii=False)
                print(f"  {f} = {v}")


if __name__ == "__main__":
    main()
