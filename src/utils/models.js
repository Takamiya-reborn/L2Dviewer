/**
 * 模型清单由 vite.config.js 的 modelsManifest 插件在启动/构建时扫描
 * public/models 生成，无需手工维护；新增皮肤重启 dev 即可生效。
 * id    -> 唯一标识（用于标签选中态）
 * name  -> 侧栏标签显示名
 * url   -> model3.json 路径（public 目录下）
 */
export { MODELS } from 'virtual:models'

/**
 * 动作组显示名，对齐游戏内起居栏 L2D 界面的叫法；未收录的组在面板里
 */
export const TRIGGER_LABELS = {
  login: '登录',
  main_1: '主界面1',
  main_2: '主界面2',
  main_3: '主界面3',
  main_4: '主界面4',
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
