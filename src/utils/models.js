import { reactive } from 'vue'

/**
 * 皮肤清单由 dev server 每次请求实时扫描仓库根目录 models/ 生成
 * （vite.config.js 的 serveModels 中间件），main.js 挂载前经 loadModels()
 * 拉取填充（reactive 数组，视图直接可用）。
 * 新增皮肤：目录丢进 models/ 后刷新页面即生效，无需重启 dev。
 * id    -> 唯一标识（用于标签选中态）
 * name  -> 侧栏标签显示名
 * url   -> model3.json 路径（dev server 把 /models/* 映射到根目录 models/）
 */
export const MODELS = reactive([])

/** 拉取皮肤清单；失败时仅报错，视图以空清单渲染。 */
export async function loadModels() {
  try {
    const r = await fetch('/models/manifest.json')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    MODELS.push(...(await r.json()))
  } catch (err) {
    console.error('皮肤清单加载失败：请确认 models/ 下存在 <角色>/<皮肤>/<皮肤>.model3.json', err)
  }
}

/**
 * 动作组显示名，对齐游戏内起居栏 L2D 界面的叫法；未收录的组在面板里
 */
export const TRIGGER_LABELS = {
  login: '登录',
  main_1: '主界面1',
  main_2: '主界面2',
  main_3: '主界面3',
  main_4: '主界面4',
  main_5: '主界面5',
  touch_body: '普通触摸',
  touch_special: '特殊触摸',
  touch_head: '摸头',
  mission: '任务提醒',
  mission_complete: '任务完成',
  mail: '邮件提醒',
  home: '回港',
  wedding: '誓约',
  complete: '委托完成',
}

/**
 * 状态触发面板的展示顺序，与游戏内 L2D 界面一致：
 * 登录 → 主界面1~4 → 普通触摸/特殊触摸/摸头 → 任务提醒/任务完成 →
 * 邮件提醒 → 回港 → 誓约 → 委托完成。
 * 未收录的组排在末尾，保持 model3.json 里的相对顺序。
 */
export const TRIGGER_ORDER = [
  'login',
  'main_1',
  'main_2',
  'main_3',
  'main_4',
  'main_5',
  'touch_body',
  'touch_special',
  'touch_head',
  'mission',
  'mission_complete',
  'mail',
  'home',
  'wedding',
  'complete',
]
