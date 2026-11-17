// physics3.json 归一化注入：包内 TextAsset 缺 Input.Normalization，游戏运行时读 CubismPhysicsController._rig，
// 按 _rig.SubRigs[i].Normalization 逐条注入补齐（两份数据其余字段逐项一致）。

// 把 _rig 的 Normalization（Position/Angle 的 Minimum/Maximum/Default）注入 physics3.json 文本。
// 缺失会让框架的输入归一化取 undefined、物理输出全趴。
// 两边设置数不齐或任一条缺 Normalization 时放弃注入落原文，不落半成品。
export function injectPhysicsNormalization(text, rig, warn) {
    let data
    try {
        data = JSON.parse(text)
    } catch {
        return text
    }
    const subs = rig.SubRigs ?? []
    const settings = data.PhysicsSettings
    if (!Array.isArray(settings) || !Array.isArray(subs) || settings.length !== subs.length) {
        warn(
            `physics3 与 _rig 设置数不齐(${Array.isArray(settings) ? settings.length : '?'}/${subs.length})，跳过 Normalization 注入`,
        )
        return text
    }
    for (let i = 0; i < settings.length; i++) {
        const setting = settings[i]
        const sub = subs[i]
        const norm = sub.Normalization
        if (!norm || typeof norm !== 'object' || !('Position' in norm) || !('Angle' in norm)) {
            warn(`_rig 设置 ${sub.Name} 缺 Normalization，放弃注入落原文`)
            return text
        }
        setting.Normalization = norm
    }
    return JSON.stringify(data)
}
