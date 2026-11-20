// Ani（spine）皮肤烘焙：spinepainting/<painting> 主 bundle（SkeletonGraphic 预制体）
// + <painting>_res（SkeletonDataAsset / SpineAtlasAsset / .skel / .atlas / Texture2D）
// -> models/<角色>/<皮肤>/ 下的 <皮肤>.spine.json 元数据 + 各骨架变体 <变体>.json
//（spine 3.8 JSON，spineSkel.toSpine38Json 转换）+ <变体>.atlas + 贴图 PNG。
//
// 注意：.skel/.atlas 的 TextAsset 必须经 info.object.data 取原始字节，
// typetree 的 m_Script 经 UTF-8 解码已毁二进制段（详见 spineSkel.js 头注）。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadBundle } from "./bundle.js";
import { isAstcFormat, decodeAstcTexture } from "./texture.js";
import { parseSkel, toSpine38Json } from "./spineSkel.js";

const progress = (pct, label) => console.log(`[progress] ${pct} ${label}`);

/** 主 bundle 是否 spine（MonoScript 表里有 SkeletonGraphic 而非 Cubism 全家桶）。 */
export function isSpineBundle(bundle) {
    return bundle
        .byClass("MonoScript")
        .some((i) => bundle.readTypetree(i).m_ClassName === "SkeletonGraphic");
}

/** 解析主 bundle 预制体的分区组装：根 GameObject 的 Transform 子层级按序挂多个
 * SkeletonGraphic（各自独立骨架、同一坐标系原点、各自 startingAnimation），
 * 游戏按子节点次序叠出完整人形。返回有序分区表；无分层结构的预制体返回 null。 */
function resolveComposition(mainBundle) {
    const graphics = [];
    for (const info of mainBundle.byClass("MonoBehaviour")) {
        const tree = mainBundle.readTypetree(info);
        if (tree.skeletonDataAsset) {
            graphics.push({ go: String(tree.m_GameObject?.m_PathID), tree });
        }
    }
    if (!graphics.length) return null;
    // 根 = prefabItem 容器所属 GameObject；子序 = 其 RectTransform.m_Children
    let rootPid = null;
    for (const info of mainBundle.byClass("MonoBehaviour")) {
        const tree = mainBundle.readTypetree(info);
        if (Array.isArray(tree.prefabItem) && tree.prefabItem.length) {
            rootPid = String(tree.m_GameObject?.m_PathID);
            break;
        }
    }
    if (!rootPid) return null;
    let childPids = [];
    // 子节点引用是子 Transform（RectTransform）的 pathID，要经 transform -> GameObject 映射回 GO
    const goByTransform = new Map();
    for (const info of mainBundle.byClass("RectTransform")) {
        const tree = mainBundle.readTypetree(info);
        if (String(tree.m_GameObject?.m_PathID) === rootPid) {
            childPids = (tree.m_Children ?? []).map((c) => String(c.m_PathID));
        }
        goByTransform.set(String(info.pathID), String(tree.m_GameObject?.m_PathID));
    }
    if (!childPids.length) return null;
    const parts = [];
    for (const pid of childPids) {
        const go = goByTransform.get(pid);
        const g = graphics.find((x) => x.go === go);
        if (g) {
            parts.push({
                skeletonDataPathId: g.tree.skeletonDataAsset.m_PathID,
                startingAnimation: g.tree.startingAnimation || null,
                startingLoop: g.tree.startingLoop === 1,
                initialSkin: g.tree.initialSkinName || null,
            });
        }
    }
    return parts.length ? parts : null;
}

/** 单骨架预制体的回退路由：prefabItem[0] -> SkeletonGraphic -> skeletonDataAsset。 */
function resolveDefaultVariant(mainBundle) {
    const graphics = [];
    for (const info of mainBundle.byClass("MonoBehaviour")) {
        const tree = mainBundle.readTypetree(info);
        if (tree.skeletonDataAsset) graphics.push(tree);
    }
    if (!graphics.length) return null;
    // prefabItem[0] 的 GameObject 挂着默认展示变体的 SkeletonGraphic
    let goPathId = null;
    for (const info of mainBundle.byClass("MonoBehaviour")) {
        const tree = mainBundle.readTypetree(info);
        if (Array.isArray(tree.prefabItem) && tree.prefabItem.length) {
            goPathId = tree.prefabItem[0].m_PathID;
            break;
        }
    }
    const chosen = goPathId
        ? graphics.find((g) => g.m_GameObject?.m_PathID === goPathId) ?? graphics[0]
        : graphics[0];
    return {
        skeletonDataPathId: chosen.skeletonDataAsset.m_PathID,
        startingAnimation: chosen.startingAnimation || null,
        startingLoop: chosen.startingLoop === 1,
        initialSkin: chosen.initialSkinName || null,
        scale: null,
    };
}

/**
 * 烘焙 spine 皮肤到 outDir。mainBundle 是主 bundle（已加载），resPath 是 <painting>_res bundle 路径。
 * 返回 spine.json 元数据对象。
 */
