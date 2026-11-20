// 社区明文 Lua 快照拉取器：AzurLaneLuaScripts 仓库 -> .tmp/lua/<服务器>/。
//
// 用法:
//     node scripts/pull_lua.js              # 拉取 CN 必需文件（extract.js 用）
//     ... --server JP                       # 拉日本服务器（可逗号分隔多个：JP,KR）
//     ... --force                           # 本地已存在也重拉（默认跳过）
//
// 选项:
//     --server LIST 服务器目录，可逗号分隔多个（默认 CN；可选 CN/EN/JP/KR/TW）
//     --proxy [http://proxy:port] HTTP(S) 代理（默认读 HTTPS_PROXY 环境变量）
//
// 说明:
//     - 文件清单即 docs/azurlane.md 记录的子集，各服务器目录结构一致
//         - 默认含控制层（view/ship/live2d*.lua、mgr/live2dmgr.lua）：交互语义的根修依据
//         - 落点固定在 .tmp/lua/（无路径参数）；extract.js 从同一位置读取
//     - 游戏版本更新后重拉快照（--force 覆盖本地），再重跑 extract.js 烘焙

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import tls from "node:tls";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = resolve(ROOT, ".tmp", "lua");

const REPO = "AzurLaneTools/AzurLaneLuaScripts";
const BRANCH = "main";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

// 上游按服务器分目录，结构一致（CN/EN/JP/KR/TW）
const SERVERS = ["CN", "EN", "JP", "KR", "TW"];

// 必需：extract.js 的直接输入 + gen_catalog.js 的名字代换表与阵营筛选数据（相对服务器目录）
const REQUIRED = [
  "sharecfg/ship_l2d.lua",
  "sharecfg/ship_skin_newmainui_shift.lua",
  "sharecfgdata/ship_skin_template.lua",
  "sharecfg/name_code.lua",
  "sharecfgdata/ship_data_statistics.lua",
];
// 控制层：查看器交互语义的根修依据（live2d.lua 调 C#，live2ddrag.lua 是拖拽机本体），
// 与 ship_l2d 同为默认清单——新皮肤一旦用到监听器/联动等边角语义，缺这份就得现拉
const REFERENCE = [
  "view/ship/live2d.lua",
  "view/ship/live2dconst.lua",
  "view/ship/live2ddrag.lua",
  "view/ship/live2dextend.lua",
  "view/ship/live2dpainting.lua",
  "mgr/live2dmgr.lua",
];

function die(msg) {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

// 解析 CLI 参数（最小实现，只收本脚本认识的开关）
function parseArgs(argv) {
  const args = { server: "CN", all: false, force: false, proxy: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--server") args.server = argv[++i];
    else if (a === "--all")
      args.all = true; // 已并入默认清单，保留兼容
    else if (a === "--force") args.force = true;
    else if (a === "--proxy") {
      // 可带值也可裸旗标（裸 = 回落读 HTTPS_PROXY）
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) args.proxy = argv[++i];
    } else die(`未知参数: ${a}`);
  }
  return args;
}

// HTTPS over HTTP 代理：CONNECT 建隧道后在其上做 TLS + HTTP GET（免 undici 依赖）
function fetchViaProxy(url, proxyUrl) {
  const target = new URL(url);
  const proxy = new URL(proxyUrl);
  if (target.protocol !== "https:") die("代理通道仅支持 https 目标");
  return new Promise((resolvePromise, reject) => {
    const socket = net.connect({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
    });
    socket.on("connect", () => {
      socket.write(
        `CONNECT ${target.hostname}:443 HTTP/1.1\r\n` +
          `Host: ${target.hostname}:443\r\n\r\n`,
      );
    });
    socket.once("error", reject);
    socket.once("data", function onData(head) {
      if (
        !/^HTTP\/1\.[01] 200/.test(head.toString("latin1").split("\r\n")[0])
      ) {
        reject(
          new Error(
            `代理 CONNECT 失败: ${head.toString("latin1").split("\r\n")[0]}`,
          ),
        );
        return;
      }
      const tlsSocket = tls.connect({
        socket,
        servername: target.hostname,
      });
      const chunks = [];
      tlsSocket.on("data", (c) => chunks.push(c));
      tlsSocket.on("error", reject);
      tlsSocket.on("end", () => resolvePromise(Buffer.concat(chunks)));
      tlsSocket.on("secureConnect", () => {
        tlsSocket.write(
          `GET ${target.pathname} HTTP/1.1\r\n` +
            `Host: ${target.hostname}\r\n` +
            "User-Agent: siren-pull_lua\r\n" +
            "Connection: close\r\n\r\n",
        );
      });
    });
  });
}

// 简易 chunked/整块响应解包：从 TLS socket 收到的原始 HTTP 响应中剥头取体
function extractBody(raw) {
  const sep = raw.indexOf("\r\n\r\n");
  if (sep < 0) throw new Error("HTTP 响应缺头部");
  const head = raw.slice(0, sep).toString("latin1");
  let body = raw.slice(sep + 4);
  if (
    /^Content-Transfer-Encoding: chunked|Transfer-Encoding: chunked/m.test(head)
  ) {
    const parts = [];
    let pos = 0;
    for (;;) {
      const lineEnd = body.indexOf("\r\n", pos);
      if (lineEnd < 0) break;
      const size = parseInt(body.slice(pos, lineEnd).toString("latin1"), 16);
      if (!size) break;
      parts.push(body.slice(lineEnd + 2, lineEnd + 2 + size));
      pos = lineEnd + 2 + size + 2;
    }
    body = Buffer.concat(parts);
  }
  const status = Number(head.split(" ")[1]);
  if (status !== 200) {
    const err = new Error(`HTTP ${status}`);
    err.status = status;
    throw err;
  }
  return body;
}

async function fetchBody(url, proxy) {
  if (proxy) return extractBody(await fetchViaProxy(url, proxy));
  // 直连走内置 fetch（代理用户走 --proxy / HTTPS_PROXY 分支）
  const res = await fetch(url, {
    headers: { "User-Agent": "siren-pull_lua" },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

async function pull(rel, destRoot, proxy, force) {
  const dest = resolve(destRoot, rel);
  if (existsSync(dest) && !force) {
    console.log(`[skip] ${rel}（已存在，--force 重拉）`);
    return false;
  }
  const data = await fetchBody(`${RAW}/${rel}`, proxy);
  if (!data || data.length === 0) die(`空响应: ${rel}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, data);
  console.log(`[ok]   ${rel}（${(data.length / 1e6).toFixed(1)} MB）`);
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const servers = args.server.split(",").map((s) => s.trim().toUpperCase());
  const bad = servers.filter((s) => !SERVERS.includes(s));
  if (bad.length)
    die(`未知服务器: ${bad.join(",")}（可选 ${SERVERS.join("/")}）`);

  // --proxy 裸旗标时回落读环境变量
  const proxy =
    args.proxy ?? process.env.HTTPS_PROXY ?? process.env.https_proxy;

  const files = [...REQUIRED, ...REFERENCE];
  let ok = 0;
  for (const srv of servers) {
    console.log(`目标: ${resolve(DEST, srv)}（${files.length} 个文件）\n`);
    for (const rel of files) {
      try {
        if (await pull(`${srv}/${rel}`, DEST, proxy, args.force)) ok++;
      } catch (e) {
        // 单文件失败不中断整批
        console.error(`[fail] ${srv}/${rel}: ${e.message}`);
      }
    }
    console.log();
  }
  if (ok === 0 && !args.force) console.log("全部已存在，无需更新。");
  console.log("完成，下一步: node scripts/extract.js <skin_id> [--server JP]");
}

main();
