// APK -> il2cpp 二进制 + global-metadata.dat 拉取器，并调用 Il2CppDumper。
//
// 用法:
//     node scripts/pull_cs.js                  # 全流程：连设备拉 APK -> 提取 -> dump
//     ... --host [host:port]                   # 先 adb connect（模拟器地址）
//     ... --serial emulator-5556               # 多设备时指定
//     ... --extract-only D:/path/to/base.apk   # 只从本地 APK 提取（不连设备）
//     ... --dump-only                          # 跳过拉取/提取，只重跑 dump
//     ... --rm-apk                             # 提取成功后删除 APK（默认保留）
//
// 产物 .tmp/cs/:
//     apk/base.apk（或 split 各分片）   设备原包
//     libil2cpp.so                      il2cpp 原生库（arm64 优先，armv7 兜底）
//     global-metadata.dat               il2cpp 元数据（与 so 必须同包同版本）
//     dump/dump.cs                      C# 全量签名（类/字段/方法/偏移），逆向入口
//     dump/script.json / stringliteral.json 等
//
// 说明:
//     - Lua 控制层（.tmp/lua）之外的另一半真相在 C# 层：Live2dChar 的命中检测（GetDragPart）、
//       参数叠加（AddParameterValue/ChangeParameterData）等都在 dump.cs 里查签名，
//       函数体按需小窗口反汇编（勿全量扫描）
//     - Il2CppDumper 的 RequireAnyKey 会阻塞无头调用，跑 dump 前临时改写
//       tools/Il2CppDumper/config.json、结束后还原
//     - 包名自动匹配 pm list packages 里的 azurlane；split APK（base + 各 split）逐个提取，
//       需要的两个文件通常在 base 里
//     - APK 是 zip 容器（可为 zip64），这里手写中央目录解析只解出目标条目，不全解压

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADB = resolve(ROOT, "tools", "adb", "adb.exe");
const DUMPER = resolve(ROOT, "tools", "Il2CppDumper", "Il2CppDumper.exe");
const DUMPER_CONFIG = resolve(ROOT, "tools", "Il2CppDumper", "config.json");

const DEST = resolve(ROOT, ".tmp", "cs");
const APK_DIR = resolve(DEST, "apk");

// APK 内的目标条目：libil2cpp.so 架构按优先级取第一个命中的
const SO_CANDIDATES = ["arm64-v8a", "armeabi-v7a"];
const SO_NAME = "libil2cpp.so";
const METADATA = "assets/bin/Data/Managed/Metadata/global-metadata.dat";

function die(msg) {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

function adb(args, serial = null) {
  const cmd = [ADB];
  if (serial) cmd.push("-s", serial);
  cmd.push(...args);
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "buffer" });
  const out = r.stdout ? r.stdout.toString("utf8") : "";
  const err = r.stderr ? r.stderr.toString("utf8") : "";
  if (r.status !== 0) {
    die(`adb ${args.join(" ")} 失败:\n${err.trim() || out.trim()}`);
  }
  return out;
}

function findPackage(serial) {
  const out = adb(["shell", "pm", "list", "packages"], serial);
  const hits = out
    .replace(/\r/g, "")
    .split("\n")
    .filter(
      (ln) =>
        ln.startsWith("package:") && ln.toLowerCase().includes("azurlane"),
    )
    .map((ln) => ln.slice("package:".length).trim());
  if (!hits.length)
    die(
      "pm list packages 里没找到 azurlane 包（--serial 换设备或手动确认包名）",
    );
  if (hits.length > 1)
    console.warn(`[warn] 匹配到多个包 [${hits.join(", ")}]，取第一个`);
  return hits[0];
}

function pullApks(serial, pkg) {
  const out = adb(["shell", "pm", "path", pkg], serial);
  const paths = out
    .replace(/\r/g, "")
    .split("\n")
    .filter((ln) => ln.startsWith("package:"))
    .map((ln) => ln.slice("package:".length).trim());
  if (!paths.length) die(`pm path ${pkg} 为空`);
  mkdirSync(APK_DIR, { recursive: true });
  const pulled = [];
  paths.forEach((remote, i) => {
    const name = basename(remote) || `split${i}.apk`;
    const dest = resolve(APK_DIR, name);
    console.log(`[pull] ${remote} -> ${dest}`);
    adb(["pull", remote, dest], serial);
    pulled.push(dest);
  });
  return pulled;
}

// ---- zip 中央目录读取（含 zip64）----

const U16 = (buf, off) => buf.readUInt16LE(off);
const U32 = (buf, off) => buf.readUInt32LE(off);
const U64 = (buf, off) => buf.readBigUInt64LE(off);

// 在文件尾部窗口内搜索 End of Central Directory（注释长度不定，从后往前扫签名）
function findEocd(fd, fileSize) {
  const SIG = 0x06054b50;
  const windowSize = Math.min(fileSize, 22 + 65535);
  const buf = Buffer.alloc(windowSize);
  readSync(fd, buf, 0, windowSize, fileSize - windowSize);
  for (let i = windowSize - 22; i >= 0; i--) {
    if (U32(buf, i) === SIG)
      return { absOffset: fileSize - windowSize + i, buf, localIndex: i };
  }
  die("zip：找不到 End of Central Directory");
}

