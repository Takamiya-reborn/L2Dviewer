/**
 * Ani（spine）皮肤挂载：pixi-spine 3.8 运行时加载烘焙产物
 * （<变体>.json + 同名 .atlas + atlas 引用的贴图 PNG，同目录约定由 spineBake.js 保证）。
 * 分层预制体（meta.parts 有序分区，如 aijier 的 B/M/T 三层共享坐标系叠出完整人形）
 * 时按序同时挂全部分区进 Container；单骨架预制体挂默认变体。
 * 起播元数据 startingAnimation（各分区 SkeletonGraphic 的 startingAnimation/startingLoop）。
 * Ani 类皮肤无交互状态机：ctx.runtime/orch/l2dOffset 保持 null，手势层按 ctx.model
 * 无 internalModel 旁路；ctx.model 存 Spine（或分区 Container）供卸载与缩放。
 */
import { Container, Loader } from "pixi.js";
import { Spine, SpineParser } from "@pixi-spine/all-3.8";

/** 游戏 SkeletonDataAsset 的解析 scale（0.01），把骨架坐标缩到游戏渲染尺度 */
const SKELETON_SCALE = 0.01;

/** 舞台取景留白：内容适配系数经 props.fill 传入（与 L2D 相同语义） */
function fitSpine(ctx) {
    const model = ctx.model;
    const app = ctx.app;
    if (!model || !app) return;
    // 按实际渲染包围盒取景：spine.json 的画布头是导出器估算值，与真实网格顶点范围
    // 存在整体 Y 镜像/偏移（spine-unity 的 UGUI y-down 约定），不可作取景依据。
    // 先归一 scale 再测 bounds（pixi 空间，已含 pixi-spine 的内部翻转），避免缩放反馈
    model.scale.set(1);
    const bounds = model.getBounds();
    if (!bounds.width || !bounds.height) return;
    const stageW = app.screen.width;
    const stageH = app.screen.height;
    // 取景微调（HUD 注入面板）与 camera.fitModel 同语义：zoom 乘系数、偏移按视口比例平移
    const scale =
      Math.min(stageW / bounds.width, stageH / bounds.height) *
      ctx.fill() *
      (ctx.userView?.zoom ?? 1);
    // 以内容包围盒中心为锚：bounds 是世界系，减掉当前位移还原本地中心。直接用世界中心会把
    // 旧位移乘进新缩放（世界中心 = 屏心 − 旧位移×新缩放），首次适配 position 归零后无感，
    // 重取景（缩放/窗口变化）时模型整体偏出屏外
    const cx = bounds.x + bounds.width / 2 - model.position.x;
    const cy = bounds.y + bounds.height / 2 - model.position.y;
    model.scale.set(scale);
    model.position.set(
      stageW / 2 - cx * scale + (ctx.userView?.offX ?? 0) * stageW,
      stageH / 2 - cy * scale + (ctx.userView?.offY ?? 0) * stageH,
    );
}

export async function mountSpineModel(ctx, url, variantOverride) {
    ctx._mounting = true;
    try {
        await mountSpineInner(ctx, url, variantOverride);
    } catch (err) {
        console.error("[spine] 模型挂载失败", err);
        ctx.status.value = `加载失败:${err?.message ?? err}`;
    } finally {
        ctx._mounting = false;
    }
}

