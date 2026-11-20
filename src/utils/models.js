import { reactive } from "vue";

/**
 * 皮肤清单（reactive 数组，视图直接可用）。
 * 由 dev server 每次请求实时扫描仓库根目录 models/ 生成（vite.config.js 的 serveModels 中间件），main.js 挂载前经 loadModels() 拉取填充。
 * 新增皮肤：目录丢进 models/ 后刷新页面即生效，无需重启 dev。
 *
 * id    -> 唯一标识（用于标签选中态）
 * name  -> 侧栏标签显示名
 * url   -> model3.json 路径（dev server 把 /models/* 映射到根目录 models/）
 */
export const MODELS = reactive([]);

/** 拉取皮肤清单（替换语义，重复调用幂等）；失败时仅报错，视图以空清单渲染。 */
export async function loadModels() {
  try {
    const r = await fetch("/models/manifest.json");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    MODELS.splice(0, MODELS.length, ...(await r.json()));
  } catch (err) {
    console.error(
      "皮肤清单加载失败：请确认 models/ 下存在 <角色>/<皮肤>/<皮肤>.model3.json",
      err,
    );
  }
}

/**
 * 全量皮肤目录（gen_catalog.js 生成的显示名 -> bundle 名映射，覆盖 models/ 里
 * 尚未烘焙的皮肤）。entries 元素 { painting, name, camp?, ani?, l2d?, altPaintings?, state }，
 * ani/l2d 标记资源形态，altPaintings 是同名合并条目的其余形态 bundle 名（形态开关用）；
 * state 是 dev server 合并的资源状态：baked=已烘焙可加载 / cached=bundle 已拉未烘焙 / remote=需拉取；
 * painting 与烘焙清单的 id 同名，可直接作 activeId。
 */
export const CATALOG = reactive({ version: "", entries: [] });

/** 拉取皮肤目录（dev server /api/catalog 在静态目录上合并实时资源状态）；失败仅报错，侧栏回退为只显示已烘焙清单。 */
export async function loadCatalog() {
  try {
    const r = await fetch("/api/catalog");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    CATALOG.version = data.version ?? "";
    CATALOG.entries = data.entries ?? [];
  } catch (err) {
    console.error("皮肤目录加载失败：侧栏将只显示已烘焙的皮肤", err);
  }
}

/**
 * 阵营显示名，对齐游戏内皮肤筛选的叫法（键 = ship_data_statistics 的 nationality）。
 * 晶环联盟的码暂未出现在任何数据中，出现前归入"其他"。
 */
export const CAMP_LABELS = {
  1: "白鹰",
  2: "皇家",
  3: "重樱",
  4: "铁血",
  5: "东煌",
  6: "撒丁帝国",
  7: "北方联合",
  8: "自由鸢尾",
  9: "维希教廷",
  11: "郁金王国",
  96: "飓风",
  97: "META",
};

/** 阵营 chips 的展示顺序（对齐游戏内阵营筛选），未收录的码按出现序补在"其他"前 */
export const CAMP_ORDER = [
  "白鹰",
  "皇家",
  "重樱",
  "铁血",
  "东煌",
  "撒丁帝国",
  "北方联合",
  "自由鸢尾",
  "维希教廷",
  "郁金王国",
  "晶环联盟",
  "META",
  "飓风",
  "其他",
];

/** 目录条目的阵营 -> 显示名；联动/杂项 nationality（98/99/101~118 等）归"其他" */
export function campLabel(camp) {
  return CAMP_LABELS[camp] ?? "其他";
}

/**
 * 动作组显示名。起居栏组对齐游戏内 L2D 界面的叫法；其余场景的组（战斗秘书、
 * 商店猫、形态切换）游戏内不出现在任何列表 UI，这里按事件语义给查看器侧的
 * 显示名；未收录的组在面板里直接显示组名。
 */
export const TRIGGER_LABELS = {
  login: "登录",
  main_1: "主界面1",
  main_2: "主界面2",
  main_3: "主界面3",
  main_4: "主界面4",
  main_5: "主界面5",
  touch_body: "普通触摸",
  touch_special: "特殊触摸",
  touch_head: "摸头",
  touch_idle: "闲置触摸",
  touch_drag: "拖拽触摸",
  mission: "任务提醒",
  mission_complete: "任务完成",
  mail: "邮件提醒",
  home: "回港",
  home_hx: "回港（和谐）",
  wedding: "誓约",
  complete: "委托完成",
  change_in: "形态切换·进入",
  change_out: "形态切换·退出",
  idle: "待机",
  effect: "氛围特效",
  battle: "战斗",
  win_mvp: "胜利MVP",
  lose: "战败",
  skill: "技能",
  hp_warning: "大破警告",
  upgrade: "升级",
  unlock: "解锁",
  feeling1: "心情1",
  feeling2: "心情2",
  feeling3: "心情3",
  feeling4: "心情4",
  feeling5: "心情5",
  detail: "详情",
  diamond: "钻石",
  gold: "物资",
  oil: "石油",
};

/**
 * 状态触发面板的展示顺序。起居栏段与游戏内 L2D 界面一致；touch_idle/touch_drag
 * 跟在触摸家族后面，其余段按场景排（形态切换 → 待机/氛围 → 战斗秘书 → 商店猫）。
 * 未收录的组排在末尾，保持 model3.json 里的相对顺序。
 */
export const TRIGGER_ORDER = [
  "login",
  "main_1",
  "main_2",
  "main_3",
  "main_4",
  "main_5",
  "touch_body",
  "touch_special",
  "touch_head",
  "touch_idle",
  "touch_drag",
  "mission",
  "mission_complete",
  "mail",
  "home",
  "home_hx",
  "wedding",
  "complete",
  "change_in",
  "change_out",
  "idle",
  "effect",
  "battle",
  "win_mvp",
  "lose",
  "skill",
  "hp_warning",
  "upgrade",
  "unlock",
  "feeling1",
  "feeling2",
  "feeling3",
  "feeling4",
  "feeling5",
  "detail",
  "diamond",
  "gold",
  "oil",
];
