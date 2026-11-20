# 测试

## 命令与布局

- 全量单测：`npm test`（node scripts/tests/run_all.mjs）。
- 布局：unit/ 单测、probe/ 真引擎探针、helpers/ 公共件、asset/ 测试资产。

## 编写要求

- 自建动作引擎必须带 fades 表，并覆盖真引擎四处分歧（物理输出 / 结尾淡出 / 混合期 / 一帧延迟），否则结论与真引擎不一致。
- 涉及开关参数的测试：先重建基线，跑一次 noop 自查确认基线干净，再做写入断言。
- 越界值断言须直写核心数组（框架写入口会钳位，见 runtime.md）。
- 二进制格式解析回归用合成字节流逐字段复刻游戏读取器语法（如 spine .skel 三条流：unit/test_spine_skel.mjs），不依赖真实资产。