async function mountSpineInner(ctx, url, variantOverride) {
    const seq = (ctx._mountSeq = (ctx._mountSeq ?? 0) + 1);
    const stale = () => seq !== ctx._mountSeq;
    const app = ctx.app;
    ctx.status.value = "加载模型…";
    ctx.hintsCtl.destroy();
    ctx.runtime = null;
    ctx.orch = null;
    ctx.l2dOffset = null;
    ctx._spineCanvas = null;

    // 元数据：分区表（parts，分层预制体组装序）与骨架变体表（spineBake.js 产物）
    const meta = await fetch(url).then((r) => {
        if (!r.ok) throw new Error(`spine 元数据 HTTP ${r.status}`);
        return r.json();
    });
    if (stale()) return;
    ctx._spineMeta = meta;
    ctx._spineUrl = url;
    const base = url.replace(/[^/]*$/, "");

    // pixi-spine 的 ESM 在 import 时自动把解析中间件注册进 Loader 全局插件表
    //（all-3.8.es.js 尾部的 registerLoaderPlugin），此处不再手动挂载——重复注册会让
    // 同一资源跑两遍中间件，第二次 add 同名 atlas 资源时抛 "already exists" 打断加载链
    const loadVariant = async (variant, resName) => {
        const skeletonUrl = base + variant.skeleton;
        const model = await new Promise((resolve, reject) => {
            const loader = new Loader();
            loader.add(resName, skeletonUrl, { metadata: { spineSkeletonScale: SKELETON_SCALE } });
            loader.load((loaderRef, resources) => {
                const res = resources[resName];
                if (!res?.spineData) return reject(new Error(res?.error?.message ?? "spine 资源解析失败"));
                resolve(new Spine(res.spineData));
            });
            loader.onError.add((err) => reject(err));
        });
        return model;
    };
    // 皮肤激活：prefab 的 initialSkinName（spine-unity 语义：空串 = 只挂 default 皮肤）。
    // 游戏资产里人物部件普遍放在非 default 皮肤（aluomangshi 的 '1'/'2' 是常规/誓约两套着装），
    // 空值且骨架有多套皮肤时回落第一套非 default，否则人物身体不可见；换皮肤须 setSlotsToSetupPose
    // 让各槽位按新皮肤表重解 setup 附件。
    const applySkin = (model, variant) => {
        const skins = model.spineData.skins;
        const name = variant.initialSkin;
        const skin = (name && model.spineData.findSkin(name)) ?? (skins.length > 1 ? skins[1] : null);
        if (skin) {
            model.skeleton.setSkin(skin);
            model.skeleton.setSlotsToSetupPose();
        }
    };
    // 起播：该分区 SkeletonGraphic 的 startingAnimation（缺省 'normal' 循环）
    const startPart = (model, variant) => {
        const startName = variant.startingAnimation ?? "normal";
        if (model.spineData.findAnimation(startName)) {
            model.state.setAnimation(0, startName, variant.startingLoop ?? true);
        } else if (model.spineData.animations.length) {
            model.state.setAnimation(0, model.spineData.animations[0].name, true);
        }
        return startName;
    };

    let model;
    let firstStart = "";
    if (Array.isArray(meta.parts) && meta.parts.length > 1) {
        // 分层预制体：按 parts 序同时挂全部分区叠出完整人形（各分区共享坐标系原点，
        // 起播动画各取 SkeletonGraphic 的 startingAnimation）
        model = new Container();
        for (const name of meta.parts) {
            const variant = meta.variants.find((v) => v.variant === name);
            if (!variant) continue;
            const part = await loadVariant(variant, name);
            if (stale()) {
                model.destroy({ children: true });
                return;
            }
            const bones = part.spineData.bones.length;
            model.addChild(part);
            part.autoUpdate = true;
            applySkin(part, variant);
            // 每层都按自身 startingAnimation 起播（state 各自独立），firstStart 只作状态栏报值
            const startName = startPart(part, variant);
            if (!firstStart) firstStart = startName;
        }
        ctx._spineCanvas = null;
    } else {
        const variant =
            meta.variants.find((v) => v.variant === variantOverride) ??
            meta.variants.find((v) => v.variant === meta.default) ??
            meta.variants[0];
        model = await loadVariant(variant, "spine");
        if (stale()) {
            model.destroy();
            return;
        }
        ctx._spineCanvas = variant.canvas ?? null;
        applySkin(model, variant);
        firstStart = startPart(model, variant);
    }

    // 换挂载时收走旧模型（L2D 的揭幕语义在此简化：spine 加载即上台）
    ctx.model?.destroy();
    ctx.model = model;
    app.stage.addChild(model);

    ctx.status.value = "";
    // 首次取景推迟一帧：pixi-spine 的 mesh 顶点缓冲在首次 update 前是全零数组，
    // 立即测 bounds 得到空盒会静默跳过取景
    requestAnimationFrame(() => {
        if (stale()) return;
        fitSpine(ctx);
    });
    ctx.currentMotion.value = firstStart;
    // 尺寸变化重取景：走 camera.fitModel 的 spine 分支（见 camera.js）
    ctx._spineFit = () => fitSpine(ctx);
    // 变体切换接口（舞台 play(group) 的 spine 分支走这里）；分层皮肤无变体可切，重挂即复位；
    // 上报触发组 = 变体名列表（状态触发面板按此渲染）
    ctx._spinePlay = (name) => mountSpineModel(ctx, url, name);
    ctx.emit(
        "motions",
        Array.isArray(meta.parts) && meta.parts.length > 1 ? [] : meta.variants.map((v) => v.variant),
    );
}
