// extract.js 全量回归：产物 vs models/ 下既有真值，逐文件深比对。
// moc3 字节全等；JSON 数值容差 1e-9（int64 路径 ID 按 BigInt 精确比对）；PNG 像素级（ASTC 解码器
// 构建差异允许逐通道 |Δ|≤1，实测两模型全部像素仅 ±1 漂移）；告警集合与真值全等（fixture 硬编码）。
// 缺 bundle/真值时整支跳过。
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { suite } from "../helpers/suite.mjs";
import UPNG from "../../../node_modules/unityfs-js/vendor/upng/UPNG.js";

const { check, finish } = suite("extract.js 全量回归");

const MODELS = [
  { id: "fulici_2", char: "fulici" },
  { id: "zhenzhuhao_2", char: "zhenzhuhao" },
];

const runnable = MODELS.filter(
  (m) =>
    fs.existsSync(`.tmp/bundles/${m.id}`) &&
    fs.existsSync(`models/${m.char}/${m.id}/${m.id}.moc3`),
);
if (!runnable.length) {
  console.log("-- 本机缺 .tmp/bundles 或 models/ 真值，整支跳过");
  process.exit(0);
}

// 真值基线的告警原文（跨版本死绑定哈希未被撞库命中、曲线被跳过属预期行为）
const EXPECTED_WARNS = {
  fulici_2: [
    "touch_idle6: 4 条绑定路径哈希未解析(2bba0573 7f84ed15 dcaf551e 1491673b)，曲线被跳过",
  ],
  zhenzhuhao_2: [
    "touch_special: 9 条绑定路径哈希未解析(c79079c0 9bba1a95 e18ade52 7dbe3111 013591a8 f2cbdf5b ...共9条)，曲线被跳过",
    "idle15: 9 条绑定路径哈希未解析(c79079c0 9bba1a95 e18ade52 7dbe3111 013591a8 f2cbdf5b ...共9条)，曲线被跳过",
  ],
};

// ---------------------------------------------------------------- JSON 深比对

// 保留 int64 精度的 JSON 解析：超出安全范围的整数字面量转 BigInt，其余照常
function parseJsonBig(text) {
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\r\n".includes(text[i])) i++;
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj = {};
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        const key = str();
        ws();
        i++; // :
        obj[key] = value();
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        i++; // }
        return obj;
      }
    }
    if (c === "[") {
      i++;
      const arr = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value());
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        i++; // ]
        return arr;
      }
    }
    if (c === '"') return str();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    const m = /^-?\d+(\.\d+([eE][+-]?\d+)?|[eE][+-]?\d+)?/.exec(text.slice(i));
    const lit = m[0];
    i += lit.length;
    if (/^-?\d+$/.test(lit)) {
      const v = BigInt(lit);
      return v <= BigInt(Number.MAX_SAFE_INTEGER) &&
        v >= BigInt(Number.MIN_SAFE_INTEGER)
        ? Number(v)
        : v;
    }
    return parseFloat(lit);
  };
  const str = () => {
    i++; // "
    let out = "";
    while (text[i] !== '"') {
      if (text[i] === "\\") {
        const c = text[i + 1];
        if (c === "u") {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        out += {
          n: "\n",
          t: "\t",
          r: "\r",
          b: "\b",
          f: "\f",
          '"': '"',
          "\\": "\\",
          "/": "/",
        }[c];
        i += 2;
        continue;
      }
      out += text[i];
      i++;
    }
    i++;
    return out;
  };
  return value();
}

