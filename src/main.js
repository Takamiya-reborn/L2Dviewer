import { createApp } from 'vue'
import App from './App.vue'
import { loadModels } from './utils/models'
import './style.css'

// 清单到位后再挂载，避免首帧空列表；失败也照常挂载（空清单 + 控制台报错）
loadModels().finally(() => createApp(App).mount('#app'))