// 解析 zip64 扩展字段（header id 0x0001；字段按缺 0xFFFFFFFF 的顺序出现：size/ungsize/offset）
function zip64Extra(extra) {
  const vals = {};
  let off = 0;
  while (off + 4 <= extra.length) {
    const id = U16(extra, off);
    const size = U16(extra, off + 2);
    if (id === 0x0001) {
      let p = off + 4;
      for (const f of ["compressedSize", "uncompressedSize", "localOffset"]) {
        if (p + 8 <= off + 4 + size) vals[f] = U64(extra, p);
        p += 8;
      }
    }
    off += 4 + size;
  }
  return vals;
}

// 读文件指定区段
function readRange(fd, start, length) {
  const buf = Buffer.alloc(length);
  readSync(fd, buf, 0, length, start);
  return buf;
}

// 列出中央目录全部条目：{name, compressedSize, uncompressedSize, localOffset}
function listZipEntries(path) {
  const fd = openSync(path, "r");
  try {
    const fileSize = fstatSync(fd).size;
    const { absOffset, buf, localIndex } = findEocd(fd, fileSize);
    const eocd = localIndex;
    let cdSize = U32(buf, eocd + 12);
    let cdOffset = U32(buf, eocd + 16);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      // zip64：EOCD 前面是 locator（20 字节），指向 zip64 EOCD（56 字节）
      const z64 = eocd - 20;
      if (U32(buf, z64) !== 0x07064b50) die("zip：zip64 locator 缺失");
      const z64EocdOff = Number(U64(buf, z64 + 8));
      const z64Buf = readRange(fd, z64EocdOff, 56);
      if (U32(z64Buf, 0) !== 0x06064b50) die("zip：zip64 EOCD 签名不符");
      cdSize = Number(U64(z64Buf, 40));
      cdOffset = Number(U64(z64Buf, 48));
    }
    const cd = readRange(fd, cdOffset, cdSize);
    const entries = [];
    let off = 0;
    while (off + 46 <= cd.length && U32(cd, off) === 0x02014b50) {
      const compressedSize = U32(cd, off + 20);
      const uncompressedSize = U32(cd, off + 24);
      const nameLen = U16(cd, off + 28);
      const extraLen = U16(cd, off + 30);
      const commentLen = U16(cd, off + 32);
      const localOffset = U32(cd, off + 42);
      const name = cd.slice(off + 46, off + 46 + nameLen).toString("utf8");
      const extra = cd.slice(off + 46 + nameLen, off + 46 + nameLen + extraLen);
      const need64 =
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        localOffset === 0xffffffff;
      if (need64) {
        const z = zip64Extra(extra);
        entries.push({
          name,
          compressedSize:
            z.compressedSize !== undefined
              ? Number(z.compressedSize)
              : compressedSize,
          uncompressedSize:
            z.uncompressedSize !== undefined
              ? Number(z.uncompressedSize)
              : uncompressedSize,
          localOffset:
            z.localOffset !== undefined ? Number(z.localOffset) : localOffset,
        });
      } else {
        entries.push({ name, compressedSize, uncompressedSize, localOffset });
      }
      off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

// 从 zip 中解出单个条目到目标文件（stored 或 deflate；只按位读该条目区段，不整包载入内存）
function extractEntry(path, entry, destPath) {
  const fd = openSync(path, "r");
  try {
    // 本地文件头：偏移来自中央目录；local header 的 extra 长度可与 CD 不同，按其自身长度跳过
    const lo = entry.localOffset;
    const head = readRange(fd, lo, 30);
    if (U32(head, 0) !== 0x04034b50) die(`zip：${entry.name} 本地头签名不符`);
    const nameLen = U16(head, 26);
    const extraLen = U16(head, 28);
    const dataStart = lo + 30 + nameLen + extraLen;
    const method = U16(head, 8);
    const raw = readRange(fd, dataStart, entry.compressedSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else die(`zip：${entry.name} 压缩方法 ${method} 不支持`);
    if (data.length !== entry.uncompressedSize) {
      die(
        `zip：${entry.name} 解出 ${data.length} 字节，预期 ${entry.uncompressedSize}`,
      );
    }
    writeFileSync(destPath, data);
  } finally {
    closeSync(fd);
  }
}

// 从 APK 列表里提取 libil2cpp.so（按架构优先级）与 global-metadata.dat
function extract(apks, force = false) {
  const soDest = resolve(DEST, SO_NAME);
  const metaDest = resolve(DEST, "global-metadata.dat");
  if (existsSync(soDest) && existsSync(metaDest) && !force) {
    console.log(
      "[skip] libil2cpp.so / global-metadata.dat 已存在（--dump-only 可直接用）",
    );
    return;
  }
  let soFound = null;
  let metaFound = false;
  for (const apk of apks) {
    if (!existsSync(apk)) continue;
    const entries = listZipEntries(apk);
    if (!soFound) {
      for (const arch of SO_CANDIDATES) {
        const entry = entries.find((e) => e.name === `lib/${arch}/${SO_NAME}`);
        if (!entry) continue;
        extractEntry(apk, entry, soDest);
        soFound = arch;
        console.log(
          `[ok]   ${entry.name}（${(statSync(soDest).size / 1e6).toFixed(1)} MB）`,
        );
        break;
      }
    }
    if (!metaFound) {
      const entry = entries.find((e) => e.name === METADATA);
      if (entry) {
        extractEntry(apk, entry, metaDest);
        metaFound = true;
        console.log(
          `[ok]   ${METADATA}（${(statSync(metaDest).size / 1e6).toFixed(1)} MB）`,
        );
      }
    }
    if (soFound && metaFound) break;
  }
  if (!soFound)
    die(
      `APK 里没找到 ${SO_NAME}（试过 [${SO_CANDIDATES.join(", ")}]；确认拉到的是完整包）`,
    );
  if (!metaFound) die(`APK 里没找到 ${METADATA}（元数据通常在 base 包）`);
}

function runDump() {
  if (!existsSync(DUMPER)) die(`找不到 ${DUMPER}`);
  const so = resolve(DEST, SO_NAME);
  const meta = resolve(DEST, "global-metadata.dat");
  const outDir = resolve(DEST, "dump");
  mkdirSync(outDir, { recursive: true });
  // RequireAnyKey 会等按键，无头调用前临时关掉，结束后还原
  const cfg = JSON.parse(readFileSync(DUMPER_CONFIG, "utf8"));
  const origKey = cfg.RequireAnyKey;
  if (origKey) {
    cfg.RequireAnyKey = false;
    writeFileSync(DUMPER_CONFIG, JSON.stringify(cfg, null, 2), "utf8");
  }
  try {
    console.log("[dump] Il2CppDumper 运行中…");
    const r = spawnSync(DUMPER, [so, meta, outDir], {
      encoding: "utf8",
      cwd: dirname(DUMPER),
    });
    if (r.stdout) console.log(r.stdout.slice(-4000));
    if (r.status !== 0)
      die(`Il2CppDumper 退出码 ${r.status}:\n${(r.stderr || "").slice(-2000)}`);
  } finally {
    if (origKey) {
      cfg.RequireAnyKey = origKey;
      writeFileSync(DUMPER_CONFIG, JSON.stringify(cfg, null, 2), "utf8");
    }
  }
  const dumpCs = resolve(outDir, "dump.cs");
  if (!existsSync(dumpCs)) die("dump 结束但没有 dump.cs，查看上方输出排查");
  console.log(
    `[ok]   ${dumpCs}（${(statSync(dumpCs).size / 1e6).toFixed(1)} MB）`,
  );
}

function parseArgs(argv) {
  const args = {
    host: null,
    serial: null,
    package: null,
    extractOnly: null,
    dumpOnly: false,
    rmApk: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--host":
        args.host = argv[++i];
        break;
      case "--serial":
        args.serial = argv[++i];
        break;
      case "--package":
        args.package = argv[++i];
        break;
      case "--extract-only":
        args.extractOnly = argv[++i];
        break;
      case "--dump-only":
        args.dumpOnly = true;
        break;
      case "--rm-apk":
        args.rmApk = true;
        break;
      case "--force":
        args.force = true;
        break;
      default:
        die(`未知参数: ${a}`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(DEST, { recursive: true });

  if (args.dumpOnly) {
    runDump();
    return;
  }

  if (args.extractOnly) {
    extract([args.extractOnly], true);
  } else {
    if (args.host) console.log(adb(["connect", args.host]).trim());
    let serial = args.serial;
    if (!serial) {
      const out = adb(["devices"]);
      const devs = out
        .replace(/\r/g, "")
        .split("\n")
        .slice(1)
        .filter((ln) => ln.trim() && ln.split(/\s+/)[1] === "device")
        .map((ln) => ln.split(/\s+/)[0]);
      if (!devs.length) {
        die(
          "没有可用设备：先开模拟器，或 --host 连接，或 --extract-only 用本地 APK",
        );
      }
      serial = devs[0];
      console.log(`[dev]  ${serial}`);
    }
    const pkg = args.package || findPackage(serial);
    console.log(`[pkg]  ${pkg}`);
    const apks = pullApks(serial, pkg);
    extract(apks, args.force);
    if (args.rmApk) {
      rmSync(APK_DIR, { recursive: true, force: true });
      console.log("[rm]   apk/ 已清理");
    }
  }

  runDump();
  console.log(
    `\n完成。入口: ${resolve(DEST, "dump/dump.cs")}（grep Live2dChar / CubismParameter）`,
  );
}

main();
