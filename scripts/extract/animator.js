// AnimatorController 序列化数据解包：状态路由表（动作编号入口）与 AnyState 转场时长表。
// 数据只存在于 bundle 的 AnimatorController typetree，是"状态编号 -> 动作"的权威表。

// 解包 AnimatorController 的状态路由表（交互动作的播放入口）。
// 游戏不直接 Play 动画，而是 C# 控制器对 Animator SetInteger + SetTrigger，经 AnyState 转移进入目标状态。
// 转移条件只有三类参数：主 int（Equals）即"动作编号"；次 int 是 idle 变体号；触发器（If 条件）每次手势时置位。
// 状态里嵌的 OnFinishAnim(N) 事件即结束时 SetInteger(主 int, N)。
// 产物结构：
//     paramKinds: 条件参数哈希 -> "int"/"trigger"（mode 6=Equals, 1=If）
//     states:     [{name, actionId, subIndex, clip}]，clip=null 表示该皮肤未携带此动作
export function animatorRouting(ctrl, clipNames, warn) {
  const tos = Object.fromEntries(ctrl.m_TOS.map(([h, n]) => [h, n]));
  const clipRefs = ctrl.m_AnimationClips;

  const entries = []; // {name, conds, clip}
  for (const sm of ctrl.m_Controller.m_StateMachineArray) {
    const smd = sm.data ?? sm;
    // AnyState 转移与状态按下标对位（m_DestinationState 即状态数组下标）
    const anyTrans = new Map();
    for (const t of smd.m_AnyStateTransitionConstantArray ?? []) {
      anyTrans.set(t.data.m_DestinationState, t.data);
    }
    const stateArray = smd.m_StateConstantArray ?? [];
    for (let i = 0; i < stateArray.length; i++) {
      const sd = stateArray[i].data ?? stateArray[i];
      const name = (tos[sd.m_FullPathID] ?? `state${i}`).split(".").pop();
      const conds = [];
      const td = anyTrans.get(i);
      if (td) {
        for (const c of td.m_ConditionConstantArray ?? []) {
          conds.push([
            c.data.m_EventID,
            c.data.m_ConditionMode,
            c.data.m_EventThreshold,
          ]);
        }
      }
      let clip = null;
      for (const bti of sd.m_BlendTreeConstantIndexArray ?? []) {
        if (bti === null || bti < 0) continue;
        const bt = sd.m_BlendTreeConstantArray[bti].data;
        for (const node of bt.m_NodeArray ?? []) {
          const cid = node.data.m_ClipID;
          if (cid >= 0 && cid < clipRefs.length) {
            const pid = clipRefs[cid].m_PathID ?? 0;
            clip = clipNames.get(BigInt(pid)) ?? null; // 外部引用/空动作解析为 null
          }
        }
      }
      entries.push({ name, conds, clip });
    }
  }

  // 主 int = 出现在 Equals 条件里最多的参数（每个状态一条编号）；同数时取先出现者
  const intCount = new Map();
  const triggerHashes = new Set();
  for (const { conds } of entries) {
    for (const [h, mode] of conds) {
      if (mode === 6) intCount.set(h, (intCount.get(h) ?? 0) + 1);
      else if (mode === 1) triggerHashes.add(h);
    }
  }
  let mainHash = null;
  let bestCount = 0;
  for (const [h, c] of intCount) {
    if (mainHash === null || c > bestCount) {
      mainHash = h;
      bestCount = c;
    }
  }

  const states = [];
  for (const { name, conds, clip } of entries) {
    let actionId = null;
    let subIndex = null;
    for (const [h, mode, thr] of conds) {
      if (mode !== 6) continue;
      if (h === mainHash) actionId = Math.trunc(thr);
      else subIndex = Math.trunc(thr);
    }
    states.push({ name, actionId, subIndex, clip });
  }
  states.sort((a, b) => {
    const na = a.actionId === null ? 1 : 0;
    const nb = b.actionId === null ? 1 : 0;
    if (na !== nb) return na - nb;
    if ((a.actionId || 0) !== (b.actionId || 0))
      return (a.actionId || 0) - (b.actionId || 0);
    const sa = a.subIndex === null ? 1 : 0;
    const sb = b.subIndex === null ? 1 : 0;
    if (sa !== sb) return sa - sb;
    return (a.subIndex || 0) - (b.subIndex || 0);
  });
  const paramKinds = {};
  for (const h of new Set([...intCount.keys(), ...triggerHashes])) {
    paramKinds[String(h)] = triggerHashes.has(h) ? "trigger" : "int";
  }
  return { paramKinds, states };
}