// 两侧树归一后逐值比对。产物侧的 int64 路径 ID 是十进制字符串，真值侧是 BigInt，按数值等判。
function diffTree(a, b, p, diffs) {
  const big = (v) =>
    typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : v;
  a = big(a);
  b = big(b);
  if (typeof a === "bigint" || typeof b === "bigint") {
    if (typeof a !== typeof b || a !== b) diffs.push(`${p}: ${a} != ${b}`);
    return;
  }
  if (typeof a === "number" && typeof b === "number") {
    if (Math.abs(a - b) > 1e-9) diffs.push(`${p}: ${a} != ${b}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      diffs.push(`${p}: 数组长度 ${a.length} != ${b.length}`);
      return;
    }
    a.forEach((v, idx) => diffTree(v, b[idx], `${p}[${idx}]`, diffs));
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a) || !(k in b)) diffs.push(`${p}.${k}: 单侧缺失`);
      else diffTree(a[k], b[k], `${p}.${k}`, diffs);
    }
    return;
  }
  if (a !== b) diffs.push(`${p}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}

function compareJson(id, name) {
  const jsText = fs.readFileSync(`.tmp/js-extract/${id}/${name}`, "utf8");
  const pyText = fs.readFileSync(
    `models/${id.split("_")[0]}/${id}/${name}`,
    "utf8",
  );
  const diffs = [];
  diffTree(parseJsonBig(jsText), parseJsonBig(pyText), name, diffs);
  check(
    `${id}: ${name} 深比对`,
    diffs.length === 0,
    diffs.slice(0, 4).join("; "),
  );
}

// ---------------------------------------------------------------- PNG 像素比对

// 像素级比对：维度全等；逐通道 |Δ|≤1（ASTC 解码器构建间已实测的最大漂移），出现 |Δ|≥2 即失败
function comparePng(id, name) {
  const jsPng = UPNG.decode(
    fs.readFileSync(`.tmp/js-extract/${id}/textures/${name}`),
  );
  const pyPng = UPNG.decode(
    fs.readFileSync(`models/${id.split("_")[0]}/${id}/textures/${name}`),
  );
  const { width: w, height: h } = pyPng;
  const dimsOk = jsPng.width === w && jsPng.height === h;
  check(
    `${id}: textures/${name} 尺寸`,
    dimsOk,
    `JS ${jsPng.width}x${jsPng.height} vs ${w}x${h}`,
  );
  if (!dimsOk) return;
  const n = w * h * 4;
  const a = jsPng.data.subarray(0, n);
  const b = pyPng.data.subarray(0, n);
  let maxd = 0;
  let beyond = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxd) maxd = d;
    if (d >= 2) beyond++;
  }
  check(
    `${id}: textures/${name} 像素（|Δ|≤1）`,
    beyond === 0,
    `最大|Δ|=${maxd}，越限 ${beyond} 字节`,
  );
}

// ---------------------------------------------------------------- 主流程

for (const { id, char } of runnable) {
  console.log(`\n== ${id} ==`);
  const r = spawnSync(
    process.execPath,
    ["scripts/extract.js", id, `.tmp/js-extract/${id}`],
    {
      encoding: "utf8",
    },
  );
  check(
    `${id}: extract.js 退出码 0`,
    r.status === 0,
    String(r.stderr).slice(0, 200),
  );
  const warns = (r.stdout ?? "")
    .split("\n")
    .filter((l) => l.startsWith("[warn] "))
    .map((l) => l.slice("[warn] ".length).trim());
  check(
    `${id}: 告警集合与真值基线全等`,
    JSON.stringify(warns) === JSON.stringify(EXPECTED_WARNS[id]),
    warns.join(" | "),
  );

  const jsDir = `.tmp/js-extract/${id}`;
  const pyDir = `models/${char}/${id}`;
  const jsFiles = listFiles(jsDir)
    .map((f) => f.slice(jsDir.length + 1))
    .sort();
  const pyFiles = listFiles(pyDir)
    .map((f) => f.slice(pyDir.length + 1))
    .sort();
  check(
    `${id}: 产物文件集合全等`,
    JSON.stringify(jsFiles) === JSON.stringify(pyFiles),
    `仅产物有[${jsFiles.filter((f) => !pyFiles.includes(f)).slice(0, 5)}] 仅真值缺[${pyFiles.filter((f) => !jsFiles.includes(f)).slice(0, 5)}]`,
  );

  // moc3 字节全等
  const jsMoc = fs.readFileSync(`${jsDir}/${id}.moc3`);
  const pyMoc = fs.readFileSync(`${pyDir}/${id}.moc3`);
  check(
    `${id}: moc3 字节全等`,
    jsMoc.equals(pyMoc),
    `${jsMoc.length} vs ${pyMoc.length}`,
  );

  // JSON 深比对
  for (const f of jsFiles) {
    if (f.endsWith(".json")) compareJson(id, f);
    if (f.startsWith("textures/")) comparePng(id, path.basename(f));
  }
}

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p.replaceAll("\\", "/"));
    }
  };
  walk(dir);
  return out;
}

finish();