export async function bakeSpine(outDir, modelId, mainBundle, resPath, displayName) {
    mkdirSync(outDir, { recursive: true });
    const res = await loadBundle(resPath);

    // --- 变体表：res 内全部 SkeletonDataAsset，skeletonJSON -> TextAsset(.skel)、atlasAssets -> .atlas
    const resTrees = new Map();
    for (const info of res.byClass("MonoBehaviour")) {
        resTrees.set(info.pathID, res.readTypetree(info));
    }
    const textAssets = new Map(); // path_id -> { pathId, name, data }
    for (const info of res.byClass("TextAsset")) {
        textAssets.set(info.pathID, { pathId: String(info.pathID), name: info.name, data: info.object.data });
    }
    const monoByPath = (pathId) => resTrees.get(pathId);
    const textByName = (name) => {
        for (const [, v] of textAssets) if (v.name === name) return v;
        return null;
    };

    // 分区组装优先；单骨架预制体回退单分区路由
    const composition = resolveComposition(mainBundle) ?? (() => {
        const route = resolveDefaultVariant(mainBundle);
        return route ? [route] : null;
    })();
    const variants = [];
    for (const info of res.byClass("MonoBehaviour")) {
        const tree = resTrees.get(info.pathID);
        if (!Array.isArray(tree.atlasAssets)) continue; // SkeletonDataAsset 才有该字段
        const skeletonName = tree.m_Name ?? "";
        const variant = skeletonName.replace(/_SkeletonData$/, "");
        const skel = textAssets.get(BigInt(tree.skeletonJSON.m_PathID));
        if (!skel) {
            console.warn(`[warn] ${variant}: skeletonJSON 引用落空，跳过`);
            continue;
        }
        const atlasRef = tree.atlasAssets[0];
        const atlasTree = atlasRef ? monoByPath(BigInt(atlasRef.m_PathID)) : null;
        // SpineAtlasAsset.atlasFile 指向 _res 内的 .atlas TextAsset（不是 MonoBehaviour）
        const atlasText = atlasTree ? textAssets.get(BigInt(atlasTree.atlasFile.m_PathID)) ?? null : null;
        // 分区身份与起播元数据来自该骨架自己的 SkeletonGraphic（每个分区各有一份）
        const partIndex = composition
            ? composition.findIndex((p) => BigInt(p.skeletonDataPathId) === info.pathID)
            : -1;
        const route = partIndex >= 0 ? composition[partIndex] : null;
        variants.push({
            variant,
            skeleton: skel.name,
            atlas: atlasText?.name ?? null,
            atlasPathId: atlasText ? atlasText.pathId : null,
            startingAnimation: route?.startingAnimation ?? null,
            startingLoop: route?.startingLoop ?? null,
            initialSkin: route?.initialSkin ?? null,
            default: partIndex === 0,
            __partIndex: partIndex,
        });
    }
    if (!variants.length) throw new Error(`未找到 SkeletonDataAsset（${resPath}）`);

    // --- 骨架解析 + spine 3.8 JSON 落盘（原始 .skel 一并归档，字节与包内 TextAsset 一致）
    let canvas = null;
    for (const [index, v] of variants.entries()) {
        const raw = textByName(v.skeleton)?.data;
        if (!raw) throw new Error(`骨架文件缺失: ${v.skeleton}`);
        const parsed = parseSkel(Buffer.from(raw));
        v.canvas = { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height };
        if (v.default || !canvas) canvas = v.canvas;
        v.skeleton = `${v.variant}.json`;
        v.raw = `${v.variant}.skel`;
        writeFileSync(join(outDir, v.skeleton), JSON.stringify(toSpine38Json(parsed)));
        writeFileSync(join(outDir, v.raw), Buffer.from(raw));
        progress(10 + Math.round((30 * (index + 1)) / variants.length), `骨架 ${v.variant}`);
    }

    // --- atlas 文本落盘（.atlas 引用页名，贴图按原始名落盘即直接对上）
    for (const v of variants) {
        if (!v.atlas) throw new Error(`变体 ${v.variant} 的 atlas 引用落空`);
        const atlasText = textAssets.get(BigInt(v.atlasPathId));
        writeFileSync(join(outDir, v.atlas), Buffer.from(atlasText.data));
    }
    for (const v of variants) delete v.atlasPathId;
    const textures = res.byClass("Texture2D");
    for (const [index, info] of textures.entries()) {
        const tex = info.object;
        // spine atlas 文件是标准 spine 约定（y 自顶部），spine-unity 在内部做 UV 转换适配
        // Unity 自底向上的纹理行序；pixi-spine 无此转换，须落标准 top-down PNG。
        // ASTC 路径默认翻转，非 ASTC 路径 exportFile 内部同样翻转，两路径行序一致
        const png = isAstcFormat(tex.textureFormat)
            ? (await decodeAstcTexture(tex, res.manager)).png
            : Buffer.from(
                (await res.manager.exportFile(info, { type: "uint8Array" })).data.raw,
            );
        writeFileSync(join(outDir, `${info.name}.png`), png);
        progress(40 + Math.round((40 * (index + 1)) / textures.length), `贴图 ${index + 1}/${textures.length}`);
    }

    progress(90, "写元数据");
    const meta = {
        type: "spine",
        painting: modelId,
        name: displayName || modelId,
        default: variants.find((v) => v.default)?.variant ?? variants[0].variant,
        variants,
    };
    if (composition) {
        // 有序分区表：挂载层按此序同时挂全部分区叠出完整人形（分层预制体语义）
        meta.parts = variants
            .filter((v) => v.__partIndex >= 0)
            .sort((a, b) => a.__partIndex - b.__partIndex)
            .map((v) => v.variant);
        for (const v of variants) delete v.__partIndex;
    }
    writeFileSync(join(outDir, `${modelId}.spine.json`), JSON.stringify(meta, null, 2));
    return meta;
}

/** spine 皮肤目录守卫：模型目录是否已含 spine 元数据（供扫描/清理判断）。 */
export function hasSpineMeta(dir, modelId) {
    return existsSync(join(dir, `${modelId}.spine.json`));
}