// 解包 AnimatorController 的 AnyState 转场时长表（按 clip 名）。
// 每条 AnyState 转场自带过渡时长（m_TransitionDuration）——游戏内各动作过渡快慢不一的出处。
// m_HasFixedDuration=True 时为绝对秒；False 时为目标 clip 长度的归一化比例，仅 0 值出现，非零需要折秒，遇到则放弃该条并告警。
// 键取转场目标状态的 clip 名，blend tree 状态把全部节点的 clip 都记上；clip 引用跨 bundle 解析不到时退回状态名。
// 产物 fades.json：{"default": 众数秒, "transitions": {clip: 秒}}，default 供表外 clip 兜底。
export function animatorFades(ctrl, clipNames, warn) {
  const tos = Object.fromEntries(ctrl.m_TOS.map(([h, n]) => [h, n]));
  const clipRefs = ctrl.m_AnimationClips;

  const transitions = new Map();
  for (const sm of ctrl.m_Controller.m_StateMachineArray) {
    const smd = sm.data ?? sm;
    const arr = smd.m_StateConstantArray ?? [];
    const names = new Map();
    for (let i = 0; i < arr.length; i++) {
      names.set(
        i,
        (tos[(arr[i].data ?? arr[i]).m_FullPathID] ?? `state${i}`)
          .split(".")
          .pop(),
      );
    }
    // 状态 -> 本状态 blend tree 全部节点的 clip 名
    const clips = new Map();
    for (let i = 0; i < arr.length; i++) {
      const sd = arr[i].data ?? arr[i];
      for (const bti of sd.m_BlendTreeConstantIndexArray ?? []) {
        if (bti === null || bti < 0) continue;
        const bt = sd.m_BlendTreeConstantArray[bti].data;
        for (const node of bt.m_NodeArray ?? []) {
          const cid = node.data.m_ClipID;
          if (cid >= 0 && cid < clipRefs.length) {
            const name = clipNames.get(BigInt(clipRefs[cid].m_PathID ?? 0));
            if (name) {
              if (!clips.has(i)) clips.set(i, []);
              clips.get(i).push(name);
            }
          }
        }
      }
    }

    for (const t of smd.m_AnyStateTransitionConstantArray ?? []) {
      const d = t.data;
      const duration = d.m_TransitionDuration;
      if (duration === undefined) continue;
      if (!d.m_HasFixedDuration && duration !== 0) {
        warn(`fixed=False 且非零的转场时长 ${duration}，无法折秒，跳过`);
        continue;
      }
      const dst = d.m_DestinationState;
      for (const key of clips.get(dst) ?? [names.get(dst)]) {
        if (!key) continue;
        const prev = transitions.get(key);
        if (prev !== undefined && prev !== duration) {
          warn(`${key}: ${prev}s 与 ${duration}s 冲突，保留先值`);
          continue;
        }
        transitions.set(key, duration);
      }
    }
  }

  if (!transitions.size) return null;
  const counts = new Map();
  for (const sec of transitions.values()) {
    counts.set(sec, (counts.get(sec) ?? 0) + 1);
  }
  let def = null;
  let defCount = 0;
  for (const [sec, c] of counts) {
    if (def === null || c > defCount) {
      def = sec;
      defCount = c;
    }
  }
  const sorted = {};
  for (const key of [...transitions.keys()].sort())
    sorted[key] = transitions.get(key);
  return { default: def, transitions: sorted };
}
