// 目录一键更新：游戏版本更新后重跑整条目录链路 -> public/catalog.json。
//
// 用法:
//     node scripts/update.js
//
// 选项:
//     --proxy [http://proxy:port] 传给 pull_lua.js（缺省时自动探测本机常见代理端口，均不通则直连）
//
// 步骤:
//     1. pull_lua.js --force        重拉 CN Lua 快照（模板/代换表/阵营表，走 GitHub）
//     2. pull_bundles.js --index    从设备刷新 hashes-live2d.csv / version-live2d.txt（需 adb 设备在线）
//     3. gen_catalog.js             重排 public/catalog.json
//     4. 与旧目录 diff，打印版本变化与新增/移除的皮肤
//
// 任一步骤失败即中止并给出对应补救提示；成功后目录立即可供前端展示与按 id 拉取。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_PATH = resolve(ROOT, "public", "catalog.json");

// 本机代理端口会漂移，按常见值依次探测（首次握手成功即视为在线）
const PROXY_PORTS = [7890, 7892, 7897];

function die(msg) {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

// 解析 CLI 参数（最小实现，只收本脚本认识的开关）
function parseArgs(argv) {
  const args = { proxy: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--proxy") {
      const next = argv[i + 1];
      args.proxy = next && !next.startsWith("--") ? argv[++i] : "";
    } else die(`未知参数: ${a}`);
  }
  return args;
}

// 探测端口是否可连（TCP 握手成功即算）；超时/拒绝返回 null
function probePort(port, timeoutMs = 300) {
  return new Promise((resolvePromise) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const settle = (v) => {
      socket.destroy();
      resolvePromise(v);
    };
    socket.setTimeout(timeoutMs, () => settle(null));
    socket.once("error", () => settle(null));
    socket.once("connect", () => settle(port));
  });
}

// 依序试探常见端口，返回第一个在线端口的代理 URL；全不在线返回 null
async function detectLocalProxy() {
  for (const port of PROXY_PORTS) {
    if (await probePort(port)) return `http://127.0.0.1:${port}`;
  }
  return null;
}

// 依次执行子脚本；非零退出即中止，hint 是该步骤失败时的补救提示
function runStep(script, args, hint) {
  console.log(`\n== node scripts/${script} ${args.join(" ")}`.trimEnd());
  const r = spawnSync(
    process.execPath,
    [resolve(ROOT, "scripts", script), ...args],
    {
      stdio: "inherit",
      cwd: ROOT,
    },
  );
  if (r.status !== 0)
    die(
      `步骤失败: scripts/${script}（${r.status === null ? (r.error?.message ?? "未知错误") : `exit ${r.status}`}）\n${hint}`,
    );
}

// 读取旧目录供 diff；首次使用（文件不存在）返回 null
function readOldCatalog() {
  if (!existsSync(CATALOG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  } catch {
    die(`${CATALOG_PATH} 不是合法 JSON，先手工修复或删除后重跑`);
  }
}

// 按 painting 对齐新旧条目，返回 { added, removed }（均为条目数组）
function diffCatalog(oldCatalog, newCatalog) {
  const keyOf = (catalog) =>
    new Map(catalog.entries.map((e) => [e.painting, e]));
  const oldMap = oldCatalog ? keyOf(oldCatalog) : new Map();
  const newMap = keyOf(newCatalog);
  const added = [];
  const removed = [];
  for (const [painting, entry] of newMap)
    if (!oldMap.has(painting)) added.push(entry);
  for (const [painting, entry] of oldMap)
    if (!newMap.has(painting)) removed.push(entry);
  return { added, removed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const oldCatalog = readOldCatalog();

  // 代理取值优先级：--proxy 显式值 > HTTPS_PROXY 环境 > 自动探测；裸 --proxy 交给 pull_lua 回落环境变量
  const envProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  let proxyArg = [];
  if (args.proxy) {
    if (args.proxy !== "") proxyArg = ["--proxy", args.proxy];
  } else if (!envProxy) {
    const proxy = await detectLocalProxy();
    if (proxy) {
      proxyArg = ["--proxy", proxy];
      console.log(`探测到本机代理 ${proxy}`);
    } else {
      console.log(
        "未探测到本机代理，Lua 快照将尝试直连（失败请开代理或 --proxy 指定）",
      );
    }
  }

  runStep(
    "pull_lua.js",
    ["--force", ...proxyArg],
    "检查网络/代理后重跑；GitHub 直连不通时加 --proxy",
  );
  runStep(
    "pull_bundles.js",
    ["--index"],
    "启动模拟器或连接设备后再跑；也可先单独执行 node scripts/pull_bundles.js --index",
  );
  runStep(
    "gen_catalog.js",
    [],
    "确认 .tmp/lua/CN 与 .tmp/hashes-live2d.csv 均已就位",
  );

  const newCatalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  const { added, removed } = diffCatalog(oldCatalog, newCatalog);

  const oldVersion = oldCatalog?.version;
  const newVersion = newCatalog.version;
  if (oldVersion !== newVersion)
    console.log(`\n版本: ${oldVersion ?? "(无)"} -> ${newVersion ?? "(无)"}`);

  console.log(`\n新增 ${added.length} 项:`);
  for (const e of added) console.log(`  + ${e.name}（${e.painting}）`);
  if (!added.length) console.log("  （无）");

  if (removed.length) {
    console.log(`移除 ${removed.length} 项:`);
    for (const e of removed) console.log(`  - ${e.name}（${e.painting}）`);
  }

  console.log(
    `\n完成，目录 ${newCatalog.entries.length} 条 -> ${CATALOG_PATH}`,
  );
  if (added.length) {
    console.log(
      `新增皮肤按 id 拉取: node scripts/pull_bundles.js <skin_id>（bundle 名即 painting 列）`,
    );
  }
}

main();
