// unityfs-js 适配层：bundle 载入、typetree 读取（含缓存）、对象枚举与按 pathID 索引。
// typetree 字段名与 Unity 序列化一致（m_*）；int64 路径 ID 在 JSON 里是十进制字符串，统一转 BigInt。

import { readFileSync } from "node:fs";
import { load } from "unityfs-js";

// typetree 里 SInt64 PPtr 目标是十进制字符串（小值是 number），统一转 BigInt 以与 ObjectInfo.pathID 同域
export function pathID(v) {
  return typeof v === "bigint"
    ? v
    : typeof v === "string"
      ? BigInt(v)
      : BigInt(Math.trunc(v));
}

export class Bundle {
  constructor(manager) {
    this.manager = manager;
    this.infos = manager.getObjectInfos();
    this.trees = new Map(); // ObjectInfo -> typetree JSON 对象（含缓存，避免重复解析大对象）
    this._byPathID = new Map(this.infos.map((info) => [info.pathID, info]));
    this._byClass = new Map();
    for (const info of this.infos) {
      if (!this._byClass.has(info.className))
        this._byClass.set(info.className, []);
      this._byClass.get(info.className).push(info);
    }
  }

  // read_typetree 等价：按 bundle 内嵌 typetree 反序列化为平面对象
  readTypetree(info) {
    if (this.trees.has(info)) return this.trees.get(info);
    const tree = info.assetFile.getObjectUsingTreeJSON(info);
    this.trees.set(info, tree);
    return tree;
  }

  byClass(className) {
    return this._byClass.get(className) ?? [];
  }

  byPathID(pathID) {
    return this._byPathID.get(pathID) ?? null;
  }
}

export async function loadBundle(path) {
  // new Uint8Array(buffer) 拷出精确大小的 ArrayBuffer：readFileSync 的小文件走 8KB Buffer 池，
  // 直接传 Buffer 时 unityfs-js 取 source.buffer 会带上池内偏移，解析出 undefined
  const manager = await load(new Uint8Array(readFileSync(path)));
  return new Bundle(manager);
}

// 游戏对象路径 CRC32 哈希 -> 名称映射，与脚本类名表。
// 返回 { scripts: Map<pathID, className>, pathHash: Map<crc, path>, infos: Map<trPathID, {name, full, goPathID}> }
export function resolveHashBindings(bundle, crc32Fn) {
  const scripts = new Map();
  for (const info of bundle.byClass("MonoScript")) {
    scripts.set(info.pathID, bundle.readTypetree(info).m_ClassName);
  }
  const { infos } = buildHierarchy(bundle);
  const pathHash = new Map();
  for (const { name, full } of infos.values()) {
    // 绑定路径相对 Animator 根, 通常不含根对象名；大小写变体一并入表（hash 侧不做大小写归一）
    if (full.includes("/")) {
      const rel = full.slice(full.indexOf("/") + 1);
      pathHash.set(crc32Fn(rel), rel);
      pathHash.set(crc32Fn(rel.toLowerCase()), rel);
    }
    pathHash.set(crc32Fn(full), full);
    pathHash.set(crc32Fn(full.toLowerCase()), full);
    pathHash.set(crc32Fn(name), name);
    pathHash.set(crc32Fn(name.toLowerCase()), name);
  }
  return { scripts, pathHash, infos };
}

// Transform 层级 -> 对象路径表。返回 { infos: Map<trPathID, {name, full, goPathID}>, roots: [trPathID] }；
// path_from_root 含根名，形如 root/Parameters/ParamAngleX。
export function buildHierarchy(bundle) {
  const goByPid = new Map();
  const trByPid = new Map();
  for (const info of bundle.byClass("GameObject"))
    goByPid.set(info.pathID, bundle.readTypetree(info));
  for (const info of bundle.byClass("Transform"))
    trByPid.set(info.pathID, bundle.readTypetree(info));

  const infos = new Map();
  const roots = [];
  for (const [trPid, tr] of trByPid) {
    const father = pathID(tr.m_Father.m_PathID);
    if (!trByPid.has(father)) roots.push(trPid);
  }

  const visit = (trPid, path) => {
    const tr = trByPid.get(trPid);
    const goPid = pathID(tr.m_GameObject.m_PathID);
    const go = goByPid.get(goPid);
    const name = go.m_Name;
    const full = path ? `${path}/${name}` : name;
    infos.set(trPid, { name, full, goPathID: goPid });
    for (const child of tr.m_Children ?? []) {
      const cpid = pathID(child.m_PathID);
      if (trByPid.has(cpid)) visit(cpid, full);
    }
  };
  for (const r of roots) visit(r, "");
  return { infos, roots };
}
