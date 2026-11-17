import { createApp } from 'vue'
import App from './App.vue'
import { loadCatalog, loadModels } from './utils/models'
import './style.css'

// 清单与目录都到位后再挂载，避免首帧空列表；失败也照常挂载（空清单 + 控制台报错）
Promise.all([loadModels(), loadCatalog()]).finally(() => createApp(App).mount('#app'))
