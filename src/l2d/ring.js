/**
 * 誓约戒指控制层：游戏 live2d.lua 在 init/updateShip 把 Paramring 登记进 liveCom 的
 * 覆盖层（C# AddParameterValue/removeParameterValue 配对注册，每帧在动作求值后重放），
 * 皮肤内无名指戒指贴图的 keyform 由它点亮。动作把 Paramring 键成常量 0 的烘焙副本
 * （导出时 propose=false 的快照，全模型每支动作一致），覆盖层逐帧赢过它——与 effect 组
 * 常驻氛围层同机制。
 * 查看器没有存档侧的 propose，改为外置开关：afterMotionUpdate（动作求值后、
 * saveParameters 前）逐帧写开关值，与游戏覆盖层同位赢过动作副本。
 */
export const RING_PARAM = "Paramring";

/** @param {() => boolean} state 开关状态读取器（L2dStage 的响应式 ref） */
export function createOathRing(state) {
  let attachedModel = null;
  return {
    /** 换挂载时登记逐帧落笔钩子（逐模型一次），开关值每帧读 state */
    attach(model) {
      if (attachedModel === model) return;
      attachedModel = model;
      const core = model.internalModel.coreModel;
      const idx = core.getParameterIndex(RING_PARAM);
      const has = idx >= 0 && idx < core.getParameterCount();
      if (!has)
        console.warn(`[l2d] ${RING_PARAM}: 该皮肤没有此参数,誓约开关不生效`);
      model.internalModel.on("afterMotionUpdate", () => {
        if (has) core.setParameterValueByIndex(idx, state() ? 1 : 0);
      });
    },
  };
}
